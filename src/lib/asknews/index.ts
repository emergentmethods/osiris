import { Configuration, NewsApi, StoriesApi, type SearchNewsRequest } from '@emergentmethods/asknews-typescript-sdk';
import { projectArticle } from './project';
import { projectStory, type AskNewsStory } from './stories';
import { mcpOperations } from './mcp';
import type { AskNewsOperations } from './mcp-domain';
import { AskNewsError, classifyAskNewsStatus, mergeNews, type AskNewsArticle } from './domain';

export { AskNewsError } from './domain';
export type { AskNewsStory } from './stories';
export function operatorConfigured(): boolean { return !!process.env.ASKNEWS_API_KEY?.trim(); }
export interface AskNews extends AskNewsOperations {
  latest(signal?: AbortSignal): Promise<AskNewsArticle[]>;
  near(lat: number, lng: number, signal?: AbortSignal): Promise<AskNewsArticle[]>;
  /** The narratives AskNews updated in the stories window, newest first, each with its latest articles. */
  stories(signal?: AbortSignal): Promise<AskNewsStory[]>;
}

function setting(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function askNewsFor(headers: Headers): AskNews {
  const key = (headers.has('X-AskNews-Key') ? headers.get('X-AskNews-Key') : process.env.ASKNEWS_API_KEY)?.trim() ?? '';
  const checkKey = () => {
    if (!key) throw new AskNewsError(headers.has('X-AskNews-Key') ? 'auth' : 'missing-key');
    if (!/^[\x21-\x7e]{8,400}$/.test(key)) throw new AskNewsError('auth');
  };
  /** An SDK configuration whose fetch classifies failures, caps the body and never follows a redirect elsewhere. */
  const configuration = (signal: AbortSignal, maxBytes: number) => new Configuration({ apiKey: key, basePath: process.env.ASKNEWS_API_BASE_URL?.replace(/\/$/, '') || undefined, fetchApi: async (url, init) => {
    const response = await fetch(url, { ...init, signal, cache: 'no-store' });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AskNewsError(classifyAskNewsStatus(response.status));
    }
    const reader = response.body?.getReader();
    if (!reader) throw new AskNewsError('invalid-response');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new AskNewsError('too-large');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    return new Response(new Blob(chunks as BlobPart[]), { headers: { 'Content-Type': 'application/json' } });
  } });
  /** Maps whatever an SDK call threw to one AskNews error code. */
  const classify = (error: unknown, signal: AbortSignal, callerSignal?: AbortSignal): AskNewsError => {
    if (callerSignal?.aborted) return new AskNewsError('cancelled');
    if (signal.aborted) return new AskNewsError('timeout');
    let cause: unknown = error;
    for (let i = 0; i < 3 && cause instanceof Error; i++) {
      if (cause instanceof AskNewsError) return cause;
      cause = (cause as Error & { cause?: unknown }).cause;
    }
    return new AskNewsError(error instanceof SyntaxError ? 'invalid-response' : 'unavailable');
  };
  const search = async (params: SearchNewsRequest, size: number, callerSignal?: AbortSignal) => {
    checkKey();
    const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(callerSignal ? [callerSignal] : [])]);
    const client = new NewsApi(configuration(signal, 1_048_576));
    try {
      /* One page only. A search with no query or geo filter answers 400 to any
         offset, numeric or the cursor it returned, and a page holds at most
         100 articles. */
      const result = await client.searchNewsRaw({ ...params, nArticles: Math.min(100, size) }, { signal });
      const body = await result.raw.json();
      if (!Array.isArray(body.as_dicts)) throw new AskNewsError('invalid-response');
      const items: AskNewsArticle[] = [];
      for (const raw of body.as_dicts) {
        const article = projectArticle(raw, key);
        if (article) items.push(article);
      }
      return mergeNews([], items);
    } catch (error) {
      throw classify(error, signal, callerSignal);
    }
  };
  /**
   * Stories come ten to a page and page by the cursor each page returns, so
   * a hundred is up to ten calls in sequence. The same story can head
   * several pages when it was updated more than once in the window; it is
   * kept once, at the first update seen, which is the newest.
   */
  const stories = async (callerSignal?: AbortSignal) => {
    checkKey();
    const size = setting('ASKNEWS_STORIES_SIZE', 100, 1, 100);
    const perStory = setting('ASKNEWS_STORIES_ARTICLES', 5, 1, 20);
    const signal = AbortSignal.any([AbortSignal.timeout(40_000), ...(callerSignal ? [callerSignal] : [])]);
    const client = new StoriesApi(configuration(signal, 4_194_304));
    const startTimestamp = Math.floor(Date.now() / 1000) - setting('ASKNEWS_STORIES_WINDOW_SECONDS', 86400, 1, 604800);
    const found = new Map<string, AskNewsStory>();
    let offset: string | undefined;
    try {
      for (let page = 0; page < Math.ceil(size / 10) && found.size < size; page++) {
        const result = await client.getStoriesRaw({
          startTimestamp, limit: 10, expandUpdates: true, maxUpdates: 1, maxArticles: perStory, objType: ['story_update'],
          ...(offset ? { offset } : {}),
        }, { signal });
        const body = await result.raw.json();
        if (!Array.isArray(body.stories)) throw new AskNewsError('invalid-response');
        for (const raw of body.stories) {
          const story = projectStory(raw, key, perStory);
          if (story && !found.has(story.id) && found.size < size) found.set(story.id, story);
        }
        if (!body.stories.length || typeof body.offset !== 'string' || !body.offset) break;
        offset = body.offset;
      }
    } catch (error) {
      throw classify(error, signal, callerSignal);
    }
    return [...found.values()].sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
  };
  const mcp = mcpOperations(key);
  return {
    ...mcp,
    tools(signal) {
      if (!key && headers.has('X-AskNews-Key')) return Promise.reject(new AskNewsError('auth'));
      return mcp.tools(signal);
    },
    call(call, signal) {
      if (!key && headers.has('X-AskNews-Key')) return Promise.reject(new AskNewsError('auth'));
      return mcp.call(call, signal);
    },
    stories,
    latest(signal) {
      return search({
        timeFilter: 'pub_date', startTimestamp: Math.floor(Date.now() / 1000) - setting('ASKNEWS_FEED_WINDOW_SECONDS', 1800, 1, 604800),
        pageRank: setting('ASKNEWS_FEED_PAGE_RANK', 200000, 0, 1000000000), returnGeo: true,
        podcasts: 'include', returnType: 'dicts',
      }, setting('ASKNEWS_FEED_SIZE', 100, 1, 100), signal);
    },
    async near(lat, lng, signal) {
      if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180) throw new AskNewsError('bad-input');
      return search({ geoLat: lat, geoLon: lng, geoRadius: 50_000, hoursBack: 24, timeFilter: 'pub_date', returnGeo: true,
        podcasts: 'include', returnType: 'dicts' }, 10, signal);
    },
  };
}
