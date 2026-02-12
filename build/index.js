"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const socket_io_1 = require("socket.io");
const http_1 = require("http");
const sqlite3_1 = __importDefault(require("sqlite3"));
const sqlite_1 = require("sqlite");
const pidusage_1 = __importDefault(require("pidusage"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const basic_auth_1 = __importDefault(require("basic-auth"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const chokidar_1 = __importDefault(require("chokidar"));
const js_yaml_1 = __importDefault(require("js-yaml"));
const joi_1 = __importDefault(require("joi"));
const pino_1 = __importDefault(require("pino"));
const dotenv_1 = __importDefault(require("dotenv"));
const index_js_1 = require("@modelcontextprotocol/sdk/client/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/client/stdio.js");
const dashboard_template_1 = require("./dashboard-template");
dotenv_1.default.config();
// --- LOGGER SETUP ---
const logger = (0, pino_1.default)({
    level: process.env.LOG_LEVEL || "info",
});
// --- CONFIGURATION ---
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path_1.default.resolve("data");
const CONFIG_PATH = process.env.CONFIG_PATH || path_1.default.resolve("config");
const CORE_DASHBOARD_URL = process.env.CORE_DASHBOARD_URL || "https://getcore.me";
// Pre-rendered Dashboard HTML
const DASHBOARD_HTML = (0, dashboard_template_1.getDashboardHtml)(CORE_DASHBOARD_URL);
const DB_PATH = path_1.default.join(DATA_DIR, "hmic.db");
const TOOL_CONFIG_PATH = path_1.default.join(CONFIG_PATH, "tools.yaml");
const VAR_EXPANSION_REGEX = /\${(\w+)}/g;
// Ensure directories exist
if (!fs_1.default.existsSync(DATA_DIR))
    fs_1.default.mkdirSync(DATA_DIR, { recursive: true });
if (!fs_1.default.existsSync(CONFIG_PATH))
    fs_1.default.mkdirSync(CONFIG_PATH, { recursive: true });
// Config Schema
const toolConfigSchema = joi_1.default.object({
    version: joi_1.default.string().required(),
    tools: joi_1.default.array()
        .items(joi_1.default.object({
        id: joi_1.default.string().required(),
        name: joi_1.default.string().required(),
        description: joi_1.default.string().optional(),
        command: joi_1.default.string().required(),
        args: joi_1.default.array().items(joi_1.default.string()).optional(),
        env: joi_1.default.object().pattern(joi_1.default.string(), joi_1.default.string()).optional(),
        resource_limits: joi_1.default.object({
            max_memory_mb: joi_1.default.number().min(1).optional(),
            max_cpu_percent: joi_1.default.number().min(1).max(100).optional(),
            auto_restart: joi_1.default.boolean().default(true),
            max_restarts: joi_1.default.number().min(0).default(3),
        }).optional(),
    }))
        .min(1),
});
// --- INITIALIZATION ---
const app = (0, express_1.default)();
const httpServer = (0, http_1.createServer)(app);
const io = new socket_io_1.Server(httpServer, {
    cors: {
        origin: process.env.ALLOWED_ORIGINS?.split(",") || [
            "http://localhost:3000",
            "http://localhost:2727",
        ],
        credentials: true,
    },
});
const port = process.env.PORT || 3000;
// Security middleware
app.use((0, helmet_1.default)({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'",
                "'unsafe-inline'",
                "https://cdnjs.cloudflare.com",
            ],
            styleSrc: ["'self'", "'unsafe-inline'"],
            connectSrc: ["'self'", "ws:", "wss:"],
        },
    },
}));
app.use((0, cors_1.default)({
    origin: process.env.ALLOWED_ORIGINS?.split(",") || [
        "http://localhost:3000",
        "http://localhost:2727",
    ],
    credentials: true,
}));
app.use(express_1.default.json({ limit: "50mb" }));
// Rate limiting
const apiLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: "Too many requests from this IP",
});
app.use("/api/", apiLimiter);
// Basic Authentication Middleware
const requireAuth = (req, res, next) => {
    if (!process.env.HTTP_USER || !process.env.HTTP_PASSWORD)
        return next();
    const credentials = (0, basic_auth_1.default)(req);
    if (!credentials ||
        credentials.name !== process.env.HTTP_USER ||
        credentials.pass !== process.env.HTTP_PASSWORD) {
        res.set("WWW-Authenticate", 'Basic realm="HMIC Hub"');
        return res.status(401).send("Authentication required");
    }
    next();
};
app.use((req, res, next) => {
    if (req.path === "/health")
        return next();
    if (req.path.startsWith("/extract/"))
        return next();
    requireAuth(req, res, next);
});
const requireApiKey = (req, res, next) => {
    const apiKey = req.headers["x-api-key"] || req.headers["authorization"]?.replace("Bearer ", "");
    const validKey = process.env.CORE_API_KEY;
    if (!validKey) {
        // If no key is configured, warn but maybe allow? No, strict by default.
        logger.warn("CORE_API_KEY not set, rejecting API request");
        return res.status(500).json({ error: "Server configuration error: API Key not set" });
    }
    if (!apiKey || apiKey !== validKey) {
        return res.status(401).json({ error: "Unauthorized: Invalid API Key" });
    }
    next();
};
// --- DATABASE SETUP ---
let db;
(async () => {
    try {
        db = await (0, sqlite_1.open)({
            filename: DB_PATH,
            driver: sqlite3_1.default.Database,
        });
        await db.exec(`
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        tool_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        method TEXT NOT NULL,
        input TEXT,
        output TEXT,
        status TEXT,
        latency_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_history_tool_id ON history(tool_id);
      CREATE INDEX IF NOT EXISTS idx_history_status ON history(status);
      CREATE INDEX IF NOT EXISTS idx_history_timestamp ON history(timestamp);
      CREATE INDEX IF NOT EXISTS idx_history_tool_id_status ON history(tool_id, status);

      CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        cpu REAL,
        memory REAL,
        active_tools INTEGER,
        total_requests INTEGER,
        error_rate REAL
      );
      CREATE TABLE IF NOT EXISTS tool_status (
        tool_id TEXT PRIMARY KEY,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT,
        pid INTEGER,
        restart_count INTEGER DEFAULT 0
      );
    `);
        logger.info(`Database initialized at ${DB_PATH}`);
    }
    catch (e) {
        logger.error(`Failed to initialize SQLite: ${e}`);
    }
})();
class LogBuffer {
    constructor(toolName, io) {
        this.toolName = toolName;
        this.io = io;
        this.buffer = [];
        this.flushTimeout = null;
        this.FLUSH_DELAY = 100; // ms
        this.MAX_BUFFER_SIZE = 1000;
    }
    log(msg) {
        if (!msg)
            return;
        this.buffer.push(`[${this.toolName}] ${msg}`);
        this.checkFlush();
    }
    checkFlush() {
        if (this.buffer.length >= this.MAX_BUFFER_SIZE) {
            this.flush();
        }
        else if (!this.flushTimeout) {
            this.flushTimeout = setTimeout(() => this.flush(), this.FLUSH_DELAY);
        }
    }
    flush() {
        if (this.flushTimeout) {
            clearTimeout(this.flushTimeout);
            this.flushTimeout = null;
        }
        if (this.buffer.length === 0)
            return;
        // Join messages with newlines to preserve structure while reducing emits
        const combinedMsg = this.buffer.join('\n');
        this.io.emit("log", combinedMsg);
        this.buffer = [];
    }
}
class ToolManager {
    constructor() {
        this.tools = new Map();
        this.loadConfig();
        this.configWatcher = chokidar_1.default.watch(TOOL_CONFIG_PATH, {
            persistent: true,
            ignoreInitial: true,
        });
        this.configWatcher.on("change", () => {
            logger.info("Config file changed, reloading...");
            this.loadConfig();
            io.emit("config_updated");
        });
    }
    async loadConfig() {
        try {
            const configContent = await fs_1.default.promises.readFile(TOOL_CONFIG_PATH, "utf8");
            const config = js_yaml_1.default.load(configContent);
            const { error, value } = toolConfigSchema.validate(config);
            if (error)
                throw new Error(`Config validation failed: ${error.message}`);
            await this.updateTools(value.tools);
            logger.info(`Loaded ${value.tools.length} tool configurations`);
        }
        catch (e) {
            if (e.code === "ENOENT") {
                await this.loadDefaultConfig();
                return;
            }
            logger.error(`Failed to load config: ${e}`);
            await this.loadDefaultConfig();
        }
    }
    async loadDefaultConfig() {
        const defaultConfig = {
            version: "1.0",
            tools: [
                {
                    id: "filesystem",
                    name: "Filesystem",
                    command: "node",
                    args: ["node_modules/@modelcontextprotocol/server-filesystem/dist/index.js", DATA_DIR],
                    resource_limits: { auto_restart: true, max_restarts: 3 },
                },
                // {
                //   id: "brave-search",
                //   name: "Brave Search",
                //   command: "npx",
                //   args: ["-y", "@modelcontextprotocol/server-brave-search"],
                //   env: { BRAVE_API_KEY: process.env.BRAVE_API_KEY || "" },
                //   resource_limits: { auto_restart: true, max_restarts: 3 },
                // },
            ],
        };
        await this.updateTools(defaultConfig.tools);
    }
    async updateTools(newTools) {
        // Stop tools that are no longer in config
        for (const [toolId, tool] of this.tools) {
            if (!newTools.find((t) => t.id === toolId))
                await this.stopTool(toolId);
        }
        // Start or update tools
        await Promise.all(newTools.map(async (toolConfig) => {
            if (!this.tools.has(toolConfig.id)) {
                try {
                    await this.startTool(toolConfig);
                }
                catch (e) {
                    // Error logged in startTool, but we ensure one failure doesn't stop others
                    logger.error(`Failed to start tool ${toolConfig.id}: ${e}`);
                }
            }
            else {
                const existing = this.tools.get(toolConfig.id);
                existing.config = toolConfig;
                this.tools.set(toolConfig.id, existing);
            }
        }));
    }
    async startTool(config) {
        const activeTool = {
            config,
            status: "starting",
            restartCount: 0,
            lastHeartbeat: new Date(),
        };
        this.tools.set(config.id, activeTool);
        try {
            logger.info(`Launching tool: ${config.name}`);
            const expandVar = (str) => {
                return str.replace(VAR_EXPANSION_REGEX, (_, name) => {
                    if (name === "DATA_DIR")
                        return DATA_DIR;
                    return process.env[name] || "";
                });
            };
            const expandedArgs = (config.args || []).map(expandVar);
            const expandedEnv = config.env
                ? Object.fromEntries(Object.entries(config.env).map(([k, v]) => [k, expandVar(v)]))
                : {};
            const logBuffer = new LogBuffer(config.name, io);
            const transport = new stdio_js_1.StdioClientTransport({
                command: config.command,
                args: expandedArgs,
                env: { ...process.env, ...expandedEnv },
                stderr: "pipe"
            });
            const client = new index_js_1.Client({ name: "hmic-hub", version: "1.0.0" }, { capabilities: {} });
            await client.connect(transport);
            // Access underlying process to get PID and handle lifecycle
            const child = transport._process;
            if (!child.pid) {
                throw new Error("Failed to spawn process");
            }
            activeTool.process = child;
            activeTool.pid = child.pid;
            activeTool.status = "running";
            activeTool.client = client;
            activeTool.transport = transport;
            // Handle stderr for logging
            child.stderr?.on("data", (data) => {
                const msg = data.toString().trim();
                if (msg) {
                    io.emit("log", `[${config.name} ERR] ${msg}`);
                }
            });
            // Note: stdout is handled by StdioClientTransport for MCP messages
            // We attach to the process 'close' event for lifecycle management
            // because client.connect might overwrite transport.onclose
            child.on("close", async (code) => {
                logBuffer.flush();
                logger.warn(`Tool ${config.name} exited with code ${code}`);
                activeTool.status = "stopped";
                activeTool.process = undefined;
                activeTool.client = undefined;
                activeTool.transport = undefined;
                io.emit("tool_status", { toolId: config.id, status: "stopped" });
                if (config.resource_limits?.auto_restart &&
                    activeTool.restartCount < (config.resource_limits.max_restarts || 3)) {
                    activeTool.restartCount++;
                    setTimeout(() => this.startTool(config), 2000);
                }
            });
            child.on("error", (error) => {
                logBuffer.flush();
                logger.error(`Tool ${config.name} process error: ${error.message}`);
                activeTool.status = "error";
                io.emit("tool_status", { toolId: config.id, status: "error" });
                io.emit("log", `[ERR] Tool ${config.name} failed: ${error.message}`);
            });
            io.emit("tool_status", {
                toolId: config.id,
                status: activeTool.status,
                pid: activeTool.pid,
            });
            if (db) {
                await db.run(`INSERT OR REPLACE INTO tool_status (tool_id, status, pid, restart_count) VALUES (?, ?, ?, ?)`, config.id, activeTool.status, activeTool.pid, activeTool.restartCount);
            }
        }
        catch (error) {
            activeTool.status = "error";
            logger.error(`Failed to start tool ${config.name}: ${error.message}`);
            io.emit("log", `[ERR] Failed to start ${config.name}: ${error.message}`);
        }
        return activeTool;
    }
    async stopTool(toolId) {
        const tool = this.tools.get(toolId);
        if (tool) {
            if (tool.transport) {
                await tool.transport.close();
            }
            else if (tool.process) {
                tool.process.kill();
            }
        }
        this.tools.delete(toolId);
        logger.info(`Tool ${toolId} stopped`);
    }
    getTools() {
        return Array.from(this.tools.values());
    }
    getTool(toolId) {
        return this.tools.get(toolId);
    }
}
const toolManager = new ToolManager();
const metrics = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
};
setInterval(async () => {
    try {
        const stats = await (0, pidusage_1.default)(process.pid);
        const errorRate = metrics.totalRequests > 0
            ? (metrics.failedRequests / metrics.totalRequests) * 100
            : 0;
        const systemMetrics = {
            cpu: stats.cpu,
            memory: stats.memory,
            timestamp: Date.now(),
            active_tools: toolManager.getTools().filter((t) => t.status === "running")
                .length,
            total_requests: metrics.totalRequests,
            error_rate: errorRate,
        };
        io.emit("metrics", systemMetrics);
        if (db) {
            await db.run(`INSERT INTO metrics (cpu, memory, active_tools, total_requests, error_rate) VALUES (?, ?, ?, ?, ?)`, stats.cpu, stats.memory, systemMetrics.active_tools, systemMetrics.total_requests, systemMetrics.error_rate);
        }
    }
    catch (e) {
        // Silently fail metrics collection
    }
}, 5000);
// --- SOCKET.IO ---
io.on("connection", (socket) => {
    logger.info(`Dashboard connected: ${socket.id}`);
    socket.emit("init", {
        tools: toolManager.getTools().map((t) => ({
            id: t.config.id,
            name: t.config.name,
            status: t.status,
            description: t.config.description,
            pid: t.pid,
        })),
        metrics: metrics,
    });
    socket.on("tool:call", async (data) => {
        const { toolId, method, params } = data;
        io.emit("log", `[MANUAL CMD] Sending to ${toolId}: ${JSON.stringify(params)}`);
        // Update metrics
        metrics.totalRequests++;
        const tool = toolManager.getTool(toolId);
        if (!tool || tool.status !== "running" || !tool.client) {
            io.emit("log", `[ERR] Tool ${toolId} is not running or not connected`);
            const result = {
                success: false,
                toolId,
                method,
                error: "Tool not running",
                timestamp: new Date().toISOString(),
            };
            socket.emit("tool:result", result);
            metrics.failedRequests++;
            return;
        }
        try {
            let resultData;
            // Handle different MCP calls based on method name
            // The dashboard assumes specific methods, but MCP uses JSON-RPC
            // Common MCP methods: tools/list, tools/call
            if (method === "tools/list") {
                resultData = await tool.client.listTools();
            }
            else if (method === "callTool" || method === "tools/call") {
                // Expect params to match CallToolRequest
                resultData = await tool.client.callTool({
                    name: params.name,
                    arguments: params.arguments
                });
            }
            else {
                // Try generic request
                // If params is just an object, pass it.
                // This part depends on what the dashboard sends.
                // If dashboard sends arbitrary method, we might need to map it.
                // For now, let's assume method maps to MCP method or tool name?
                // If the method is not a standard MCP method, maybe it's a tool name?
                // But the dashboard in index.ts had 'callTool' in the syncMemory function.
                // "method: 'callTool', params: { name: 'memory_ingest', ... }"
                // So we should handle that.
                // If the user sends a raw request:
                // We can't easily do client.request(method, params) because Client interface is typed.
                // But we can fallback to standard methods if we know them.
                // Let's assume the dashboard sends valid MCP method names or we map them.
                // But 'callTool' is a helper in SDK, the underlying method is 'tools/call'.
                // If the dashboard code sends `method: 'callTool'`, we use `client.callTool`.
                // Fallback for unknown methods: try to use the method name as the tool name
                // assuming the dashboard might be sending tool names directly as method.
                // If this assumption is wrong, we should just throw the error.
                throw new Error(`Unknown method: ${method}`);
            }
            const result = {
                success: true,
                toolId,
                method,
                result: resultData,
                timestamp: new Date().toISOString(),
            };
            socket.emit("tool:result", result);
            io.emit("log", `[RESULT] ${toolId}.${method} completed`);
            metrics.successfulRequests++;
        }
        catch (error) {
            io.emit("log", `[ERR] ${toolId}.${method} failed: ${error.message}`);
            const result = {
                success: false,
                toolId,
                method,
                error: error.message,
                timestamp: new Date().toISOString(),
            };
            socket.emit("tool:result", result);
            metrics.failedRequests++;
        }
    });
    socket.on("chat:message", async (data) => {
        try {
            const tools = toolManager.getTools();
            const toolList = tools.map(t => `- ${t.config.name} (${t.config.id}): ${t.config.description || "No description"} [Status: ${t.status}]`).join("\n");
            const systemMessage = {
                role: "system",
                content: `You are the MCP Homie. Your job is to help the user discover the capabilities of this MCP server.
You are chill, helpful, and speak like a homie.
Here are the currently active tools:
${toolList}

If the user asks about a specific tool, explain what it does based on its description.
If the user asks "what can you do?", list the available tools and suggest checking them out in the Visual Builder.
Keep responses concise and friendly.`
            };
            const messages = [systemMessage, ...data.history, { role: "user", content: data.message }];
            const response = await callLLM(messages);
            socket.emit("chat:response", { result: response });
        }
        catch (e) {
            logger.error(`Chat error: ${e.message}`);
            socket.emit("chat:response", { error: "My bad, something went wrong with the AI connection." });
        }
    });
    socket.on("disconnect", () => {
        logger.info(`Dashboard disconnected: ${socket.id}`);
    });
});
// --- API ROUTES ---
app.get("/health", (req, res) => {
    res.json({
        status: "healthy",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        tools: toolManager.getTools().length,
    });
});
app.get("/api/tools", (req, res) => {
    const tools = toolManager.getTools().map((t) => ({
        id: t.config.id,
        name: t.config.name,
        status: t.status,
        pid: t.pid,
        restartCount: t.restartCount,
    }));
    res.json(tools);
});
app.post("/api/tools/:toolId/stop", async (req, res) => {
    const { toolId } = req.params;
    await toolManager.stopTool(toolId);
    res.json({ success: true, message: `Tool ${toolId} stopped` });
});
// --- EXTRACTION API ---
// --- LLM PROVIDER INTEGRATION ---
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MOONSHOT_API_KEY = process.env.MOONSHOT_API_KEY;
const LLM_PROVIDER = process.env.LLM_PROVIDER || "openrouter"; // 'openrouter' or 'moonshot'
const LLM_MODEL = process.env.LLM_MODEL || (LLM_PROVIDER === "moonshot" ? "moonshot-v1-8k" : "google/gemini-2.0-flash-001");
async function callLLM(messages) {
    let apiUrl;
    let apiKey;
    let headers; // Explicitly any or Record<string, string> compatible with fetch
    let model = LLM_MODEL;
    if (LLM_PROVIDER === "moonshot") {
        apiUrl = "https://api.moonshot.cn/v1/chat/completions";
        apiKey = MOONSHOT_API_KEY;
        if (!apiKey)
            throw new Error("MOONSHOT_API_KEY is not configured.");
        headers = {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
        };
    }
    else {
        // Default to OpenRouter
        apiUrl = "https://openrouter.ai/api/v1/chat/completions";
        apiKey = OPENROUTER_API_KEY;
        if (!apiKey)
            throw new Error("OPENROUTER_API_KEY is not configured.");
        headers = {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://hmic.hub", // Required by OpenRouter
            "X-Title": "HMIC Hub",
        };
    }
    try {
        const response = await fetch(apiUrl, {
            method: "POST",
            headers: headers,
            body: JSON.stringify({
                model: model,
                messages: messages,
                temperature: 0.7,
            }),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`${LLM_PROVIDER.toUpperCase()} API Error: ${response.status} - ${errorText}`);
        }
        const data = await response.json();
        if (!data.choices || data.choices.length === 0) {
            throw new Error(`${LLM_PROVIDER.toUpperCase()} returned no choices.`);
        }
        return data.choices[0].message.content;
    }
    catch (error) {
        logger.error(`${LLM_PROVIDER.toUpperCase()} Call Failed: ${error.message}`);
        throw error;
    }
}
async function processExtraction(phase, data) {
    logger.info(`Processing extraction phase: ${phase} using ${LLM_PROVIDER}`);
    // Construct prompts based on phase
    let systemPrompt = "You are an expert educational analyst. Extract key information from the provided transcript.";
    let userPrompt = "";
    if (phase === "phase1") {
        systemPrompt += " Focus on identifying the main topic, key concepts discussed, and any specific questions raised by the student.";
        userPrompt = `Analyze the following transcript for Student ID: ${data.studentId}.\n\nTRANSCRIPT:\n${data.transcript}\n\nProvide a structured summary in JSON format with keys: 'topic', 'concepts', 'questions', 'summary'.`;
    }
    else if (phase === "phase2") {
        systemPrompt += " Integrate the provided notes with the transcript to deepen the analysis.";
        userPrompt = `Review the following transcript and notes for Student ID: ${data.studentId}.\n\nTRANSCRIPT:\n${data.transcript}\n\nNOTES:\n${data.notes}\n\nSynthesize the notes with the transcript. Identify how the notes clarify or expand upon the transcript. Return a structured JSON summary.`;
    }
    else if (phase === "phase3") {
        systemPrompt = "You are an expert report generator. Create a comprehensive Markdown report.";
        userPrompt = `Generate a final Markdown report for Student ID: ${data.studentId} based on the following analysis results.\n\nPHASE 1 RESULT:\n${JSON.stringify(data.phase1Result)}\n\nPHASE 2 RESULT:\n${JSON.stringify(data.phase2Result)}\n\nThe report should include:\n1. Executive Summary\n2. Key Concepts & Definitions\n3. Detailed Analysis\n4. Action Items / Recommendations\n\nReturn ONLY the Markdown content.`;
    }
    else {
        throw new Error(`Unknown phase: ${phase}`);
    }
    try {
        const resultText = await callLLM([
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ]);
        // For Phase 1 & 2, try to parse JSON if possible, otherwise wrap string
        if (phase === "phase1" || phase === "phase2") {
            try {
                // Attempt to extract JSON from code blocks if present
                const jsonMatch = resultText.match(/```json\n([\s\S]*?)\n```/) || resultText.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    return JSON.parse(jsonMatch[1] || jsonMatch[0]);
                }
                return { raw_result: resultText };
            }
            catch (e) {
                logger.warn("Failed to parse LLM JSON response, returning raw text.");
                return { raw_result: resultText };
            }
        }
        // Phase 3 returns Markdown directly (in a wrapper object for the API)
        return { data: { summary: resultText } };
    }
    catch (error) {
        logger.error(`Extraction failed during ${phase}: ${error.message}`);
        // Fallback or re-throw? Re-throw so the API reports the error.
        throw error;
    }
}
const extractRouter = express_1.default.Router();
extractRouter.use(requireApiKey);
extractRouter.post("/phase1", async (req, res) => {
    try {
        req.setTimeout(300000); // 5 minutes
        const { transcript, studentId } = req.body;
        if (!transcript || !studentId) {
            return res.status(400).json({ error: "Missing transcript or studentId" });
        }
        const result = await processExtraction("phase1", { transcript, studentId });
        res.json({ result });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
extractRouter.post("/phase2", async (req, res) => {
    try {
        req.setTimeout(300000); // 5 minutes
        const { transcript, notes, studentId } = req.body;
        if (!transcript || !studentId) {
            return res.status(400).json({ error: "Missing transcript or studentId" });
        }
        const result = await processExtraction("phase2", { transcript, notes, studentId });
        res.json({ result });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
extractRouter.post("/phase3", async (req, res) => {
    try {
        req.setTimeout(300000); // 5 minutes
        const { phase1Result, phase2Result, studentId } = req.body;
        if (!phase1Result || !phase2Result || !studentId) {
            return res.status(400).json({ error: "Missing phase results or studentId" });
        }
        const result = await processExtraction("phase3", { phase1Result, phase2Result, studentId });
        res.json({ markdown: result.data?.summary || "# Extraction Report\n\n(Mock Data)" });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
extractRouter.post("/full", async (req, res) => {
    try {
        req.setTimeout(300000); // 5 minutes
        const { transcriptJson, transcriptText, notes, studentId } = req.body;
        if ((!transcriptJson && !transcriptText) || !studentId) {
            return res.status(400).json({ error: "Missing transcript (text or json) or studentId" });
        }
        const transcript = transcriptText || JSON.stringify(transcriptJson);
        const phase1Result = await processExtraction("phase1", { transcript, studentId });
        const phase2Result = await processExtraction("phase2", { transcript, notes, studentId });
        const phase3Output = await processExtraction("phase3", { phase1Result, phase2Result, studentId });
        res.json({
            phase1Result,
            phase2Result,
            phase3Markdown: phase3Output.data?.summary || "# Extraction Report\n\n(Mock Data)"
        });
    }
    catch (error) {
        logger.error(`Full extraction failed: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});
app.use("/extract", extractRouter);
// --- DASHBOARD UI ---
app.get("/", (req, res) => {
    res.send(DASHBOARD_HTML);
});
// Start server
httpServer.listen(port, () => {
    logger.info(`HMIC Hub listening on port ${port}`);
    logger.info(`Data directory: ${DATA_DIR}`);
    logger.info(`Config path: ${CONFIG_PATH}`);
});
// Graceful shutdown
process.on("SIGTERM", async () => {
    logger.info("Received SIGTERM, shutting down gracefully...");
    // Stop all tools
    const tools = toolManager.getTools();
    for (const tool of tools) {
        if (tool.process) {
            tool.process.kill();
        }
    }
    if (db) {
        await db.close();
    }
    httpServer.close(() => {
        logger.info("Server closed");
        process.exit(0);
    });
});
//# sourceMappingURL=index.js.map