import { Configuration, NewsApi, type SearchNewsRequest } from '@emergentmethods/asknews-typescript-sdk';
import { ASKNEWS_STATUS, mergeNews, safeNewsUrl, type AskNewsArticle, type AskNewsErrorCode } from './domain';

export class AskNewsError extends Error {
  constructor(readonly code: AskNewsErrorCode) { super(ASKNEWS_STATUS[code]); }
}
export function operatorConfigured(): boolean { return !!process.env.ASKNEWS_API_KEY?.trim(); }
export interface AskNews { latest(signal?: AbortSignal): Promise<AskNewsArticle[]> }

function setting(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function askNewsFor(headers: Headers): AskNews {
  const key = (headers.has('X-AskNews-Key') ? headers.get('X-AskNews-Key') : process.env.ASKNEWS_API_KEY)?.trim() ?? '';
  return {
    async latest(callerSignal) {
      if (!key) throw new AskNewsError(headers.has('X-AskNews-Key') ? 'auth' : 'missing-key');
      if (!/^[\x21-\x7e]{8,400}$/.test(key)) throw new AskNewsError('auth');
      const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(callerSignal ? [callerSignal] : [])]);
      const scrub = (value: unknown, max: number) => typeof value === 'string'
        ? value.replaceAll(key, '[redacted]').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max).trim() : '';
      const client = new NewsApi(new Configuration({ apiKey: key, fetchApi: async (url, init) => {
        const response = await fetch(url, { ...init, signal, cache: 'no-store' });
        if (!response.ok) {
          await response.body?.cancel();
          const codes: Record<number, AskNewsErrorCode> = { 400: 'bad-input', 401: 'auth', 402: 'quota', 403: 'forbidden', 429: 'rate' };
          throw new AskNewsError(codes[response.status] ?? 'unavailable');
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
      const size = setting('ASKNEWS_FEED_SIZE', 200, 1, 200);
      const params: SearchNewsRequest = {
        timeFilter: 'pub_date', startTimestamp: Math.floor(Date.now() / 1000) - setting('ASKNEWS_FEED_WINDOW_SECONDS', 1800, 1, 604800),
        pageRank: setting('ASKNEWS_FEED_PAGE_RANK', 200000, 0, 1000000000), returnGeo: true,
        podcasts: 'include', returnType: 'dicts',
      };
      try {
        const items: AskNewsArticle[] = [];
        for (let offset = 0; offset < size; offset += 100) {
          const result = await client.searchNewsRaw({ ...params, nArticles: Math.min(100, size - offset), offset }, { signal });
          const body = await result.raw.json();
          if (!Array.isArray(body.as_dicts)) throw new AskNewsError('invalid-response');
          for (const raw of body.as_dicts) {
            if (!raw || typeof raw !== 'object') continue;
            const link = safeNewsUrl(raw.article_url);
            const title = scrub(raw.eng_title || raw.title, 520);
            if (!link || link.includes(key) || !title) continue;
            const publisher = scrub(raw.source_name || raw.domain_url || new URL(link).hostname, 200);
            const date = typeof raw.pub_date === 'string' && Number.isFinite(Date.parse(raw.pub_date)) ? new Date(raw.pub_date).toISOString() : '';
            items.push({ id: `asknews:${link}`, title, link, source: publisher, source_name: publisher, published: date,
              key_points: Array.isArray(raw.key_points) ? raw.key_points.slice(0, 5).map((p: unknown) => scrub(p, 520)).filter(Boolean) : [],
              via: 'AskNews', place: null, coords: null });
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
    },
  };
}
