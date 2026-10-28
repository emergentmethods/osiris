export type AskNewsErrorCode = 'missing-key' | 'auth' | 'forbidden' | 'quota' | 'rate' | 'timeout' | 'cancelled' | 'unavailable' | 'bad-input' | 'invalid-response' | 'too-large';
export type AskNewsStatus = 'ok' | 'off' | 'loading' | 'stale' | AskNewsErrorCode;
export interface AskNewsPlace { name: string; label: string; precision: 'mentioned-place' }
export interface AskNewsEntity { title: string; qid: string; relevance: number }
export interface AskNewsArticle {
  id: string;
  title: string;
  source: string;
  source_name: string;
  published: string;
  key_points: string[];
  link: string;
  via: 'AskNews';
  place: AskNewsPlace | null;
  coords: [number, number] | null;
  wikidata_entities?: Record<string, AskNewsEntity[]>;
}
export const ASKNEWS_STATUS: Record<AskNewsStatus, string> = {
  ok: 'AskNews reporting is up to date.', off: 'AskNews is off.', loading: 'Loading AskNews reporting…',
  stale: 'AskNews unavailable. Showing earlier reporting for this key.',
  'missing-key': 'Add an AskNews key.', auth: 'AskNews rejected this key. Update your key.',
  forbidden: 'AskNews access is not available on this plan or wallet.', quota: 'AskNews usage limit reached.',
  rate: 'AskNews rate limit reached. Try again later.', timeout: 'AskNews timed out.', cancelled: 'AskNews request cancelled.',
  unavailable: 'AskNews is unavailable.', 'bad-input': 'Invalid AskNews request.',
  'invalid-response': 'AskNews returned an invalid response.', 'too-large': 'AskNews response exceeded the size limit.',
};
export function safeNewsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}
export function mergeNews<T extends { link?: string; published?: string; via?: string; also_via?: string }>(publicItems: readonly T[], privateItems: readonly T[]): T[] {
  const indices = new Map<string, number>();
  const items: T[] = [];
  for (const item of [...publicItems, ...privateItems]) {
    const url = safeNewsUrl(item.link);
    const existing = url ? indices.get(url) : undefined;
    if (existing !== undefined) {
      if (item.via === 'AskNews' && items[existing].via !== 'AskNews') items[existing] = { ...items[existing], also_via: 'AskNews' };
      continue;
    }
    if (url) indices.set(url, items.length);
    items.push(item);
  }
  return items.sort((a, b) => (Date.parse(b.published ?? '') || 0) - (Date.parse(a.published ?? '') || 0));
}

export class AskNewsError extends Error {
  constructor(readonly code: AskNewsErrorCode) { super(ASKNEWS_STATUS[code]); }
}
export function classifyAskNewsStatus(status: number): AskNewsErrorCode {
  const codes: Record<number, AskNewsErrorCode> = { 400: 'bad-input', 401: 'auth', 402: 'quota', 403: 'forbidden', 429: 'rate' };
  return codes[status] ?? 'unavailable';
}
