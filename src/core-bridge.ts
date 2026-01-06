import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { EventSource } from "eventsource";

const API_KEY = process.env.CORE_API_KEY;
const CORE_ENDPOINT = "https://mcp.getcore.me/api/v1/mcp";

if (!API_KEY) {
  console.error("Error: CORE_API_KEY environment variable is required.");
  process.exit(1);
}

let SESSION_ID: string | null = null;
let INIT_RESULT: any = null;

// @ts-ignore
global.EventSource = class AuthenticatedEventSource extends EventSource {
  constructor(url: string | URL, eventSourceInitDict?: any) {
    const headers = {
      Authorization: `Bearer ${API_KEY}`,
      ...(SESSION_ID ? { "mcp-session-id": SESSION_ID } : {}),
      ...(eventSourceInitDict?.headers || {}),
    };
    super(url, { ...eventSourceInitDict, headers });

    // Patch: Emit 'endpoint' event manually if server doesn't send it.
    this.addEventListener("open", () => {
      setTimeout(() => {
        const endpointUrl = `${CORE_ENDPOINT}?source=GeminiCLI&session_id=${SESSION_ID}`;
        // Global MessageEvent is available in Node 20
        const event = new global.MessageEvent("endpoint", {
          data: endpointUrl,
        });
        this.dispatchEvent(event);
      }, 100);
    });
  }
} as any;

const originalFetch = global.fetch;
global.fetch = async (input, init) => {
  const urlStr = input.toString();
  if (
    urlStr.includes(CORE_ENDPOINT) ||
    urlStr.includes("mcp.getcore.me") ||
    (init?.method === "POST" && urlStr.includes("http"))
  ) {
    init = init || {};
    init.headers = {
      ...init.headers,
      Authorization: `Bearer ${API_KEY}`,
      Accept: "application/json, text/event-stream",
      ...(SESSION_ID ? { "mcp-session-id": SESSION_ID } : {}),
    };
    console.error(`[Bridge] Fetching ${init.method || "GET"} ${urlStr}`);
  }
  const response = await originalFetch(input, init);
  if (init?.method === "POST" && urlStr.includes(CORE_ENDPOINT)) {
    console.error(`[Bridge] POST Status: ${response.status}`);
    if (!response.ok) {
      const text = await response.clone().text();
      console.error(`[Bridge] POST Error Body: ${text}`);
    }
  }
  return response;
};

// Custom Transport to handle double-init
class CustomSSEClientTransport extends SSEClientTransport {
  constructor(url: URL, private savedInitResult: any) {
    super(url);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    // Intercept 'initialize' request
    if ((message as any).method === "initialize") {
      // Simulate server response
      const response = {
        jsonrpc: "2.0",
        id: (message as any).id,
        result: this.savedInitResult.result,
      };

      if (this.onmessage) {
        this.onmessage(response as JSONRPCMessage);
      }
      return;
    }
    return super.send(message);
  }
}

const client = new Client(
  { name: "hmic-hub-bridge", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const server = new Server(
  { name: "core-memory-bridge", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

async function main() {
  try {
    // 1. Initialize Session via POST
    console.error("Initializing Core Session...");
    const initResponse = await originalFetch(
      `${CORE_ENDPOINT}?source=GeminiCLI`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "gemini-cli-bridge", version: "1.0.0" },
          },
          id: 1,
        }),
      }
    );

    if (!initResponse.ok) {
      console.error(
        `Initialization failed: ${
          initResponse.status
        } ${await initResponse.text()}`
      );
      process.exit(1);
    }

    // Capture Session ID
    SESSION_ID = initResponse.headers.get("mcp-session-id");

    if (!SESSION_ID) {
      console.warn("Warning: No mcp-session-id returned from initialization.");
    } else {
      console.error(`Session initialized: ${SESSION_ID}`);
    }

    // Parse SSE stream to get Init Result
    const reader = initResponse.body?.getReader();
    let receivedData = "";

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = new TextDecoder().decode(value);
        receivedData += chunk;

        const dataMatch = receivedData.match(/data: ({.*})/);
        if (dataMatch) {
          try {
            INIT_RESULT = JSON.parse(dataMatch[1]);
            console.error("Parsed initialization result.");
            break;
          } catch (e) {
            console.error("Failed to parse init result JSON:", e);
          }
        }
      }
      // Stop reading stream
      reader.cancel();
    }

    if (!INIT_RESULT) {
      console.error("Failed to capture initialization result from SSE stream.");
      // proceed anyway? No, customization needs it.
      process.exit(1);
    }

    // 2. Start Custom SSE Transport
    const transport = new CustomSSEClientTransport(
      new URL(`${CORE_ENDPOINT}?source=Antigravity&integrations=all`),
      INIT_RESULT
    );

    await client.connect(transport);
    console.error("Connected to Core Memory SSE Endpoint");

    const { tools: remoteTools } = await client.listTools();
    console.error(`Found ${remoteTools.length} tools`);

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const result = await client.listTools();
      return { tools: result.tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const result = await client.callTool({
        name: request.params.name,
        arguments: request.params.arguments,
      });
      return result;
    });

    const startTransport = new StdioServerTransport();
    await server.connect(startTransport);
    console.error("Core Memory Bridge running on Stdio");
  } catch (error) {
    console.error("Bridge Error:", error);
    process.exit(1);
  }
}

main();
