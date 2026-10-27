import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { POST, maxDuration } from './route';
const request = (body = '{"tool":"OddCamelTool","args":{}}', headers: Record<string, string> = {}) => new Request('http://localhost/api/asknews', { method: 'POST', headers: { host: 'localhost', ...headers }, body });
let server: Server;
let auth: string[];
beforeEach(async () => {
  auth = [];
  server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const rpc = JSON.parse(raw);
    auth.push(String(req.headers['x-api-key']));
    if (!('id' in rpc)) { res.writeHead(202).end(); return; }
    const result = rpc.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'offline', version: '1' } }
      : rpc.method === 'tools/list' ? { tools: [{ name: 'OddCamelTool', inputSchema: { type: 'object' } }] }
      : { content: [], structuredContent: { articles: [{ title: `Report ${req.headers['x-api-key']}`, url: 'https://publisher.test/story', key_points: ['A complete key point.'], full_text: 'FORBIDDEN FULL TEXT' }] } };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('ASKNEWS_MCP_URL', `http://127.0.0.1:${(server.address() as { port: number }).port}/`);
  vi.stubEnv('ASKNEWS_API_KEY', 'offline-operator-fixture');
});
afterEach(async () => { vi.unstubAllEnvs(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
describe('private AskNews action route over real local MCP HTTP', () => {
  it('selects reader and fallback credentials and projects safe output', async () => {
    for (const headers of [{ 'X-AskNews-Key': 'offline-reader-fixture' }, {}]) {
      auth.length = 0;
      const res = await POST(request(undefined, headers));
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect((await res.json()).articles).toEqual([expect.objectContaining({ title: 'Report [redacted]', key_points: ['A complete key point.'] })]);
      expect(auth.length).toBeGreaterThan(0);
      expect(new Set(auth)).toEqual(new Set([headers['X-AskNews-Key'] ?? 'offline-operator-fixture']));
    }
    expect(maxDuration).toBeGreaterThanOrEqual(90);
  });
  it('returns safe private missing-key and empty-header errors without fallback', async () => {
    for (const headers of [{ 'X-AskNews-Key': '' }, {}]) {
      if (!('X-AskNews-Key' in headers)) vi.stubEnv('ASKNEWS_API_KEY', '');
      const res = await POST(request(undefined, headers));
      expect(res.status).toBe(401);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(await res.json()).toMatchObject({ code: 'X-AskNews-Key' in headers ? 'auth' : 'missing-key' });
    }
    expect(auth).toEqual([]);
  });
  it('blocks disabled, cross-origin and oversized requests before upstream work', async () => {
    vi.stubEnv('OI_DISABLED', '1'); expect((await POST(request())).status).toBe(503);
    vi.stubEnv('OI_DISABLED', ''); expect((await POST(request('{}', { origin: 'https://evil.test' }))).status).toBe(403);
    expect((await POST(request('x'.repeat(5000)))).status).toBe(400);
    expect(auth).toEqual([]);
  });
});
