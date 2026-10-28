import { expect, it, vi } from 'vitest';
import { placeStories } from './story-places';
import type { AskNewsStory } from './stories';

const story = (id: string, locations: string[], coords: [number, number] | null = null): AskNewsStory => ({
  id, headline: `Story ${id}`, summary: '', key_takeaways: [], updated: '2026-10-28T00:00:00.000Z', categories: [], locations, countries: [],
  n_articles: 1, articles: [], via: 'AskNews', place: coords ? { name: 'Known', label: 'Known', precision: 'mentioned-place' } : null, coords,
});

it('pins a story to its first named place that resolves to a settlement, and leaves placed stories alone', async () => {
  const lookup = vi.fn(async (name: string) => name === 'Rafah'
    ? [{ name: 'Rafah', display_name: 'Rafah, Gaza Strip, Palestinian Territories', lat: '31.29', lon: '34.25', addresstype: 'city' }]
    : name === 'Nowhere' ? [] : null);
  const stories = [story('a', ['Nowhere', 'Rafah']), story('b', ['Rafah'], [1, 2]), story('c', ['Unasked'])];
  await placeStories(stories, lookup);
  expect(stories[0].coords).toEqual([31.29, 34.25]);
  expect(stories[0].place).toEqual({ name: 'Rafah', label: 'Rafah, Palestinian Territories', precision: 'mentioned-place' });
  expect(stories[1]).toMatchObject({ coords: [1, 2], place: { name: 'Known' } });
  expect(stories[2].coords).toBeNull();
  // Stories resolve concurrently, so only the set of names asked is fixed; a placed story asks nothing.
  expect(lookup.mock.calls.map(c => c[0]).sort()).toEqual(['Nowhere', 'Rafah', 'Unasked']);
});

it('answers inside its time budget with whatever has resolved', async () => {
  const lookup = vi.fn((name: string) => new Promise<never>(() => { void name; }));
  const stories = [story('slow', ['Somewhere'])];
  const started = Date.now();
  await placeStories(stories, lookup, 20);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(stories[0].coords).toBeNull();
});
