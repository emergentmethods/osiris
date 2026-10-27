import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/sourceCache', () => ({ cachedSource: () => async () => [] }));
vi.mock('@/lib/asknews', async () => {
  const original = await vi.importActual<typeof import('@/lib/asknews')>('@/lib/asknews');
  return { ...original, askNewsFor: vi.fn(original.askNewsFor) };
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('composes private results without changing the public feed, including missing and rejected keys', async () => {
  vi.stubEnv('ASKNEWS_API_KEY', '');
  const { GET } = await import('./route');
  const { askNewsFor } = await import('@/lib/asknews');
  const publicBody = await (await GET()).json();
  const article = { id: 'private', title: 'Private reporting', link: 'https://publisher.test/a', source: 'Publisher', source_name: 'Publisher', published: '2026-10-27T11:00:00Z', key_points: ['A point'], via: 'AskNews' as const, place: null, coords: null };
  vi.mocked(askNewsFor).mockReturnValueOnce({ latest: async () => [article] });
  const response = await GET(new Request('http://localhost/api/news?asknews=1', { headers: { 'X-AskNews-Key': 'reader-key' } }));
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect((await response.json()).news).toContainEqual(article);
  expect(await (await GET()).json()).toEqual(publicBody);
  for (const headers of [{}, { 'X-AskNews-Key': 'bad' }] as Record<string, string>[]) {
    const failed = await GET(new Request('http://localhost/api/news?asknews=1', { headers }));
    expect(failed.headers.get('cache-control')).toBe('private, no-store');
    expect((await failed.json()).asknews.status).toBe('X-AskNews-Key' in headers ? 'auth' : 'missing-key');
  }
});

it('probes operator capability without a search or public-feed build', async () => {
  vi.stubEnv('ASKNEWS_API_KEY', 'operator-key');
  const { GET } = await import('./route');
  const response = await GET(new Request('http://localhost/api/news?probe=asknews'));
  expect(await response.json()).toEqual({ configured: true });
  expect(response.headers.get('cache-control')).toBe('private, no-store');
});
