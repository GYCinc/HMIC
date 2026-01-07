"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const index_js_1 = require("@modelcontextprotocol/sdk/client/index.js");
const sse_js_1 = require("@modelcontextprotocol/sdk/client/sse.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const index_js_2 = require("@modelcontextprotocol/sdk/server/index.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const eventsource_1 = require("eventsource");
const API_KEY = process.env.CORE_API_KEY;
const CORE_ENDPOINT = "https://mcp.getcore.me/api/v1/mcp";
if (!API_KEY) {
    console.error("Error: CORE_API_KEY environment variable is required.");
    process.exit(1);
}
let SESSION_ID = null;
let isConnected = false;
// Mock EventSource with Auth and Session
// @ts-ignore
global.EventSource = class AuthenticatedEventSource extends eventsource_1.EventSource {
    constructor(url, eventSourceInitDict) {
        const headers = {
            Authorization: `Bearer ${API_KEY}`,
            Accept: "text/event-stream",
            ...(SESSION_ID ? { "mcp-session-id": SESSION_ID } : {}),
            ...(eventSourceInitDict?.headers || {}),
        };
        super(url, { ...eventSourceInitDict, headers });
    }
};
const client = new index_js_1.Client({ name: "hmic-hub-bridge", version: "1.4.0" }, { capabilities: { tools: {} } });
const server = new index_js_2.Server({ name: "core-memory-bridge", version: "1.4.0" }, { capabilities: { tools: {} } });
// Register handlers IMMEDIATELY so bridge responds to IDE even if background sync is slow
server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => {
    console.error("[Bridge] Handling listTools request...");
    if (!isConnected) {
        console.error("[Bridge Warning] listTools called before remote connected.");
        return { tools: [], _meta: { status: "connecting" } };
    }
    try {
        const result = await client.listTools();
        console.error(`[Bridge] listTools returned ${result.tools.length} tools`);
        return result;
    }
    catch (err) {
        console.error("[Bridge Error] listTools failed:", err);
        throw err;
    }
});
server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
    console.error(`[Bridge] Handling callTool request: ${request.params.name}`);
    if (!isConnected) {
        throw new Error("Bridge not connected to remote Core Memory yet.");
    }
    try {
        const result = await client.callTool({
            name: request.params.name,
            arguments: request.params.arguments,
        });
        console.error(`[Bridge] callTool ${request.params.name} succeeded`);
        return result;
    }
    catch (err) {
        console.error(`[Bridge Error] callTool ${request.params.name} failed:`, err);
        throw err;
    }
});
async function main() {
    try {
        // 1. Initial Handshake to get Session ID
        console.error("[Bridge] Handshaking with Core...");
        const initResponse = await fetch(`${CORE_ENDPOINT}?source=Antigravity&integrations=all`, {
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
        });
        if (!initResponse.ok) {
            throw new Error(`Init failed: ${initResponse.status} ${await initResponse.text()}`);
        }
        SESSION_ID = initResponse.headers.get("mcp-session-id");
        console.error(`[Bridge] Captured Session: ${SESSION_ID}`);
        // 2. Start Local Server immediately so IDE turns GREEN
        const stdioTransport = new stdio_js_1.StdioServerTransport();
        await server.connect(stdioTransport);
        console.error("[Bridge] Local Server started on Stdio (GREEN).");
        // 3. Connect to Remote in background
        const transport = new sse_js_1.SSEClientTransport(new URL(`${CORE_ENDPOINT}?source=Antigravity&integrations=all&session_id=${SESSION_ID}`));
        // Patch fetch for internal SDK usage
        const originalFetch = global.fetch;
        global.fetch = async (input, init) => {
            const urlStr = input.toString();
            if (urlStr.includes("mcp.getcore.me")) {
                init = init || {};
                init.headers = {
                    ...init.headers,
                    Authorization: `Bearer ${API_KEY}`,
                    "mcp-session-id": SESSION_ID || "",
                };
            }
            return originalFetch(input, init);
        };
        console.error(`[Bridge] Connecting to remote SSE...`);
        await client.connect(transport);
        isConnected = true;
        console.error("[Bridge] Connected to remote SSE successfully.");
        // Pre-warm tools
        try {
            const remoteTools = await client.listTools();
            console.error(`[Bridge] Remote tools pre-warmed: ${remoteTools.tools.length}`);
        }
        catch (err) {
            console.error("[Bridge Warning] Failed to pre-warm tools:", err);
        }
    }
    catch (error) {
        console.error("[Bridge Fatal Error]", error);
        process.exit(1);
    }
}
main();
