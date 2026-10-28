import { afterEach, expect, it, vi } from 'vitest';
import { createDossierLoader } from './region-dossier-client';

afterEach(() => vi.unstubAllGlobals());
const facts = (city: string) => ({ coordinates: { lat: 10, lng: 20 }, location: { display_name: city }, country: { name: 'Country' }, asknews: { status: 'ok', articles: [{ title: 'Private report' }] } });

it.each([true, false])('only applies the current location when older completion arrives first=%s', async olderFirst => {
  const requests: { resolve: (value: Response) => void; signal: AbortSignal }[] = [];
  vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise<Response>(resolve => requests.push({ resolve, signal: init.signal }))));
  const sink = vi.fn(); const loader = createDossierLoader(sink);
  loader.configure(true, { 'X-AskNews-Key': 'reader-key' });
  const first = loader.open({ lat: 10, lng: 20 }); const second = loader.open({ lat: 30, lng: 40 });
  expect(requests[0].signal.aborted).toBe(true);
  if (olderFirst) { requests[0].resolve(Response.json(facts('Old'))); await first; expect(sink.mock.lastCall?.[0].body).toBeNull(); }
  requests[1].resolve(Response.json(facts('New'))); await second;
  if (!olderFirst) { requests[0].resolve(Response.json(facts('Old'))); await first; }
  expect(sink.mock.lastCall?.[0].body.location.display_name).toBe('New');
});

it('clears only private nearby results on key replacement and source-off and discards late replies', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(facts('Current')));
  vi.stubGlobal('fetch', fetcher); const sink = vi.fn(); const loader = createDossierLoader(sink);
  loader.configure(true, { 'X-AskNews-Key': 'old-key' }); await loader.open({ lat: 10, lng: 20 });
  let resolve!: (value: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const pending = loader.open({ lat: 10, lng: 20 });
  loader.configure(true, { 'X-AskNews-Key': 'new-key' });
  expect(sink.mock.lastCall?.[0].body.country.name).toBe('Country');
  expect(sink.mock.lastCall?.[0].body.asknews).toBeUndefined();
  resolve(Response.json(facts('Late'))); await pending;
  expect(sink.mock.lastCall?.[0].body.location.display_name).toBe('Current');
  loader.configure(false, {});
  expect(sink.mock.lastCall?.[0].body.country.name).toBe('Country');
  expect(sink.mock.lastCall?.[0].body.asknews).toBeUndefined();
});

it('scopes headers to participating requests and closing invalidates a fetch that ignores abort', async () => {
  let resolve!: (value: Response) => void;
  const fetcher = vi.fn<typeof fetch>(() => new Promise(r => { resolve = r; })); vi.stubGlobal('fetch', fetcher);
  const sink = vi.fn(); const loader = createDossierLoader(sink);
  loader.configure(false, { 'X-AskNews-Key': 'reader-key' });
  const pending = loader.open({ lat: 10, lng: 20 });
  expect(fetcher.mock.calls[0][0]).toBe('/api/region-dossier?lat=10&lng=20');
  expect(fetcher.mock.calls[0][1]?.headers).toEqual({});
  loader.close(); resolve(Response.json(facts('Late'))); await pending;
  expect(sink.mock.lastCall?.[0]).toEqual({ body: null, loading: false, error: false });
  fetcher.mockResolvedValueOnce(Response.json(facts('New')));
  loader.configure(true, { 'X-AskNews-Key': 'reader-key' }); await loader.open({ lat: 30, lng: 40 });
  expect(fetcher.mock.calls[1][0]).toBe('/api/region-dossier?lat=30&lng=40&asknews=1');
  expect(fetcher.mock.calls[1][1]?.headers).toEqual({ 'X-AskNews-Key': 'reader-key' });
});
