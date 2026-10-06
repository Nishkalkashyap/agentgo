import test from 'node:test';
import assert from 'node:assert/strict';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createAgentHttpServer } from '../dist/server.js';
import { connectAgent } from '../dist/client.js';
import { saveConfig } from '../dist/config.js';
import { temporary, request, serviceFor, waitRun } from './helpers.mjs';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';

test('authenticated HTTP, host/origin checks, token rotation and MCP contract', async () => {
  const tmp = await temporary(); const service = await serviceFor(tmp);
  let token = 'a'.repeat(43);
  const app = createAgentHttpServer({ service, token: async () => token });
  const url = await app.listen(); let client;
  try {
    assert.equal((await fetch(`${url}/health`)).status, 401);
    const headers = { Authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${url}/health`, { headers })).status, 200);
    assert.equal((await fetch(`${url}/health`, { headers: { ...headers, Origin: 'https://attacker.example' } })).status, 403);
    const badHost = await new Promise((resolve, reject) => {
      const req = httpRequest(`${url}/health`, { headers: { ...headers, Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(badHost, 403);
    assert.equal((await fetch(`${url}/internal/stop`, { method: 'POST', headers })).status, 404);
    client = await connectAgent({ mcpConnectionURL: `${url}/mcp`, token });
    assert.equal((await client.listWorkspaces()).workspaces[0].id, 'project');
    const run = await client.startAgentRun(request());
    assert.equal((await waitRun(service, run.taskId)).status, 'succeeded');
    assert.equal((await client.getAgentRunOutput(run.taskId)).result.text, 'Reply: hello');
    const legacyHeaders = { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' };
    const tools = await fetch(`${url}/mcp`, { method: 'POST', headers: legacyHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    assert.equal(tools.status, 200);
    const list = (await tools.json()).result.tools;
    assert.equal(list.length, 13);
    assert.equal(list.find(t => t.name === 'startAgentRun').inputSchema.properties.policy, undefined);
    const oversized = await fetch(`${url}/mcp`, { method: 'POST', headers: legacyHeaders, body: ' '.repeat(512 * 1024 + 1) });
    assert.equal(oversized.status, 413);
    token = 'b'.repeat(43);
    assert.equal((await fetch(`${url}/health`, { headers })).status, 401);
  } finally { await client?.close(); await app.close(); await service.close(); await tmp.cleanup(); }
});

test('stdio MCP startup and EOF release the runtime lock', async () => {
  const tmp = await temporary(); let client;
  try {
    await saveConfig(tmp.stateDir, tmp.config);
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli.js'), 'stdio', '--state-dir', tmp.stateDir], stderr: 'pipe' });
    client = await connectAgent({ transport });
    assert.equal((await client.listWorkspaces()).workspaces.length, 1);
    await client.close(); client = undefined;
    const service = await serviceFor(tmp); await service.close();
  } finally { await client?.close(); await tmp.cleanup(); }
});
