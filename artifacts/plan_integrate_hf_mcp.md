# Artifact: Plan - Integrate Hugging Face MCP Server

**Problem Summary:**
The user has installed the Hugging Face MCP server extension for the Gemini CLI. To align with the project's architecture (`hmic-hub`), this server should be integrated into the central hub's tool management system so it can be monitored and utilized by the "Orchestrator" for pedagogical content generation.

**Context:**
- Project: `hmic-hub` (Node.js/TypeScript MCP Hub).
- Configuration: `tools.yaml` defines the managed MCP servers.
- Goal: Add Hugging Face capabilities to the ELT ecosystem.

**Constraints & Assumptions:**
- Assumption: The Hugging Face MCP server can be launched via `npx -y @huggingface/mcp-server`.
- Requirement: A Hugging Face API token (`HF_TOKEN`) is likely needed for full functionality.
- Requirement: Adherence to `index.ts` configuration logic (child process management).

**Architectural Walkthrough:**
1. **Identify Command**: The standard command for the HF MCP server is `npx -y @huggingface/mcp-server`.
2. **Update Configuration**: Add a new tool entry to `tools.yaml` with ID `huggingface`.
3. **Manage Secrets**: Ensure `HF_TOKEN` is passed via environment variables if available.
4. **Validation**: The `ToolManager` in `index.ts` uses `chokidar` to watch `tools.yaml` and will automatically restart/start the new tool.

**To-Do List:**
- [ ] Verify the exact command and environment variables for `@huggingface/mcp-server`.
- [ ] Add the `huggingface` tool definition to `tools.yaml`.
- [ ] check `dotenv.txt` or `env.sh` for `HF_TOKEN`.
- [ ] Verify the tool appears in the HMIC Hub dashboard (or logs).

**Open Questions:**
- Does the user already have a `HF_TOKEN` configured?
- Are there specific HF models the Orchestrator should prioritize?
