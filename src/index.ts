import express from "express";
import { Server } from "socket.io";
import { createServer } from "http";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import pidusage from "pidusage";
import fs from "fs";
import path from "path";
import auth from "basic-auth";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import chokidar from "chokidar";
import yaml from "js-yaml";
import Joi from "joi";
import pino from "pino";
import { spawn, ChildProcess } from "child_process";
import dotenv from "dotenv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { PassThrough } from "stream";

dotenv.config();

// --- LOGGER SETUP ---
const logger = pino({
  level: process.env.LOG_LEVEL || "info",
});

// --- CONFIGURATION ---
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.resolve("data");
const CONFIG_PATH = process.env.CONFIG_PATH || path.resolve("config");
const CORE_DASHBOARD_URL = process.env.CORE_DASHBOARD_URL || "https://getcore.me";
const DB_PATH = path.join(DATA_DIR, "hmic.db");
const TOOL_CONFIG_PATH = path.join(CONFIG_PATH, "tools.yaml");
const VAR_EXPANSION_REGEX = /\${(\w+)}/g;

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CONFIG_PATH)) fs.mkdirSync(CONFIG_PATH, { recursive: true });

// Config Schema
const toolConfigSchema = Joi.object({
  version: Joi.string().required(),
  tools: Joi.array()
    .items(
      Joi.object({
        id: Joi.string().required(),
        name: Joi.string().required(),
        description: Joi.string().optional(),
        command: Joi.string().required(),
        args: Joi.array().items(Joi.string()).optional(),
        env: Joi.object().pattern(Joi.string(), Joi.string()).optional(),
        resource_limits: Joi.object({
          max_memory_mb: Joi.number().min(1).optional(),
          max_cpu_percent: Joi.number().min(1).max(100).optional(),
          auto_restart: Joi.boolean().default(true),
          max_restarts: Joi.number().min(0).default(3),
        }).optional(),
      })
    )
    .min(1),
});

// --- INITIALIZATION ---
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
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
app.use(
  helmet({
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
  })
);

app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS?.split(",") || [
      "http://localhost:3000",
      "http://localhost:2727",
    ],
    credentials: true,
  })
);

app.use(express.json());

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: "Too many requests from this IP",
});
app.use("/api/", apiLimiter);

// Basic Authentication Middleware
const requireAuth = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  if (!process.env.HTTP_USER || !process.env.HTTP_PASSWORD) return next();
  const credentials = auth(req);
  if (
    !credentials ||
    credentials.name !== process.env.HTTP_USER ||
    credentials.pass !== process.env.HTTP_PASSWORD
  ) {
    res.set("WWW-Authenticate", 'Basic realm="HMIC Hub"');
    return res.status(401).send("Authentication required");
  }
  next();
};

app.use((req, res, next) => {
  if (req.path === "/health") return next();
  requireAuth(req, res, next);
});

