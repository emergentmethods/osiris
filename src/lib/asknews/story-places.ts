import { budgetedLookup, pickRow, type GeoRow } from '@/lib/alert-places';
import type { AskNewsStory } from './stories';

/** How many names one refresh may put to Nominatim. The rest wait for a later refresh. */
const LOOKUPS_PER_REFRESH = 15;
/** How long a request waits for places before answering with what it has. */
const BUDGET_MS = 2500;
/** How many of a story's named places are tried before it stays unplaced. */
const NAMES_PER_STORY = 3;

/** "Visakhapatnam, Andhra Pradesh, 530001, India" → "Visakhapatnam, India". */
const label = (displayName: string, fallback: string) => {
  const parts = displayName.split(', ').filter(Boolean);
  return parts.length > 1 ? `${parts[0]}, ${parts[parts.length - 1]}` : parts[0] || fallback;
};

/**
 * Pins each story to the first of its named places that resolves, when the
 * story's own articles carried no coordinates. Lookups go through the app's
 * shared Nominatim budget and cache, so a cold start places what it can
 * inside the budget and the next refresh places more. Settlement lookups
 * only: a story that names nothing smaller than a country stays unplaced
 * rather than sitting on a country centroid.
 */
export async function placeStories(
  stories: AskNewsStory[],
  lookup: (name: string, countries: string[] | null) => Promise<GeoRow[] | null> = budgetedLookup(LOOKUPS_PER_REFRESH),
  budgetMs = BUDGET_MS,
): Promise<void> {
  const found = new Map<string, { name: string; row: GeoRow }>();
  const all = Promise.all(stories.filter(s => !s.coords).map(async story => {
    for (const name of story.locations.slice(0, NAMES_PER_STORY)) {
      const rows = await lookup(name, null).catch(() => null);
      if (rows === null) continue;
      const pick = pickRow(name, rows);
      if (pick) { found.set(story.id, { name, row: pick.row }); return; }
    }
  }));
  await Promise.race([all, new Promise(resolve => setTimeout(resolve, budgetMs))]);
  for (const story of stories) {
    const hit = found.get(story.id);
    if (!hit) continue;
    story.coords = [Number(hit.row.lat), Number(hit.row.lon)];
    story.place = { name: hit.name, label: label(hit.row.display_name || hit.name, hit.name), precision: 'mentioned-place' };
  }
}
