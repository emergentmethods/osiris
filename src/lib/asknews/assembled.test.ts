import { afterEach, expect, it, vi } from 'vitest';
import { askNewsFor } from './index';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('composes request-private MCP operations with reader precedence and operator fallback', async () => {
  vi.stubEnv('ASKNEWS_API_KEY', 'operator-fixture-key');
  const keys: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
    keys.push(new Headers(init?.headers).get('X-API-Key') ?? '');
    const rpc = JSON.parse(String(init?.body));
    if (!('id' in rpc)) return new Response(null, { status: 202 });
    const result = rpc.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } : { tools: [] };
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
  }));
  const reader = askNewsFor(new Headers({ 'X-AskNews-Key': 'reader-fixture-key' }));
  await expect(reader.tools()).resolves.toEqual([]);
  expect(keys.every(key => key === 'reader-fixture-key')).toBe(true);
  expect(reader.scrub('reader-fixture-key')).toBe('[redacted]');
  keys.length = 0;
  await expect(askNewsFor(new Headers()).tools()).resolves.toEqual([]);
  expect(keys.every(key => key === 'operator-fixture-key')).toBe(true);
  await expect(askNewsFor(new Headers({ 'X-AskNews-Key': '' })).tools()).rejects.toMatchObject({ code: 'auth' });
});