// --- DATABASE SETUP ---
let db: any;
(async () => {
  try {
    db = await open({
      filename: DB_PATH,
      driver: sqlite3.Database,
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
  } catch (e) {
    logger.error(`Failed to initialize SQLite: ${e}`);
  }
})();

// --- TOOL MANAGEMENT ---
interface ToolConfig {
  id: string;
  name: string;
  description?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  resource_limits?: {
    max_memory_mb?: number;
    max_cpu_percent?: number;
    auto_restart: boolean;
    max_restarts: number;
  };
}

interface ActiveTool {
  config: ToolConfig;
  process?: ChildProcess;
  client?: Client;
  transport?: Transport;
  status: "starting" | "running" | "stopped" | "error";
  restartCount: number;
  lastHeartbeat: Date;
  pid?: number;
}

class LogBuffer {
  private buffer: string[] = [];
  private flushTimeout: NodeJS.Timeout | null = null;
  private readonly FLUSH_DELAY = 100; // ms
  private readonly MAX_BUFFER_SIZE = 1000;

  constructor(private toolName: string, private io: Server) {}

  log(msg: string) {
    if (!msg) return;
    this.buffer.push(`[${this.toolName}] ${msg}`);
    this.checkFlush();
  }

  private checkFlush() {
    if (this.buffer.length >= this.MAX_BUFFER_SIZE) {
      this.flush();
    } else if (!this.flushTimeout) {
      this.flushTimeout = setTimeout(() => this.flush(), this.FLUSH_DELAY);
    }
  }

  flush() {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }

    if (this.buffer.length === 0) return;

    // Join messages with newlines to preserve structure while reducing emits
    const combinedMsg = this.buffer.join('\n');
    this.io.emit("log", combinedMsg);
    this.buffer = [];
  }
}

class ToolManager {
  private tools = new Map<string, ActiveTool>();
  private configWatcher: chokidar.FSWatcher;

  constructor() {
    this.loadConfig();
    this.configWatcher = chokidar.watch(TOOL_CONFIG_PATH, {
      persistent: true,
      ignoreInitial: true,
    });
    this.configWatcher.on("change", () => {
      logger.info("Config file changed, reloading...");
      this.loadConfig();
      io.emit("config_updated");
    });
  }

  private async loadConfig() {
    try {
      const configContent = await fs.promises.readFile(
        TOOL_CONFIG_PATH,
        "utf8"
      );
      const config = yaml.load(configContent);
      const { error, value } = toolConfigSchema.validate(config);
      if (error) throw new Error(`Config validation failed: ${error.message}`);
      await this.updateTools(value.tools);
      logger.info(`Loaded ${value.tools.length} tool configurations`);
    } catch (e: any) {
      if (e.code === "ENOENT") {
        await this.loadDefaultConfig();
        return;
      }
      logger.error(`Failed to load config: ${e}`);
      await this.loadDefaultConfig();
    }
  }

  private async loadDefaultConfig() {
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

  private async updateTools(newTools: ToolConfig[]) {
    // Stop tools that are no longer in config
    for (const [toolId, tool] of this.tools) {
      if (!newTools.find((t) => t.id === toolId)) await this.stopTool(toolId);
    }

    // Start or update tools
    await Promise.all(
      newTools.map(async (toolConfig) => {
        if (!this.tools.has(toolConfig.id)) {
          try {
            await this.startTool(toolConfig);
          } catch (e) {
            // Error logged in startTool, but we ensure one failure doesn't stop others
            logger.error(`Failed to start tool ${toolConfig.id}: ${e}`);
          }
        } else {
          const existing = this.tools.get(toolConfig.id)!;
          existing.config = toolConfig;
          this.tools.set(toolConfig.id, existing);
        }
      })
    );
  }

  private async startTool(config: ToolConfig): Promise<ActiveTool> {
    const activeTool: ActiveTool = {
      config,
      status: "starting",
      restartCount: 0,
      lastHeartbeat: new Date(),
    };

    this.tools.set(config.id, activeTool);

    try {
      logger.info(`Launching tool: ${config.name}`);

      const expandVar = (str: string) => {
        return str.replace(VAR_EXPANSION_REGEX, (_, name) => {
          if (name === "DATA_DIR") return DATA_DIR;
          return process.env[name] || "";
        });
      };

      const expandedArgs = (config.args || []).map(expandVar);

      const expandedEnv = config.env
        ? Object.fromEntries(
            Object.entries(config.env).map(([k, v]) => [k, expandVar(v)])
          )
        : {};

      const logBuffer = new LogBuffer(config.name, io);

      const transport = new StdioClientTransport({
        command: config.command,
        args: expandedArgs,
        env: { ...process.env, ...expandedEnv } as Record<string, string>,
        stderr: "pipe" as any
      });

      const client = new Client(
        { name: "hmic-hub", version: "1.0.0" },
        { capabilities: {} }
      );

      await client.connect(transport);

      // Access underlying process to get PID and handle lifecycle
      const child = (transport as any)._process as ChildProcess;

      if (!child.pid) {
        throw new Error("Failed to spawn process");
      }

      activeTool.process = child;
      activeTool.pid = child.pid;
      activeTool.status = "running";
      activeTool.client = client;
      activeTool.transport = transport;

      // Handle stderr for logging
      child.stderr?.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          io.emit("log", `[${config.name} ERR] ${msg}`);
        }
      });

      // Note: stdout is handled by StdioClientTransport for MCP messages

      // We attach to the process 'close' event for lifecycle management
      // because client.connect might overwrite transport.onclose
      child.on("close", async (code: number) => {
        logBuffer.flush();
        logger.warn(`Tool ${config.name} exited with code ${code}`);
        activeTool.status = "stopped";
        activeTool.process = undefined;
        activeTool.client = undefined;
        activeTool.transport = undefined;
        io.emit("tool_status", { toolId: config.id, status: "stopped" });

        if (
          config.resource_limits?.auto_restart &&
          activeTool.restartCount < (config.resource_limits.max_restarts || 3)
        ) {
          activeTool.restartCount++;
          setTimeout(() => this.startTool(config), 2000);
        }
      });

      child.on("error", (error: Error) => {
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
        await db.run(
          `INSERT OR REPLACE INTO tool_status (tool_id, status, pid, restart_count) VALUES (?, ?, ?, ?)`,
          config.id,
          activeTool.status,
          activeTool.pid,
          activeTool.restartCount
        );
      }
    } catch (error: any) {
      activeTool.status = "error";
      logger.error(`Failed to start tool ${config.name}: ${error.message}`);
      io.emit("log", `[ERR] Failed to start ${config.name}: ${error.message}`);
    }
    return activeTool;
  }

  public async stopTool(toolId: string) {
    const tool = this.tools.get(toolId);
    if (tool) {
      if (tool.transport) {
        await tool.transport.close();
      } else if (tool.process) {
        tool.process.kill();
      }
    }
    this.tools.delete(toolId);
    logger.info(`Tool ${toolId} stopped`);
  }

  getTools(): ActiveTool[] {
    return Array.from(this.tools.values());
  }

  getTool(toolId: string): ActiveTool | undefined {
    return this.tools.get(toolId);
  }
}

