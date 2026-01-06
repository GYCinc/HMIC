# Artifact: Plan - Integrate Chrome DevTools, Exa, and Genkit

**Problem Summary:**
The user has installed the Chrome DevTools, Exa Search, and Genkit extensions for the Gemini CLI and now wants to integrate these same capabilities into the `hmic-hub` so the application's Orchestrator can utilize them.

**Context:**
- Project: `hmic-hub` (Node.js/TypeScript MCP Hub).
- Configuration: `config/tools.yaml` defines the managed MCP servers.
- Goal: Add Chrome DevTools, Exa, and Genkit to the ELT ecosystem.
- User Intent: Explicitly confirmed adding these tools to the HMIC Hub.

**Constraints & Assumptions:**
- **Chrome DevTools:** Requires a headless browser or connection to an existing instance. We will configure it to launch a headless instance (`--headless`) to ensure it works in a server environment without a GUI.
- **Exa:** Requires an API key (`EXA_API_KEY`). The user needs to provide this or it must be in the environment.
- **Genkit:** Requires a project root. We will assume the current directory is the project root unless otherwise specified.
- **Architecture:** Tools must be added to `config/tools.yaml` using the `npx` command pattern established in previous steps.

**Architectural Walkthrough:**
1.  **Define Tool Configurations:**
    *   **Chrome DevTools:** `npx -y chrome-devtools-mcp@latest --headless`
    *   **Exa:** `npx -y exa-mcp-server` (We will enable all tools for maximum capability).
    *   **Genkit:** `npx -y genkit-cli@^1.22.0 mcp`
2.  **Update `config/tools.yaml`:** Append these new definitions.
3.  **Environment Variables:** Add `EXA_API_KEY` placeholder to `.env`.
4.  **Restart:** The `ToolManager` watcher should pick up changes, but a restart ensures clean environment loading.

**To-Do List:**
- [ ] Add `chrome-devtools`, `exa`, and `genkit` to `config/tools.yaml`.
- [ ] Update `.env` with `EXA_API_KEY`.
- [ ] Restart the server to apply changes.
- [ ] Verify tool startup in logs.

**Open Questions:**
- Does the user have an `EXA_API_KEY`? (Will add placeholder).
- Does the user have a specific Genkit project setup? (Will default to current dir).
