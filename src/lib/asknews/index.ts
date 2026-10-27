import { Configuration, NewsApi, type SearchNewsRequest } from '@emergentmethods/asknews-typescript-sdk';
import { projectArticle } from './project';
import { mcpOperations } from './mcp';
import type { AskNewsOperations } from './mcp-domain';
import { AskNewsError, classifyAskNewsStatus, mergeNews, type AskNewsArticle } from './domain';

export { AskNewsError } from './domain';
export function operatorConfigured(): boolean { return !!process.env.ASKNEWS_API_KEY?.trim(); }
export interface AskNews extends AskNewsOperations {
  latest(signal?: AbortSignal): Promise<AskNewsArticle[]>;
  near(lat: number, lng: number, signal?: AbortSignal): Promise<AskNewsArticle[]>;
}

function setting(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function askNewsFor(headers: Headers): AskNews {
  const key = (headers.has('X-AskNews-Key') ? headers.get('X-AskNews-Key') : process.env.ASKNEWS_API_KEY)?.trim() ?? '';
  const search = async (params: SearchNewsRequest, size: number, callerSignal?: AbortSignal) => {
    if (!key) throw new AskNewsError(headers.has('X-AskNews-Key') ? 'auth' : 'missing-key');
    if (!/^[\x21-\x7e]{8,400}$/.test(key)) throw new AskNewsError('auth');
    const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(callerSignal ? [callerSignal] : [])]);
    const client = new NewsApi(new Configuration({ apiKey: key, basePath: process.env.ASKNEWS_API_BASE_URL?.replace(/\/$/, '') || undefined, fetchApi: async (url, init) => {
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
          if (bytes > 1_048_576) throw new AskNewsError('too-large');
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      return new Response(new Blob(chunks as BlobPart[]), { headers: { 'Content-Type': 'application/json' } });
    } }));
    try {
      const items: AskNewsArticle[] = [];
      for (let offset = 0; offset < size; offset += 100) {
        const result = await client.searchNewsRaw({ ...params, nArticles: Math.min(100, size - offset), offset }, { signal });
        const body = await result.raw.json();
        if (!Array.isArray(body.as_dicts)) throw new AskNewsError('invalid-response');
        for (const raw of body.as_dicts) {
          const article = projectArticle(raw, key);
          if (article) items.push(article);
        }
      }
      return mergeNews([], items);
    } catch (error) {
      if (callerSignal?.aborted) throw new AskNewsError('cancelled');
      if (signal.aborted) throw new AskNewsError('timeout');
      let cause: unknown = error;
      for (let i = 0; i < 3 && cause instanceof Error; i++) {
        if (cause instanceof AskNewsError) throw cause;
        cause = (cause as Error & { cause?: unknown }).cause;
      }
      throw new AskNewsError(error instanceof SyntaxError ? 'invalid-response' : 'unavailable');
    }
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
    latest(signal) {
      return search({
        timeFilter: 'pub_date', startTimestamp: Math.floor(Date.now() / 1000) - setting('ASKNEWS_FEED_WINDOW_SECONDS', 1800, 1, 604800),
        pageRank: setting('ASKNEWS_FEED_PAGE_RANK', 200000, 0, 1000000000), returnGeo: true,
        podcasts: 'include', returnType: 'dicts',
      }, setting('ASKNEWS_FEED_SIZE', 200, 1, 200), signal);
    },
    async near(lat, lng, signal) {
      if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180) throw new AskNewsError('bad-input');
      return search({ geoLat: lat, geoLon: lng, geoRadius: 50_000, hoursBack: 24, timeFilter: 'pub_date', returnGeo: true,
        podcasts: 'include', returnType: 'dicts' }, 10, signal);
    },
  };
}
