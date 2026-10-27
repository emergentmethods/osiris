import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { POST } from './route';

const message = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
const request = (body: unknown, headers: Record<string, string> = {}) => new Request('http://localhost/api/mcp', {
  method: 'POST', headers: { host: 'localhost', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
    const nativeFetch = globalThis.fetch;
    const { createDemoChat } = await import('@/lib/oi/demo');
    const demo = createDemoChat();
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1:')) return nativeFetch(input, init);
      if (url === 'https://api.openai.com/v1/chat/completions') {
        const body = JSON.parse(String(init?.body));
        const user = body.messages.find((m: { role: string }) => m.role === 'user')?.content ?? '';
        const out = user.includes('Plan the research') ? { text: '{"asknews":[]}' } : await demo({ user, system: '', json: true, maxTokens: 2000 });
        return Response.json({ choices: [{ message: { content: out.text } }], usage: {} });
      }
      return Response.json({ news: [], articles: [], query: { pages: [] } });
    });
    const predict = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'oi_predict', arguments: { question: 'Will the envoys agree by year end?', depth: 'quick', wait_seconds: 5 } } };
    const modelHeaders = { 'X-OI-Provider': 'openai', 'X-OI-Key': 'offline-model-fixture' };
    try {
      for (const headers of [{ ...modelHeaders, 'X-AskNews-Key': 'offline-first-reader' }, modelHeaders]) {
        auth.length = 0;
        const res = await POST(request(predict, headers));
        expect(res.headers.get('cache-control')).toBe('private, no-store');
        const body = await res.json();
        expect(['running', 'done']).toContain(body.result.structuredContent.status);
        const { getRun, waitForEnd } = await import('@/lib/oi/runs');
        const run = getRun(body.result.structuredContent.id)!;
        await waitForEnd(run, 20_000);
        expect(run.state.status).toBe('done');
        expect(run.events.filter(e => e.t === 'warn')).toEqual([]);
        expect(auth.length).toBeGreaterThan(0);
        expect(new Set(auth)).toEqual(new Set(['X-AskNews-Key' in headers ? headers['X-AskNews-Key'] : 'offline-operator-fixture']));
        expect(JSON.stringify(body)).not.toContain('offline-');
      }
      vi.stubEnv('ASKNEWS_API_KEY', '');
      auth.length = 0;
      const res = await POST(request(predict, modelHeaders));
      const data = (await res.json()).result.structuredContent;
      const { getRun, waitForEnd } = await import('@/lib/oi/runs');
      const run = getRun(data.id)!;
      await waitForEnd(run, 20_000);
      expect(run.state.status).toBe('done');
      expect(run.events.filter(e => e.t === 'warn')).toEqual([]);
      expect(auth).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
