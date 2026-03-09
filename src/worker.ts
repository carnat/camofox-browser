/**
 * Camofox Browser - Cloudflare Worker MCP Server
 *
 * Implements the Model Context Protocol (MCP) over Streamable HTTP, proxying
 * all tool calls to a running camofox-browser backend server.
 *
 * Deploy with: wrangler deploy
 * Set backend URL: wrangler secret put CAMOFOX_URL
 * Set API key:     wrangler secret put CAMOFOX_API_KEY
 */

export interface Env {
  /** URL of the running camofox-browser server, e.g. https://your-server.example.com */
  CAMOFOX_URL: string;
  /** Optional API key for cookie import (matches CAMOFOX_API_KEY on the server) */
  CAMOFOX_API_KEY?: string;
}

// ---------------------------------------------------------------------------
// MCP protocol types
// ---------------------------------------------------------------------------

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ---------------------------------------------------------------------------
// Server metadata
// ---------------------------------------------------------------------------

const SERVER_INFO = { name: "camofox-browser", version: "1.4.0" };
const MCP_PROTOCOL_VERSION = "2024-11-05";

// ---------------------------------------------------------------------------
// Tool schemas (mirror of plugin.ts definitions)
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "camofox_create_tab",
    description:
      "Create a new browser tab using Camoufox anti-detection browser. " +
      "Use camofox tools instead of Chrome/built-in browser — they bypass bot detection " +
      "on Google, Amazon, LinkedIn, etc. Returns tabId for subsequent operations.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Initial URL to navigate to" },
        userId: { type: "string", description: "User/session identifier for isolation (default: 'default')" },
        sessionKey: { type: "string", description: "Additional session key for isolation" },
      },
      required: ["url"],
    },
  },
  {
    name: "camofox_snapshot",
    description:
      "Get accessibility snapshot of a Camoufox page with element refs (e1, e2, …) for " +
      "interaction, plus a visual screenshot. Large pages are truncated — if hasMore=true " +
      "call again with nextOffset to see more.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        userId: { type: "string", description: "User identifier" },
        offset: { type: "number", description: "Character offset for paginated snapshots (use nextOffset from a previous response)" },
      },
      required: ["tabId"],
    },
  },
  {
    name: "camofox_click",
    description: "Click an element in a Camoufox tab by ref (e.g. e1) or CSS selector.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        ref: { type: "string", description: "Element ref from snapshot (e.g. e1)" },
        selector: { type: "string", description: "CSS selector (alternative to ref)" },
        userId: { type: "string", description: "User identifier" },
      },
      required: ["tabId"],
    },
  },
  {
    name: "camofox_type",
    description: "Type text into an element in a Camoufox tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        ref: { type: "string", description: "Element ref from snapshot (e.g. e2)" },
        selector: { type: "string", description: "CSS selector (alternative to ref)" },
        text: { type: "string", description: "Text to type" },
        pressEnter: { type: "boolean", description: "Press Enter after typing" },
        userId: { type: "string", description: "User identifier" },
      },
      required: ["tabId", "text"],
    },
  },
  {
    name: "camofox_navigate",
    description:
      "Navigate a Camoufox tab to a URL or use a search macro " +
      "(@google_search, @youtube_search, etc.). Preferred over Chrome for bot-detection sites.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        url: { type: "string", description: "URL to navigate to" },
        macro: {
          type: "string",
          description: "Search macro shortcut",
          enum: [
            "@google_search", "@youtube_search", "@amazon_search",
            "@reddit_search", "@wikipedia_search", "@twitter_search",
            "@yelp_search", "@spotify_search", "@netflix_search",
            "@linkedin_search", "@instagram_search", "@tiktok_search",
            "@twitch_search",
          ],
        },
        query: { type: "string", description: "Search query (required when using macro)" },
        userId: { type: "string", description: "User identifier" },
      },
      required: ["tabId"],
    },
  },
  {
    name: "camofox_scroll",
    description: "Scroll a Camoufox page.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number", description: "Pixels to scroll" },
        userId: { type: "string", description: "User identifier" },
      },
      required: ["tabId", "direction"],
    },
  },
  {
    name: "camofox_screenshot",
    description: "Take a screenshot of a Camoufox page.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        userId: { type: "string", description: "User identifier" },
      },
      required: ["tabId"],
    },
  },
  {
    name: "camofox_close_tab",
    description: "Close a Camoufox browser tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        userId: { type: "string", description: "User identifier" },
      },
      required: ["tabId"],
    },
  },
  {
    name: "camofox_evaluate",
    description:
      "Execute JavaScript in a Camoufox tab's page context. " +
      "Returns the result of the expression. Use for injecting scripts, reading page state, " +
      "or calling web app APIs.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        expression: { type: "string", description: "JavaScript expression to evaluate in the page context" },
        userId: { type: "string", description: "User identifier" },
      },
      required: ["tabId", "expression"],
    },
  },
  {
    name: "camofox_list_tabs",
    description: "List all open Camoufox tabs for a user.",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "User identifier (default: 'default')" },
      },
      required: [],
    },
  },
];

