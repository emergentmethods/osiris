import { Configuration, NewsApi, type SearchNewsRequest } from '@emergentmethods/asknews-typescript-sdk';
import { ASKNEWS_STATUS, mergeNews, safeNewsUrl, type AskNewsArticle, type AskNewsEntity, type AskNewsErrorCode } from './domain';

export class AskNewsError extends Error {
  constructor(readonly code: AskNewsErrorCode) { super(ASKNEWS_STATUS[code]); }
}
export function operatorConfigured(): boolean { return !!process.env.ASKNEWS_API_KEY?.trim(); }
export interface AskNews {
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
    const scrub = (value: unknown, max: number) => typeof value === 'string'
      ? value.replaceAll(key, '[redacted]').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max).trim() : '';
    const client = new NewsApi(new Configuration({ apiKey: key, basePath: process.env.ASKNEWS_API_BASE_URL?.replace(/\/$/, '') || undefined, fetchApi: async (url, init) => {
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
          const places = raw.geo_coordinates && typeof raw.geo_coordinates === 'object'
            ? Object.entries(raw.geo_coordinates).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) : [];
          const located = places.find(([name, value]) => {
            const point = value as { latitude?: unknown; longitude?: unknown } | null;
            return scrub(name, 200) && point && typeof point.latitude === 'number' && typeof point.longitude === 'number'
              && Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90
              && Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180;
          });
          const point = located?.[1] as { latitude: number; longitude: number } | undefined;
          const name = located ? scrub(located[0], 200) : '';
          const entities: Record<string, AskNewsEntity[]> = {};
          if (raw.wikidata_entities && typeof raw.wikidata_entities === 'object' && !Array.isArray(raw.wikidata_entities)) {
            for (const [group, values] of Object.entries(raw.wikidata_entities).slice(0, 20)) {
              if (!Array.isArray(values)) continue;
              const entries: AskNewsEntity[] = values.slice(0, 20).flatMap(value => {
                if (!value || typeof value !== 'object' || typeof value.qid !== 'string' || !/^Q[1-9][0-9]*$/.test(value.qid)
                  || typeof value.relevance !== 'number' || !Number.isFinite(value.relevance)) return [];
                const title = scrub(value.title, 200);
                return title ? [{ title, qid: value.qid, relevance: value.relevance }] : [];
              });
              const label = scrub(group, 100);
              if (label && entries.length) Object.defineProperty(entities, label, { value: entries, enumerable: true });
            }
          }
          items.push({ id: `asknews:${link}`, title, link, source: publisher, source_name: publisher, published: date,
            key_points: Array.isArray(raw.key_points) ? raw.key_points.slice(0, 5).map((p: unknown) => scrub(p, 520)).filter(Boolean) : [],
            via: 'AskNews', place: point ? { name, label: name, precision: 'mentioned-place' } : null,
            coords: point ? [point.latitude, point.longitude] : null,
            ...(Object.keys(entities).length ? { wikidata_entities: entities } : {}) });
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
  return {
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
