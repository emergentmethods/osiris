import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { POST } from './route';

const message = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
const request = (body: unknown, headers: Record<string, string> = {}) => new Request('http://localhost/api/mcp', {
  method: 'POST', headers: { host: 'localhost', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('private stateless MCP requests', () => {
  it('marks JSON, notifications, failures and streamed results private and no-store', async () => {
    const cases = [request(message), request({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      request(message, { origin: 'https://untrusted.example' }),
      request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'oi_predict', arguments: { question: 'Will the envoys agree?' } } }, { Accept: 'text/event-stream' })];
    for (const req of cases) {
      const response = await POST(req);
      expect(response.headers.get('cache-control')).toContain('private');
      expect(response.headers.get('cache-control')).toContain('no-store');
      await response.text();
    }
  });

  it('gives each POST its own opaque AskNews handle, including fallback and absent credentials', async () => {
    const auth: string[] = [];
    const server = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const rpc = JSON.parse(raw);
      auth.push(String(req.headers['x-api-key']));
      if (!('id' in rpc)) { res.writeHead(202).end(); return; }
      const result = rpc.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'offline', version: '1' } } : { tools: [] };
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    vi.stubEnv('ASKNEWS_MCP_URL', `http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    vi.stubEnv('ASKNEWS_API_KEY', 'offline-operator-fixture');
    const mcp = await import('@/lib/oi/mcp');
    const dispatch = vi.spyOn(mcp, 'handleMessage').mockImplementation(async (_msg, ctx) => {
      await ctx.creds.asknews!.tools();
      return { jsonrpc: '2.0', id: 1, result: {} };
    });
    try {
      await (await POST(request(message, { 'X-AskNews-Key': 'offline-first-reader' }))).text();
      expect(auth.length).toBeGreaterThan(0);
      expect(new Set(auth)).toEqual(new Set(['offline-first-reader']));
      auth.length = 0;
      await (await POST(request(message))).text();
      expect(new Set(auth)).toEqual(new Set(['offline-operator-fixture']));
      vi.stubEnv('ASKNEWS_API_KEY', '');
      auth.length = 0;
      await expect(POST(request(message))).rejects.toMatchObject({ code: 'missing-key' });
      expect(auth).toEqual([]);
      expect(dispatch).toHaveBeenCalledTimes(3);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
