import { afterEach, expect, it, vi } from 'vitest';
import { askNewsFor } from './index';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('uses the installed SDK for one private page without an offset and projects safe newest-first reporting', async () => {
  vi.stubEnv('ASKNEWS_API_KEY', 'operator-key');
  const calls: { url: URL; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return Response.json({ as_dicts: [
      { article_id: 'old', title: 'Old report', article_url: 'https://publisher.test/old', pub_date: '2026-10-27T10:00:00Z', domain_url: 'publisher.test', key_points: ['A key point'], full_text: 'SECRET FULL TEXT', image_url: 'https://images.test/a' },
      { article_id: 'new', title: 'New report', article_url: 'https://publisher.test/new', pub_date: '2026-10-27T11:00:00Z', domain_url: 'publisher.test' },
      { article_id: 'dup', title: 'Duplicate', article_url: 'https://publisher.test/old#fragment', pub_date: '2026-10-27T10:00:00Z' },
    ], offset: '0003d30d-cc08-4ead-8a0b-bafcefffa08a' });
  }));
  const items = await askNewsFor(new Headers({ 'X-AskNews-Key': 'reader-key' })).latest();
  expect(items.map(a => a.title)).toEqual(['New report', 'Old report']);
  // A filter-only search answers 400 to any offset, so the feed is one page.
  expect(calls).toHaveLength(1);
  for (const { url, init } of calls) {
    expect(url.origin).toBe('https://api.asknews.app');
    expect(url.pathname).toBe('/v1/news/search');
    expect(url.searchParams.has('offset')).toBe(false);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ n_articles: '100', time_filter: 'pub_date', page_rank: '200000', return_geo: 'true', podcasts: 'include', return_type: 'dicts' });
    expect(Number(url.searchParams.get('start_timestamp'))).toBeGreaterThan(Date.now() / 1000 - 1805);
    expect(url.searchParams.has('categories')).toBe(false);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer reader-key');
    expect(init.cache).toBe('no-store');
  }
  expect(JSON.stringify(items)).not.toMatch(/SECRET FULL TEXT|image_url|reader-key/);
  expect(items[1]).toMatchObject({ via: 'AskNews', source_name: 'publisher.test', key_points: ['A key point'], place: null, coords: null });
});

