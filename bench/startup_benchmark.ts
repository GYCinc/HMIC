import { performance } from "perf_hooks";

// Mock interfaces
interface ToolConfig {
  id: string;
  name: string;
  command: string;
  args?: string[];
}

interface ActiveTool {
  config: ToolConfig;
  status: "starting" | "running";
}

// Mock DB
const db = {
  run: async (sql: string, ...params: any[]) => {
    // Simulate DB latency
    return new Promise((resolve) => setTimeout(resolve, 50));
  }
};

class ToolManagerBenchmark {
  private tools = new Map<string, ActiveTool>();

  // Current implementation (Serial)
  async updateToolsSerial(newTools: ToolConfig[]) {
    this.tools.clear();
    for (const toolConfig of newTools) {
      if (!this.tools.has(toolConfig.id)) {
        await this.startTool(toolConfig);
      } else {
        const existing = this.tools.get(toolConfig.id)!;
        existing.config = toolConfig;
        this.tools.set(toolConfig.id, existing);
      }
    }
  }

  // Optimized implementation (Parallel)
  async updateToolsParallel(newTools: ToolConfig[]) {
    this.tools.clear();

    const startupPromises: Promise<ActiveTool>[] = [];

    for (const toolConfig of newTools) {
      if (!this.tools.has(toolConfig.id)) {
        startupPromises.push(this.startTool(toolConfig));
      } else {
        const existing = this.tools.get(toolConfig.id)!;
        existing.config = toolConfig;
        this.tools.set(toolConfig.id, existing);
      }
    }

    // Wait for all starts to complete
    await Promise.all(startupPromises);
  }

  // Safe Parallel Implementation (handling errors individually)
  async updateToolsParallelSafe(newTools: ToolConfig[]) {
    this.tools.clear();

    const startupPromises = newTools.map(async (toolConfig) => {
        if (!this.tools.has(toolConfig.id)) {
            try {
                await this.startTool(toolConfig);
            } catch (e) {
                console.error(`Failed to start tool ${toolConfig.id}`, e);
            }
        } else {
            const existing = this.tools.get(toolConfig.id)!;
            existing.config = toolConfig;
            this.tools.set(toolConfig.id, existing);
        }
    });

    await Promise.all(startupPromises);
  }

  private async startTool(config: ToolConfig): Promise<ActiveTool> {
    const activeTool: ActiveTool = {
      config,
      status: "starting",
    };
    this.tools.set(config.id, activeTool);

    // Simulate work
    // spawn process (negligible time in this mock, but let's say 1ms)
    await new Promise(r => setTimeout(r, 1));

    activeTool.status = "running";

    // DB insert (slow)
    if (db) {
        await db.run("INSERT ...", config.id);
    }

    return activeTool;
  }
}

async function runBenchmark() {
  const manager = new ToolManagerBenchmark();
  const toolCount = 50;
  const tools: ToolConfig[] = [];
  for (let i = 0; i < toolCount; i++) {
    tools.push({ id: `tool-${i}`, name: `Tool ${i}`, command: "echo" });
  }

  console.log(`Benchmarking with ${toolCount} tools...`);

  // Measure Serial
  const startSerial = performance.now();
  await manager.updateToolsSerial(tools);
  const endSerial = performance.now();
  console.log(`Serial execution time: ${(endSerial - startSerial).toFixed(2)}ms`);

  // Measure Parallel
  const startParallel = performance.now();
  await manager.updateToolsParallel(tools);
  const endParallel = performance.now();
  console.log(`Parallel execution time: ${(endParallel - startParallel).toFixed(2)}ms`);

  // Measure Parallel Safe
  const startParallelSafe = performance.now();
  await manager.updateToolsParallelSafe(tools);
  const endParallelSafe = performance.now();
  console.log(`Parallel Safe execution time: ${(endParallelSafe - startParallelSafe).toFixed(2)}ms`);
}

runBenchmark();
