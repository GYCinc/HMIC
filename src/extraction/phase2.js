#!/usr/bin/env node
/**
 * HMIC MCP Tool: Phase 2 Extraction (Kimi K2.5)
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const API_KEY = process.env.MOONSHOT_API_KEY;

const server = new Server(
  { name: 'extraction-phase2', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [{
      name: 'extract_phase2',
      description: 'Run Phase 2 content extraction using Kimi K2.5',
      inputSchema: {
        type: 'object',
        properties: {
          transcript: { type: 'string', description: 'Text transcript' },
          notes: { type: 'string', description: 'Session notes' },
          prompt: { type: 'string', description: 'Phase 2 prompt template' }
        },
        required: ['transcript', 'notes', 'prompt']
      }
    }]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'extract_phase2') {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const { transcript, notes, prompt } = request.params.arguments;

  try {
    const finalPrompt = prompt
      .replace(/\$\{transcript\}/g, transcript || '')
      .replace(/\$\{notes\}/g, notes || '');

    const response = await fetch('https://api.moonshot.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'kimi-k2.5',
        messages: [{ role: 'user', content: finalPrompt }],
        reasoning: { effort: 'high' },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Moonshot error: ${response.status} - ${error}`);
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
