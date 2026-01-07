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
let INIT_RESULT = null;
// Mock EventSource with Auth and Session
// @ts-ignore
global.EventSource = class AuthenticatedEventSource extends eventsource_1.EventSource {
    constructor(url, eventSourceInitDict) {
        const headers = {
            Authorization: `Bearer ${API_KEY}`,
            ...(SESSION_ID ? { "mcp-session-id": SESSION_ID } : {}),
            ...(eventSourceInitDict?.headers || {}),
        };
        super(url, { ...eventSourceInitDict, headers });
    }
};
const client = new index_js_1.Client({ name: "hmic-hub-bridge", version: "1.3.0" }, { capabilities: { tools: {} } });
const server = new index_js_2.Server({ name: "core-memory-bridge", version: "1.3.0" }, { capabilities: { tools: {} } });
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
        // Patch fetch for the internal transport usage
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
        client
            .connect(transport)
            .then(async () => {
            console.error("[Bridge] Connected to remote SSE.");
            // Populate handlers once remote is ready
            server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => {
                return await client.listTools();
            });
            server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
                return await client.callTool({
                    name: request.params.name,
                    arguments: request.params.arguments,
                });
            });
            console.error("[Bridge] Tool handlers registered.");
        })
            .catch((err) => {
            console.error("[Bridge Background Error]", err);
        });
    }
    catch (error) {
        console.error("[Bridge Fatal Error]", error);
        process.exit(1);
    }
}
main();