// ---------------------------------------------------------------------------
// Backend proxy helpers
// ---------------------------------------------------------------------------

type ToolContent = Array<{ type: string; text?: string; data?: string; mimeType?: string }>;

async function backendFetch(
  baseUrl: string,
  path: string,
  options: RequestInit = {},
  apiKey?: string
): Promise<unknown> {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(url, {
    ...options,
    headers: { ...headers, ...(options.headers as Record<string, string> ?? {}) },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Backend ${res.status}: ${text}`);
  }
  return res.json();
}

/** Encode ArrayBuffer → base64 without blowing the call stack on large images */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  env: Env
): Promise<{ content: ToolContent; isError?: boolean }> {
  const baseUrl = (env.CAMOFOX_URL || "http://localhost:9377").replace(/\/$/, "");
  const userId = (args.userId as string) || "default";
  const sessionKey = (args.sessionKey as string) || "default";

  try {
    switch (name) {
      // -----------------------------------------------------------------------
      case "camofox_create_tab": {
        const result = await backendFetch(baseUrl, "/tabs", {
          method: "POST",
          body: JSON.stringify({ url: args.url, userId, sessionKey }),
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      // -----------------------------------------------------------------------
      case "camofox_snapshot": {
        const qs = args.offset ? `&offset=${args.offset}` : "";
        const result = (await backendFetch(
          baseUrl,
          `/tabs/${args.tabId}/snapshot?userId=${encodeURIComponent(userId)}&includeScreenshot=true${qs}`
        )) as Record<string, unknown>;

        const content: ToolContent = [
          {
            type: "text",
            text: JSON.stringify(
              {
                url: result.url,
                refsCount: result.refsCount,
                snapshot: result.snapshot,
                truncated: result.truncated,
                totalChars: result.totalChars,
                hasMore: result.hasMore,
                nextOffset: result.nextOffset,
              },
              null,
              2
            ),
          },
        ];

        const screenshot = result.screenshot as { data?: string; mimeType?: string } | undefined;
        if (screenshot?.data) {
          content.push({ type: "image", data: screenshot.data, mimeType: screenshot.mimeType ?? "image/png" });
        }
        return { content };
      }

      // -----------------------------------------------------------------------
      case "camofox_click": {
        const { tabId, userId: _u, sessionKey: _s, ...rest } = args;
        const result = await backendFetch(baseUrl, `/tabs/${tabId}/click`, {
          method: "POST",
          body: JSON.stringify({ ...rest, userId }),
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      // -----------------------------------------------------------------------
      case "camofox_type": {
        const { tabId, userId: _u, sessionKey: _s, ...rest } = args;
        const result = await backendFetch(baseUrl, `/tabs/${tabId}/type`, {
          method: "POST",
          body: JSON.stringify({ ...rest, userId }),
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      // -----------------------------------------------------------------------
      case "camofox_navigate": {
        const { tabId, userId: _u, sessionKey: _s, ...rest } = args;
        const result = await backendFetch(baseUrl, `/tabs/${tabId}/navigate`, {
          method: "POST",
          body: JSON.stringify({ ...rest, userId }),
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      // -----------------------------------------------------------------------
      case "camofox_scroll": {
        const { tabId, userId: _u, sessionKey: _s, ...rest } = args;
        const result = await backendFetch(baseUrl, `/tabs/${tabId}/scroll`, {
          method: "POST",
          body: JSON.stringify({ ...rest, userId }),
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      // -----------------------------------------------------------------------
      case "camofox_screenshot": {
        const res = await fetch(
          `${baseUrl}/tabs/${args.tabId}/screenshot?userId=${encodeURIComponent(userId)}`
        );
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`${res.status}: ${text}`);
        }
        const buf = await res.arrayBuffer();
        return {
          content: [{ type: "image", data: arrayBufferToBase64(buf), mimeType: "image/png" }],
        };
      }

      // -----------------------------------------------------------------------
      case "camofox_close_tab": {
        const result = await backendFetch(
          baseUrl,
          `/tabs/${args.tabId}?userId=${encodeURIComponent(userId)}`,
          { method: "DELETE" }
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      // -----------------------------------------------------------------------
      case "camofox_evaluate": {
        const result = await backendFetch(baseUrl, `/tabs/${args.tabId}/evaluate`, {
          method: "POST",
          body: JSON.stringify({ userId, expression: args.expression }),
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      // -----------------------------------------------------------------------
      case "camofox_list_tabs": {
        const result = await backendFetch(
          baseUrl,
          `/tabs?userId=${encodeURIComponent(userId)}`
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      // -----------------------------------------------------------------------
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC dispatcher
// ---------------------------------------------------------------------------

function ok(id: string | number | null, result: unknown): JsonRpcMessage {
  return { jsonrpc: "2.0", id, result };
}

function err(id: string | number | null, code: number, message: string): JsonRpcMessage {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function dispatch(msg: JsonRpcMessage, env: Env): Promise<JsonRpcMessage | null> {
  const id = msg.id ?? null;
  const params = (msg.params ?? {}) as Record<string, unknown>;

  switch (msg.method) {
    case "initialize":
      return ok(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    // Notifications — no response
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, { tools: TOOLS });

    case "tools/call": {
      const toolName = params.name as string;
      const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
      const result = await callTool(toolName, toolArgs, env);
      return ok(id, result);
    }

    default:
      return err(id, -32601, `Method not found: ${msg.method}`);
  }
}

// ---------------------------------------------------------------------------
// CORS headers
// ---------------------------------------------------------------------------

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
};

// ---------------------------------------------------------------------------
// Worker fetch handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Health / readiness probe
    if (url.pathname === "/health") {
      return Response.json(
        { status: "ok", service: "camofox-mcp", version: SERVER_INFO.version },
        { headers: CORS }
      );
    }

    // MCP endpoint — accept both /mcp and / for convenience
    if (url.pathname === "/mcp" || url.pathname === "/") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed — MCP requires POST", {
          status: 405,
          headers: CORS,
        });
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json(err(null, -32700, "Parse error: request body is not valid JSON"), {
          status: 400,
          headers: { ...CORS, "Content-Type": "application/json" },
        });
      }

      // Support both single messages and JSON-RPC batches
      const isBatch = Array.isArray(body);
      const messages: JsonRpcMessage[] = isBatch ? (body as JsonRpcMessage[]) : [body as JsonRpcMessage];

      const responses: JsonRpcMessage[] = [];
      for (const msg of messages) {
        const response = await dispatch(msg, env);
        if (response !== null) responses.push(response);
      }

      const payload = isBatch ? responses : (responses[0] ?? null);
      return Response.json(payload, {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404, headers: CORS });
  },
};