it('uses fallback only when the reader did not supply a key and never echoes errors', async () => {
  vi.stubEnv('ASKNEWS_API_KEY', 'operator-key');
  const fetcher = vi.fn<typeof fetch>(async () => new Response('reader-key upstream secret', { status: 401 }));
  vi.stubGlobal('fetch', fetcher);
  await expect(askNewsFor(new Headers({ 'X-AskNews-Key': 'reader-key' })).latest()).rejects.toMatchObject({ code: 'auth', message: 'AskNews rejected this key. Update your key.' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(askNewsFor(new Headers({ 'X-AskNews-Key': '' })).latest()).rejects.toMatchObject({ code: 'auth' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(askNewsFor(new Headers()).latest()).rejects.toMatchObject({ code: 'auth' });
  expect(new Headers(fetcher.mock.calls[1][1]?.headers).get('authorization')).toBe('Bearer operator-key');
});

it('honors self-hoster query overrides and keeps publication strings through a JSON round trip', async () => {
  vi.stubEnv('ASKNEWS_API_KEY', 'operator-key'); vi.stubEnv('ASKNEWS_FEED_SIZE', '12');
  vi.stubEnv('ASKNEWS_FEED_WINDOW_SECONDS', '7200'); vi.stubEnv('ASKNEWS_FEED_PAGE_RANK', '1000');
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ as_dicts: [{ title: 'A headline', article_url: 'https://publisher.test/a', pub_date: '2026-10-27T09:00:00Z', key_points: ['operator-key is redacted'] }] }));
  vi.stubGlobal('fetch', fetcher);
  const articles = JSON.parse(JSON.stringify(await askNewsFor(new Headers()).latest()));
  expect(articles[0].published).toBe('2026-10-27T09:00:00.000Z');
  expect(articles[0].key_points).toEqual(['[redacted] is redacted']);
  const params = new URL(String(fetcher.mock.calls[0][0])).searchParams;
  expect(params.get('n_articles')).toBe('12'); expect(params.get('page_rank')).toBe('1000');
  expect(Number(params.get('start_timestamp'))).toBeLessThan(Date.now() / 1000 - 7199);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('rejects oversized and malformed replies without returning upstream content', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('x'.repeat(1_048_577))).mockResolvedValueOnce(Response.json({ unexpected: true }));
  vi.stubGlobal('fetch', fetcher);
  const source = askNewsFor(new Headers({ 'X-AskNews-Key': 'reader-key' }));
  await expect(source.latest()).rejects.toMatchObject({ code: 'too-large' });
  await expect(source.latest()).rejects.toMatchObject({ code: 'invalid-response' });
});

it('preserves deterministic mentioned places and only fixture-supported Wikidata identities through raw JSON', async () => {
  vi.stubEnv('ASKNEWS_FEED_SIZE', '1');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ as_dicts: [{
    title: 'Placed reporting', article_url: 'https://publisher.test/places',
    geo_coordinates: { Zurich: { latitude: 47.37, longitude: 8.54 }, Berlin: { latitude: 52.52, longitude: 13.405 }, Bad: { latitude: 91, longitude: 0 } },
    wikidata_entities: { companies: [{ title: 'Example, Inc.', qid: 'Q123', relevance: 0.95, description: 'Do not retain', source_mention: 'Example' }],
      people: [], topics: [{ title: 'Wrong shape', id: 'Q456' }, { title: 'Invalid id', qid: 'not-a-qid', relevance: 1 }] },
  }, { title: 'QID alone', article_url: 'https://publisher.test/qid', wikidata_entities: { topics: [{ title: 'Example topic', qid: 'Q789', relevance: 0.75 }] } }] })));
  const items = JSON.parse(JSON.stringify(await askNewsFor(new Headers({ 'X-AskNews-Key': 'reader-key' })).latest()));
  expect(items[0]).toMatchObject({ place: { name: 'Berlin', label: 'Berlin', precision: 'mentioned-place' }, coords: [52.52, 13.405],
    wikidata_entities: { companies: [{ title: 'Example, Inc.', qid: 'Q123', relevance: 0.95 }] } });
  expect(items[0].wikidata_entities.topics).toBeUndefined();
  expect(JSON.stringify(items)).not.toContain('Do not retain');
  expect(items[1]).toMatchObject({ place: null, coords: null });
});

it('searches nearby through the real SDK using meters and configurable fake upstream without feed overrides', async () => {
  vi.stubEnv('ASKNEWS_API_KEY', 'operator-key');
  vi.stubEnv('ASKNEWS_API_BASE_URL', 'http://127.0.0.1:45678');
  vi.stubEnv('ASKNEWS_FEED_SIZE', '100'); vi.stubEnv('ASKNEWS_FEED_WINDOW_SECONDS', '1');
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ as_dicts: [] }));
  vi.stubGlobal('fetch', fetcher);
  await askNewsFor(new Headers()).near(35.68, 139.69);
  const url = new URL(String(fetcher.mock.calls[0][0]));
  expect(url.origin).toBe('http://127.0.0.1:45678');
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ geo_lat: '35.68', geo_lon: '139.69', geo_radius: '50000', hours_back: '24', n_articles: '10', time_filter: 'pub_date', return_geo: 'true', return_type: 'dicts' });
  expect(url.searchParams.has('start_timestamp')).toBe(false);
  expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer operator-key');
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(askNewsFor(new Headers()).near(NaN, 0)).rejects.toMatchObject({ code: 'bad-input' });
  await expect(askNewsFor(new Headers()).near(0, 181)).rejects.toMatchObject({ code: 'bad-input' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([null, {}, { geo_coordinates: { Berlin: { latitude: '52.52', longitude: 13.4 } } }, { geo_coordinates: { Berlin: { latitude: Infinity, longitude: 13.4 } } }])('does not fabricate a pin from absent or invalid coordinates (%j)', async value => {
  vi.stubEnv('ASKNEWS_FEED_SIZE', '1');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ as_dicts: [{ title: 'No position', article_url: 'https://publisher.test/no-place', ...value }] })));
  expect((await askNewsFor(new Headers({ 'X-AskNews-Key': 'reader-key' })).latest())[0]).toMatchObject({ place: null, coords: null });
});

it('cancels the nearby SDK request without a retry or leaked upstream exception', async () => {
  const controller = new AbortController();
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('reader-key cancelled upstream')));
  }));
  vi.stubGlobal('fetch', fetcher);
  const pending = askNewsFor(new Headers({ 'X-AskNews-Key': 'reader-key' })).near(10, 20, controller.signal);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1)); controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'cancelled', message: 'AskNews request cancelled.' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

