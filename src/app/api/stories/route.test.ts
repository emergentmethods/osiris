import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/asknews', async () => {
  const original = await vi.importActual<typeof import('@/lib/asknews')>('@/lib/asknews');
  return { ...original, askNewsFor: vi.fn(original.askNewsFor) };
});
vi.mock('@/lib/asknews/story-places', () => ({ placeStories: vi.fn(async () => {}) }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

it('answers privately with placed stories, and with a status code instead of a body on failure', async () => {
  vi.stubEnv('ASKNEWS_API_KEY', '');
  const { GET } = await import('./route');
  const { askNewsFor, AskNewsError } = await import('@/lib/asknews');
  const { placeStories } = await import('@/lib/asknews/story-places');
  const story = { id: 'u', headline: 'A story', summary: '', key_takeaways: [], updated: '2026-10-28T00:00:00.000Z', categories: [], locations: ['Gaza'], countries: [], n_articles: 3, articles: [], via: 'AskNews' as const, place: null, coords: null };
  const client = { latest: async () => [], near: async () => [], stories: async () => [story], tools: async () => [], call: async () => ({ articles: [], notes: [] }), scrub: (t: string) => t };
  vi.mocked(askNewsFor).mockReturnValueOnce(client);
  const ok = await GET(new Request('http://localhost/api/stories', { headers: { 'X-AskNews-Key': 'reader-key' } }));
  expect(ok.headers.get('cache-control')).toBe('private, no-store');
  expect(await ok.json()).toMatchObject({ stories: [story], asknews: { status: 'ok', count: 1 } });
  expect(placeStories).toHaveBeenCalledWith([story]);
  vi.mocked(askNewsFor).mockReturnValueOnce({ ...client, stories: async () => { throw new AskNewsError('rate'); } });
  expect(await (await GET(new Request('http://localhost/api/stories'))).json()).toMatchObject({ stories: [], asknews: { status: 'rate', count: 0 } });
  const missing = await GET(new Request('http://localhost/api/stories'));
  expect((await missing.json()).asknews.status).toBe('missing-key');
});
