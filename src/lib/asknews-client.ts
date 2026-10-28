import { mergeNews, type AskNewsStatus } from './asknews/domain';
import type { AskNewsStory } from './asknews/stories';
const SLOT = 'osiris.asknews.key';
const CHANGED = 'osiris:asknews-key';
export interface AskNewsKeyState { key: string; remember: boolean }
let volatileKey: AskNewsKeyState = { key: '', remember: false };
export function loadAskNewsKey(): AskNewsKeyState {
  if (typeof window === 'undefined') return { key: '', remember: false };
  try {
    const local = window.localStorage.getItem(SLOT);
    const session = window.sessionStorage.getItem(SLOT);
    return local ? { key: local, remember: true } : session ? { key: session, remember: false } : volatileKey;
  } catch { return volatileKey; }
}
export function saveAskNewsKey(key: string, remember: boolean): void {
  volatileKey = { key: key.trim(), remember };
  try {
    window.localStorage.removeItem(SLOT); window.sessionStorage.removeItem(SLOT);
    if (volatileKey.key) (remember ? window.localStorage : window.sessionStorage).setItem(SLOT, volatileKey.key);
  } catch { /* Storage can be disabled. The key remains in this tab's memory. */ }
  window.dispatchEvent(new Event(CHANGED));
}
export function forgetAskNewsKey(): void { saveAskNewsKey('', false); }
export function subscribeAskNewsKey(changed: () => void): () => void {
  const storageChanged = (event: Event) => {
    if ((event as StorageEvent).key === SLOT || (event as StorageEvent).key === null) { volatileKey = { key: '', remember: false }; changed(); }
  };
  window.addEventListener(CHANGED, changed); window.addEventListener('storage', storageChanged);
  return () => { window.removeEventListener(CHANGED, changed); window.removeEventListener('storage', storageChanged); };
}
export function askNewsHeaders(): Record<string, string> {
  const { key } = loadAskNewsKey(); return key ? { 'X-AskNews-Key': key } : {};
}
export interface DashboardNewsItem { id?: string; title?: string; published?: string; link?: string; via?: string; also_via?: string; place?: unknown }
export interface DashboardNewsBody {
  news: DashboardNewsItem[];
  sources?: unknown[];
  timestamp?: string;
  asknews?: { status: AskNewsStatus; count?: number };
}
export function createNewsLoader(write: (body: DashboardNewsBody) => void) {
  let generation = 0;
  let controller: AbortController | undefined;
  let enabled = false;
  let headers: Record<string, string> = {};
  let body: DashboardNewsBody = { news: [] };
  const publicOnly = (items: DashboardNewsItem[]) => items.filter(n => n.via !== 'AskNews').map(n => { const copy = { ...n }; delete copy.also_via; return copy; });
  const publish = (next: DashboardNewsBody) => { body = next; write(next); };
  const invalidate = () => { generation++; controller?.abort(); };
  return {
    configure(on: boolean, nextHeaders: Record<string, string>) {
      invalidate(); enabled = on; headers = nextHeaders;
      publish({ ...body, news: publicOnly(body.news), asknews: { status: on ? 'loading' : 'off', count: 0 } });
    },
    async load(skipWhenHidden = false) {
      if (skipWhenHidden && typeof document !== 'undefined' && document.hidden) return;
      invalidate(); const current = generation;
      controller = new AbortController();
      const applyFailure = (status: AskNewsStatus) => {
        if (current !== generation) return;
        const retain = enabled && !['auth', 'missing-key', 'forbidden', 'quota'].includes(status) && body.news.some(n => n.via === 'AskNews');
        publish({ ...body, news: retain ? body.news : publicOnly(body.news), asknews: { status: retain ? 'stale' : status } });
      };
      try {
        const response = await fetch(enabled ? '/api/news?asknews=1' : '/api/news', { headers: enabled ? headers : {}, signal: controller.signal, cache: 'no-store' });
        if (current !== generation) return;
        if (!response.ok) { applyFailure('unavailable'); return; }
        const next: DashboardNewsBody = await response.json();
        if (current !== generation) return;
        if (enabled && next.asknews?.status !== 'ok') {
          const status = next.asknews?.status ?? 'unavailable';
          const previous = body.news.filter(n => n.via === 'AskNews');
          publish({ ...next, news: mergeNews(next.news.filter(n => n.via !== 'AskNews'), previous) });
          applyFailure(status);
        } else publish(next);
      } catch { if (!controller?.signal.aborted) applyFailure('unavailable'); }
    },
    dispose: invalidate,
  };
}

export interface DashboardStoriesBody {
  stories: AskNewsStory[];
  timestamp?: string;
  asknews?: { status: AskNewsStatus; count?: number };
}
/**
 * Reads /api/stories for the AskNews layer, the way createNewsLoader reads
 * the feed: a stale result stays up through a transient failure, a rejected
 * or missing key clears it, and turning the source off empties it at once.
 */
export function createStoriesLoader(write: (body: DashboardStoriesBody) => void) {
  let generation = 0;
  let controller: AbortController | undefined;
  let enabled = false;
  let headers: Record<string, string> = {};
  let body: DashboardStoriesBody = { stories: [] };
  const publish = (next: DashboardStoriesBody) => { body = next; write(next); };
  const invalidate = () => { generation++; controller?.abort(); };
  return {
    configure(on: boolean, nextHeaders: Record<string, string>) {
      invalidate(); enabled = on; headers = nextHeaders;
      publish({ stories: [], asknews: { status: on ? 'loading' : 'off', count: 0 } });
    },
    async load(skipWhenHidden = false) {
      if (!enabled) return;
      if (skipWhenHidden && typeof document !== 'undefined' && document.hidden) return;
      invalidate(); const current = generation;
      controller = new AbortController();
      const applyFailure = (status: AskNewsStatus) => {
        if (current !== generation) return;
        const retain = !['auth', 'missing-key', 'forbidden', 'quota'].includes(status) && body.stories.length > 0;
        publish({ ...body, stories: retain ? body.stories : [], asknews: { status: retain ? 'stale' : status, count: retain ? body.stories.length : 0 } });
      };
      try {
        const response = await fetch('/api/stories', { headers, signal: controller.signal, cache: 'no-store' });
        if (current !== generation) return;
        if (!response.ok) { applyFailure('unavailable'); return; }
        const next: DashboardStoriesBody = await response.json();
        if (current !== generation) return;
        if (next.asknews?.status !== 'ok') applyFailure(next.asknews?.status ?? 'unavailable');
        else publish({ ...next, stories: Array.isArray(next.stories) ? next.stories : [] });
      } catch { if (!controller?.signal.aborted) applyFailure('unavailable'); }
    },
    dispose: invalidate,
  };
}
