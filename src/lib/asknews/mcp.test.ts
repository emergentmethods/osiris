import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mcpOperations } from './mcp';

const key = 'offline-secret-sentinel';
const tool = { name: 'OddCamelTool', description: 'Invented reporting tool', inputSchema: { type: 'object' as const, properties: { return_type: { enum: ['string', 'dicts'] } } } };
let server: Server;
let url: string;
let requests: { method: string; rpc?: string; auth?: string; args?: unknown }[];
let result: unknown;
let sse = false;
beforeEach(async () => {
  requests = []; sse = false;
  result = { content: [{ type: 'text', text: JSON.stringify({ as_dicts: [{ eng_title: `Headline ${key}`, article_url: 'https://publisher.test/story', source_name: 'Publisher', key_points: ['Evidence'], full_text: 'DROP ME' }] }) }] };
  server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const rpc = body ? JSON.parse(body) : {};
    requests.push({ method: req.method!, rpc: rpc.method, auth: req.headers['x-api-key'] as string, args: rpc.params?.arguments });
    if (!('id' in rpc)) { res.writeHead(202).end(); return; }
    const value = rpc.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : rpc.method === 'tools/list' ? { tools: [tool] } : result;
    const payload = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: value });
    res.writeHead(200, { 'Content-Type': sse && rpc.method === 'tools/call' ? 'text/event-stream' : 'application/json' });
    res.end(sse && rpc.method === 'tools/call' ? `event: message\ndata: ${payload}\n\n` : payload);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

describe('request-owned MCP operations through real HTTP', () => {
  it('discovers arbitrary case-sensitive tools, authenticates each POST and projects safe reporting', async () => {
    const source = mcpOperations(key, { url });
    expect((await source.tools()).map(t => t.name)).toEqual(['OddCamelTool']);
    const output = await source.call({ tool: 'OddCamelTool', args: {} });
    expect(output.articles[0]).toMatchObject({ title: 'Headline [redacted]', link: 'https://publisher.test/story', key_points: ['Evidence'], via: 'AskNews' });
    expect(JSON.stringify(output)).not.toContain(key);
    expect(JSON.stringify(output)).not.toContain('DROP ME');
    expect(requests.filter(r => r.rpc === 'tools/call')).toHaveLength(1);
    expect(requests.find(r => r.rpc === 'tools/call')?.args).toEqual({ return_type: 'dicts' });
    expect(requests.every(r => r.method === 'POST' && r.auth === key)).toBe(true);
  });
});
