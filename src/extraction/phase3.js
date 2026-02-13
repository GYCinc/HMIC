#!/usr/bin/env node
/**
 * HMIC MCP Tool: Phase 3 Synthesis (GLM-5)
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const API_KEY = process.env.ZAI_API_KEY;

const server = new Server(
  { name: 'extraction-phase3', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [{
      name: 'extract_phase3',
      description: 'Run Phase 3 synthesis using GLM-5',
      inputSchema: {
        type: 'object',
        properties: {
          phase1Result: { type: 'string', description: 'Phase 1 diagnostic output' },
          phase2Result: { type: 'string', description: 'Phase 2 extraction output' },
          prompt: { type: 'string', description: 'Phase 3 prompt template' }
        },
        required: ['phase1Result', 'phase2Result', 'prompt']
      }
    }]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'extract_phase3') {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const { phase1Result, phase2Result, prompt } = request.params.arguments;

  try {
    const finalPrompt = prompt
      .replace(/\$\{phase1Result\}/g, phase1Result || '')
      .replace(/\$\{phase2Result\}/g, phase2Result || '')
      .replace(/INPUT A/g, phase1Result || '')
      .replace(/INPUT B/g, phase2Result || '');

    const response = await fetch('https://api.z.ai/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'glm-5',
        messages: [{ role: 'user', content: finalPrompt }],
        thinking: { type: 'enabled' },
        max_tokens: 128000,
        temperature: 0.9,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`GLM-5 error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    const result = data.choices?.[0]?.message?.content || '';

    return {
      content: [{ type: 'text', text: result }]
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true
    };
  }
});

const transport = new StdioServerTransport();
server.connect(transport);
