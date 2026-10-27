import { expect, it } from 'vitest';
import { mergeNews } from './domain';
it('prefers public reporting on normalized URLs, preserving AskNews attribution without mutating the cache', () => {
  const cached = Object.freeze([{ title: 'Public headline', link: 'https://publisher.test/a', published: '2026-10-27T10:00:00Z' }]);
  const result = mergeNews<{ title: string; link: string; published: string; via?: string }>(cached, [{ title: 'AskNews headline', link: 'https://publisher.test/a#top', published: '2026-10-27T11:00:00Z', via: 'AskNews' }]);
  expect(result).toEqual([{ ...cached[0], also_via: 'AskNews' }]);
  expect(cached[0]).not.toHaveProperty('also_via');
});
