import { afterEach, describe, expect, it, vi } from 'vitest';
const { source, owner } = vi.hoisted(() => {
  const source = { call: vi.fn<(call: unknown, signal?: AbortSignal) => Promise<{ articles: []; notes: [] }>>(async () => ({ articles: [], notes: [] })), tools: vi.fn(async () => []), scrub: (s: string) => s };
  return { source, owner: vi.fn<(headers: Headers) => typeof source>(() => source) };
});
vi.mock('@/lib/asknews/operations', () => ({ askNewsOperationsFor: owner }));
import { POST, maxDuration } from './route';
const request = (body = '{}', headers: Record<string, string> = {}) => new Request('http://localhost/api/asknews', { method: 'POST', headers: { host: 'localhost', ...headers }, body });
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe('private AskNews action route', () => {
  it('passes headers privately and supports a 90-second call', async () => {
    const res = await POST(request('{"tool":"OddCamelTool","args":{}}', { 'X-AskNews-Key': 'test-private-key' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(owner.mock.calls[0][0].get('X-AskNews-Key')).toBe('test-private-key');
    expect(source.call.mock.calls[0][0]).toEqual({ tool: 'OddCamelTool', args: {} });
    expect(await res.text()).not.toContain('test-private-key');
    expect(maxDuration).toBeGreaterThanOrEqual(90);
  });
  it('blocks disabled, cross-origin and oversized requests without executing', async () => {
    vi.stubEnv('OI_DISABLED', '1'); expect((await POST(request())).status).toBe(503);
    vi.stubEnv('OI_DISABLED', ''); expect((await POST(request('{}', { origin: 'https://evil.test' }))).status).toBe(403);
    expect((await POST(request('x'.repeat(5000)))).status).toBe(400);
    expect(source.call).not.toHaveBeenCalled();
  });
});
