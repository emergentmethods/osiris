import { afterEach, expect, it, vi } from 'vitest';
import { askNewsFor } from './index';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('uses the installed SDK for two private pages and projects safe newest-first reporting', async () => {
  vi.stubEnv('ASKNEWS_API_KEY', 'operator-key');
  const calls: { url: URL; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return Response.json({ dicts: url.searchParams.get('offset') === '0' ? [
      { article_id: 'old', title: 'Old report', article_url: 'https://publisher.test/old', pub_date: '2026-10-27T10:00:00Z', domain_url: 'publisher.test', key_points: ['A key point'], full_text: 'SECRET FULL TEXT', image_url: 'https://images.test/a' },
    ] : [
      { article_id: 'new', title: 'New report', article_url: 'https://publisher.test/new', pub_date: '2026-10-27T11:00:00Z', domain_url: 'publisher.test' },
      { article_id: 'dup', title: 'Duplicate', article_url: 'https://publisher.test/old#fragment', pub_date: '2026-10-27T10:00:00Z' },
    ] });
  }));
  const items = await askNewsFor(new Headers({ 'X-AskNews-Key': 'reader-key' })).latest();
  expect(items.map(a => a.title)).toEqual(['New report', 'Old report']);
  expect(calls.map(c => c.url.searchParams.get('offset'))).toEqual(['0', '100']);
  for (const { url, init } of calls) {
    expect(url.pathname).toBe('/v1/news/search');
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
  const fetcher = vi.fn(async () => new Response('reader-key upstream secret', { status: 401 }));
  vi.stubGlobal('fetch', fetcher);
  await expect(askNewsFor(new Headers({ 'X-AskNews-Key': 'reader-key' })).latest()).rejects.toMatchObject({ code: 'auth', message: 'AskNews rejected this key. Update your key.' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(askNewsFor(new Headers({ 'X-AskNews-Key': '' })).latest()).rejects.toMatchObject({ code: 'auth' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(askNewsFor(new Headers()).latest()).rejects.toMatchObject({ code: 'auth' });
  expect(new Headers(fetcher.mock.calls[1][1].headers).get('authorization')).toBe('Bearer operator-key');
});