const storyPage = (ids: string[], offset: string | null, extra: Record<string, unknown> = {}) => ({ stories: ids.map(id => ({
  uuid: id, updated_ts: 1_793_000_000, countries: { US: 3, Unknown: 9 }, categories: ['Politics'], locations: ['Gaza'],
  updates: [{ headline: `Story ${id}`, story: 'What happened, told by operator-key.', story_update_ts: 1_793_000_000, key_takeaways: ['A point [1][2].'], n_articles: 40, locations: ['Rafah', 'Gaza'],
    cluster_articles: [{ article_id: `${id}-1`, eng_title: 'Cluster article', article_url: `https://publisher.test/${id}/1`, pub_date: '2026-10-27T10:00:00Z', domain_url: 'publisher.test', full_text: 'SECRET FULL TEXT' }],
    prompt_articles: [{ article_id: `${id}-1`, eng_title: 'Cluster article', article_url: `https://publisher.test/${id}/1#frag`, pub_date: '2026-10-27T10:00:00Z' }, { article_id: `${id}-2`, title: 'Prompt article', article_url: `https://publisher.test/${id}/2`, pub_date: '2026-10-27T09:00:00Z', geo_coordinates: { Rafah: { latitude: 31.29, longitude: 34.25 } } }],
    ...extra }],
}) ), offset });
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

it('pages stories by the returned cursor, keeps each story once at its newest update, and stops at the last page', async () => {
  vi.stubEnv('ASKNEWS_API_KEY', 'operator-key'); vi.stubEnv('ASKNEWS_STORIES_SIZE', '25'); vi.stubEnv('ASKNEWS_STORIES_ARTICLES', '7');
  const calls: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(String(input)); calls.push(url);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer operator-key');
    const offset = url.searchParams.get('offset');
    if (!offset) return Response.json(storyPage([uuid(1), uuid(2), uuid(3), uuid(4), uuid(5), uuid(6), uuid(7), uuid(8), uuid(9), uuid(10)], 'cursor-2'));
    if (offset === 'cursor-2') return Response.json(storyPage([uuid(10), uuid(11), uuid(12)], 'cursor-3'));
    return Response.json(storyPage([], null));
  }));
  const stories = await askNewsFor(new Headers()).stories();
  expect(calls.map(u => u.searchParams.get('offset'))).toEqual([null, 'cursor-2', 'cursor-3']);
  for (const url of calls) {
    expect(url.pathname).toBe('/v1/stories');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ limit: '10', expand_updates: 'true', max_updates: '1', max_articles: '7', obj_type: 'story_update' });
    expect(Number(url.searchParams.get('start_timestamp'))).toBeGreaterThan(Date.now() / 1000 - 86405);
  }
  expect(stories).toHaveLength(12);
  expect(stories.map(s => s.id)).toContain(uuid(10));
  const first = stories[0];
  expect(first).toMatchObject({ headline: `Story ${first.id}`, key_takeaways: ['A point.'], countries: ['US'], locations: ['Rafah', 'Gaza'], n_articles: 40, via: 'AskNews', place: { name: 'Rafah', precision: 'mentioned-place' }, coords: [31.29, 34.25] });
  expect(first.articles.map(a => a.title)).toEqual(['Cluster article', 'Prompt article']);
  expect(first.summary).toBe('What happened, told by [redacted].');
  expect(JSON.stringify(stories)).not.toMatch(/SECRET FULL TEXT|operator-key/);
});

it('stops the stories pull at the configured size and maps upstream failures to codes', async () => {
  vi.stubEnv('ASKNEWS_API_KEY', 'operator-key'); vi.stubEnv('ASKNEWS_STORIES_SIZE', '10');
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(storyPage(Array.from({ length: 10 }, (_, i) => uuid(i + 1)), 'cursor-2')));
  vi.stubGlobal('fetch', fetcher);
  expect(await askNewsFor(new Headers()).stories()).toHaveLength(10);
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockResolvedValueOnce(new Response('quota', { status: 402 }));
  await expect(askNewsFor(new Headers()).stories()).rejects.toMatchObject({ code: 'quota' });
  await expect(askNewsFor(new Headers({ 'X-AskNews-Key': '' })).stories()).rejects.toMatchObject({ code: 'auth' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