const toolManager = new ToolManager();

// --- METRICS ---
interface MetricsData {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
}

const metrics: MetricsData = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
};

setInterval(async () => {
  try {
    const stats = await pidusage(process.pid);
    const errorRate =
      metrics.totalRequests > 0
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
      await db.run(
        `INSERT INTO metrics (cpu, memory, active_tools, total_requests, error_rate) VALUES (?, ?, ?, ?, ?)`,
        stats.cpu,
        stats.memory,
        systemMetrics.active_tools,
        systemMetrics.total_requests,
        systemMetrics.error_rate
      );
    }
  } catch (e) {
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

  socket.on(
    "tool:call",
    async (data: { toolId: string; method: string; params: any }) => {
      const { toolId, method, params } = data;
      io.emit(
        "log",
        `[MANUAL CMD] Sending to ${toolId}: ${JSON.stringify(params)}`
      );

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
        } else if (method === "callTool" || method === "tools/call") {
             // Expect params to match CallToolRequest
             resultData = await tool.client.callTool({
                name: params.name,
                arguments: params.arguments
             });
        } else {
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
      } catch (error: any) {
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
    }
  );

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

// --- DASHBOARD UI ---
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>HMIC // COMMAND CENTER</title>
        <style>
            :root { 
              --bg: #0a0a0a; 
              --term: #0f0f0f; 
              --text: #00ff41; 
              --dim: #008f11; 
              --err: #ff0055; 
              --warn: #ffaa00; 
            }
            body { 
              background: var(--bg); 
              color: var(--text); 
              font-family: 'Courier New', monospace; 
              margin: 0; 
              padding: 20px; 
              overflow: hidden; 
            }
            .container { 
              display: grid; 
              grid-template-columns: 300px 1fr; 
              gap: 20px; 
              height: 95vh; 
            }
            .panel { 
              background: var(--term); 
              border: 1px solid var(--dim); 
              padding: 15px; 
              display: flex; 
              flex-direction: column; 
            }
            .panel-title { 
              border-bottom: 1px solid var(--dim); 
              padding-bottom: 8px; 
              margin-bottom: 15px; 
              text-transform: uppercase; 
              letter-spacing: 2px; 
            }
            .tool-item { 
              padding: 10px; 
              border: 1px solid var(--dim); 
              background: #000; 
              margin-bottom: 5px; 
            }
            .status-running { color: var(--text); } 
            .status-stopped { color: var(--err); } 
            .status-starting { color: var(--warn); }
            .status-error { color: var(--err); }
            #logs { 
              flex: 1; 
              overflow-y: auto; 
              font-size: 12px; 
              line-height: 1.4; 
              background: #000; 
              padding: 10px; 
              border: 1px solid var(--dim); 
            }
            .log-entry { 
              margin-bottom: 3px; 
              border-left: 2px solid var(--dim); 
              padding-left: 5px; 
            }
            .log-err { 
              color: var(--err); 
              border-color: var(--err); 
            }
            button {
              background: var(--dim);
              color: #000;
              border: none;
              padding: 8px 12px;
              cursor: pointer;
              font-family: inherit;
              font-weight: bold;
              margin: 5px 0;
            }
            button:hover {
              background: var(--text);
            }
            button:focus-visible {
              outline: 2px solid var(--text);
              outline-offset: 2px;
            }
            .core-frame {
              width: 100%;
              height: 300px;
              border: 1px solid var(--dim);
              background: #000;
            }
            .sync-btn {
              background: var(--text);
              color: #000;
              width: 100%;
              padding: 10px;
              margin-top: 10px;
            }
        </style>
      </head>
      <body>
        <h1>HMIC // COMMAND CENTER</h1>
        <div class="container">
          <div class="panel">
            <div class="panel-title">ACTIVE TOOLS</div>
            <div id="toolList"></div>
            <div class="panel-title" style="margin-top:20px">METRICS</div>
            <div>CPU: <span id="cpu">--</span>%</div>
            <div>MEM: <span id="mem">--</span>MB</div>
            <div>Requests: <span id="requests">0</span></div>
            <div>Active Tools: <span id="activeTools">0</span></div>
            
            <div class="panel-title" style="margin-top:20px">CORE MEMORY</div>
            <iframe class="core-frame" src="${CORE_DASHBOARD_URL}" title="Core Memory Visualization"></iframe>
            <button class="sync-btn" onclick="syncMemory()">SYNC VISUALIZATION</button>
          </div>
          <div class="panel">
            <div class="panel-title">LIVE FEED</div>
            <div id="logs"></div>
          </div>
        </div>

        <!-- VISUAL BUILDER MODAL -->
        <div id="builderModal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); z-index:100;">
            <div style="background:var(--term); border:1px solid var(--text); margin:50px auto; width:80%; height:80%; padding:20px; display:flex; flex-direction:column;">
                <div style="display:flex; justify-content:space-between; border-bottom:1px solid var(--dim); padding-bottom:10px;">
                    <div class="panel-title" style="margin:0;">VISUAL TOOL BUILDER</div>
                    <button onclick="document.getElementById('builderModal').style.display='none'" style="background:var(--err); color:#fff;">CLOSE</button>
                </div>
                <div style="display:flex; gap:20px; flex:1; overflow:hidden; margin-top:10px;">
                    <div style="width:300px; border-right:1px solid var(--dim); overflow-y:auto; padding-right:10px;">
                        <h3>1. Select Tool Host</h3>
                        <select id="builderHostSelect" style="width:100%; background:#000; color:var(--text); padding:5px; margin-bottom:10px;" onchange="loadHostTools()">
                            <option value="">-- Select Host --</option>
                        </select>
                        <h3>2. Select Function</h3>
                        <div id="builderToolList"></div>
                    </div>
                    <div style="flex:1; overflow-y:auto; padding-left:10px;">
                        <h3>3. Configure & Run</h3>
                        <div id="builderForm">Select a function to configure...</div>
                        <div id="builderResult" style="margin-top:20px; border:1px solid var(--dim); padding:10px; background:#000; display:none;">
                            <strong>RESULT:</strong>
                            <pre id="builderResultContent" style="white-space:pre-wrap;"></pre>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <button onclick="openBuilder()" style="position:fixed; bottom:20px; right:20px; z-index:50; background:var(--text); color:#000; padding:15px 30px; font-size:16px; border:2px solid #000;">OPEN VISUAL BUILDER</button>

        <script src="/socket.io/socket.io.js"></script>
        <script>
          const socket = io();
          const logs = document.getElementById('logs');
          let availableHosts = [];
          
          socket.on('init', function(data) { 
            availableHosts = data.tools;
            renderTools(data.tools); 
            updateMetrics(data.metrics);
            updateBuilderHosts();
          });
          
          socket.on('tool_status', function(data) {
            // Refresh tool list when status changes
            fetch('/api/tools')
              .then(res => res.json())
              .then(tools => {
                  availableHosts = tools;
                  renderTools(tools);
                  updateBuilderHosts();
              });
          });

          socket.on('tool:result', function(data) {
              if (data.method === 'tools/list' && data.success) {
                  renderHostTools(data.toolId, data.result.tools);
              } else if (data.method === 'callTool') {
                  const resBox = document.getElementById('builderResult');
                  const resContent = document.getElementById('builderResultContent');
                  resBox.style.display = 'block';
                  if (data.success) {
                      resContent.style.color = 'var(--text)';
                      resContent.innerText = JSON.stringify(data.result, null, 2);
                  } else {
                      resContent.style.color = 'var(--err)';
                      resContent.innerText = 'ERROR: ' + data.error;
                  }
              }
          });
          
          socket.on('metrics', function(data) {
            document.getElementById('cpu').innerText = data.cpu.toFixed(1);
            document.getElementById('mem').innerText = (data.memory / 1024 / 1024).toFixed(0);
            document.getElementById('requests').innerText = data.total_requests;
            document.getElementById('activeTools').innerText = data.active_tools;
          });
          
          socket.on('log', function(msg) {
            const div = document.createElement('div');
            div.className = 'log-entry';
            if(msg.includes('ERR')) div.classList.add('log-err');
            const timestamp = new Date().toLocaleTimeString();
            div.innerHTML = \`[\${timestamp}] \${msg}\`;
            logs.appendChild(div);
            logs.scrollTop = logs.scrollHeight;
          });

          function renderTools(tools) {
            const toolList = document.getElementById('toolList');
            toolList.innerHTML = tools.map(function(t) {
              return '<div class="tool-item">' +
                '<strong class="status-' + t.status + '">' + t.name + '</strong><br>' +
                '<small>' + t.status.toUpperCase() + ' (PID: ' + (t.pid || 'N/A') + ')</small><br>' +
                '<button onclick="stopTool(\\'' + t.id + '\\')" aria-label="Stop ' + t.name + '">STOP</button>' +
              '</div>';
            }).join('');
          }
          
          function updateMetrics(metrics) {
            document.getElementById('requests').innerText = metrics.totalRequests || 0;
          }
          
          function stopTool(toolId) {
            fetch('/api/tools/' + toolId + '/stop', { method: 'POST' })
              .then(res => res.json())
              .then(data => {
                console.log('Tool stopped:', data);
              });
          }

          // --- VISUAL BUILDER FUNCTIONS ---
          function openBuilder() {
              document.getElementById('builderModal').style.display = 'block';
              updateBuilderHosts();
          }

          function updateBuilderHosts() {
              const sel = document.getElementById('builderHostSelect');
              const current = sel.value;
              sel.innerHTML = '<option value="">-- Select Host --</option>';
              availableHosts.forEach(t => {
                  if (t.status === 'running') {
                      const opt = document.createElement('option');
                      opt.value = t.id;
                      opt.text = t.name;
                      sel.appendChild(opt);
                  }
              });
              sel.value = current;
          }

          function loadHostTools() {
              const hostId = document.getElementById('builderHostSelect').value;
              document.getElementById('builderToolList').innerHTML = 'Loading...';
              document.getElementById('builderForm').innerHTML = 'Select a function...';
              document.getElementById('builderResult').style.display = 'none';

              if (!hostId) return;

              // Request tool list from server
              socket.emit('tool:call', {
                  toolId: hostId,
                  method: 'tools/list',
                  params: {}
              });
          }

          function renderHostTools(hostId, tools) {
              const list = document.getElementById('builderToolList');
              list.innerHTML = '';
              tools.forEach(tool => {
                  const btn = document.createElement('div');
                  btn.className = 'tool-item';
                  btn.style.cursor = 'pointer';
                  btn.innerHTML = '<strong>' + tool.name + '</strong><br><small>' + (tool.description || '').substring(0, 50) + '...</small>';
                  btn.onclick = () => renderToolForm(hostId, tool);
                  list.appendChild(btn);
              });
          }

          function renderToolForm(hostId, tool) {
              const formDiv = document.getElementById('builderForm');
              formDiv.innerHTML = '<h3>Configure: ' + tool.name + '</h3><p>' + (tool.description || '') + '</p>';

              const schema = tool.inputSchema || {};
              const props = schema.properties || {};
              const required = schema.required || [];

              const form = document.createElement('form');
              form.onsubmit = (e) => {
                  e.preventDefault();
                  const formData = new FormData(form);
                  const args = {};
                  for (let [key, value] of formData.entries()) {
                      // Basic type conversion
                      if (props[key] && props[key].type === 'number') value = Number(value);
                      if (props[key] && props[key].type === 'boolean') value = (value === 'on');
                      if (value !== '') args[key] = value;
                  }

                  runTool(hostId, tool.name, args);
              };

              Object.keys(props).forEach(key => {
                  const field = props[key];
                  const div = document.createElement('div');
                  div.style.marginBottom = '10px';

                  const label = document.createElement('label');
                  label.innerText = key + (required.includes(key) ? '*' : '') + ': ';
                  label.style.display = 'block';
                  label.style.color = 'var(--dim)';

                  let input;
                  if (field.type === 'boolean') {
                      input = document.createElement('input');
                      input.type = 'checkbox';
                  } else {
                      input = document.createElement('input');
                      input.type = 'text';
                      input.style.width = '100%';
                      input.style.background = '#000';
                      input.style.border = '1px solid var(--dim)';
                      input.style.color = 'var(--text)';
                      input.style.padding = '5px';
                      if (field.description) input.placeholder = field.description;
                  }
                  input.name = key;
                  if (required.includes(key)) input.required = true;

                  div.appendChild(label);
                  div.appendChild(input);
                  form.appendChild(div);
              });

              const submit = document.createElement('button');
              submit.innerText = 'RUN TOOL';
              submit.style.marginTop = '10px';
              submit.style.width = '100%';

              form.appendChild(submit);
              formDiv.appendChild(form);
          }

          function runTool(hostId, toolName, args) {
              const resContent = document.getElementById('builderResultContent');
              resContent.innerText = 'Running...';
              document.getElementById('builderResult').style.display = 'block';

              socket.emit('tool:call', {
                  toolId: hostId,
                  method: 'callTool',
                  params: {
                      name: toolName,
                      arguments: args
                  }
              });
          }

          function syncMemory() {
            const btn = document.querySelector('.sync-btn');
            const originalText = btn.innerText;
            btn.innerText = 'SYNCING...';
            btn.disabled = true;

            socket.emit('tool:call', {
              toolId: 'core-memory-bridge',
              method: 'callTool',
              params: {
                name: 'memory_ingest',
                arguments: {
                  sessionId: 'dashboard-sync',
                  message: 'Manual Sync triggered from HMIC Dashboard.'
                }
              }
            });

            setTimeout(() => {
              btn.innerText = 'SYNC COMPLETE';
              setTimeout(() => {
                btn.innerText = originalText;
                btn.disabled = false;
              }, 2000);
            }, 3000);
          }
        </script>
      </body>
    </html>
  `);
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
