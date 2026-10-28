import type { AskNewsArticle, AskNewsStatus } from './asknews/domain';

export interface RegionDossier {
  coordinates?: { lat: number; lng: number };
  location?: { display_name?: string };
  country?: { name: string; flag?: string; capital?: string; population?: number; subregion?: string; region?: string; languages?: string[]; area?: number } | null;
  head_of_state?: { name: string; position: string } | null;
  wikipedia?: { title?: string; extract?: string; thumbnail?: string } | null;
  asknews?: { status: AskNewsStatus; articles: AskNewsArticle[] };
}
export interface DossierState { body: RegionDossier | null; loading: boolean; error: boolean }

export function createDossierLoader(write: (state: DossierState) => void) {
  let generation = 0;
  let controller: AbortController | undefined;
  let enabled = false;
  let headers: Record<string, string> = {};
  let state: DossierState = { body: null, loading: false, error: false };
  const publish = (next: DossierState) => { state = next; write(next); };
  const invalidate = () => { generation++; controller?.abort(); };
  return {
    configure(on: boolean, nextHeaders: Record<string, string>) {
      invalidate(); enabled = on; headers = { ...nextHeaders };
      const body = state.body ? { ...state.body } : null;
      if (body) delete body.asknews;
      publish({ body, loading: false, error: false });
    },
    async open(coords: { lat: number; lng: number }) {
      invalidate(); const current = generation;
      const sameLocation = state.body?.coordinates?.lat === coords.lat && state.body.coordinates.lng === coords.lng;
      const previous = sameLocation ? state.body : null;
      controller = new AbortController();
      publish({ body: previous, loading: true, error: false });
      try {
        const response = await fetch(`/api/region-dossier?lat=${coords.lat}&lng=${coords.lng}${enabled ? '&asknews=1' : ''}`, {
          headers: enabled ? headers : {}, signal: controller.signal, cache: 'no-store',
        });
        if (current !== generation) return;
        if (!response.ok) throw new Error('Dossier unavailable');
        const body: RegionDossier = await response.json();
        if (current !== generation) return;
        publish({ body, loading: false, error: false });
      } catch {
        if (current === generation) publish({ body: previous, loading: false, error: true });
      }
    },
    close() { invalidate(); publish({ body: null, loading: false, error: false }); },
    dispose: invalidate,
  };
}
