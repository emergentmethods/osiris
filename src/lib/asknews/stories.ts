import { mergeNews, type AskNewsArticle } from './domain';
import { cleanText, projectArticle } from './project';

/** A narrative AskNews tracks across many articles, at its latest update. */
export interface AskNewsStory {
  id: string;
  headline: string;
  /** The narrative at this update, as AskNews wrote it. */
  summary: string;
  key_takeaways: string[];
  /** When the latest update was written. */
  updated: string;
  categories: string[];
  /** Places the story names, most prominent first. */
  locations: string[];
  /** ISO country codes by coverage, most covered first. */
  countries: string[];
  /** How many articles the latest update clustered, which is more than are attached. */
  n_articles: number;
  articles: AskNewsArticle[];
  via: 'AskNews';
  /** Where the story is pinned: an article's coordinates when one carries them, or a resolved named place. */
  place: AskNewsArticle['place'];
  coords: [number, number] | null;
}

const object = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const strings = (v: unknown, max: number, key: string, each = 200): string[] =>
  Array.isArray(v) ? v.slice(0, max).map(item => cleanText(item, each, key)).filter(Boolean) : [];
/* Takeaways cite their sources as "[1][4]", indexes into a list this
   projection does not keep. */
const uncited = (s: string) => s.replace(/\s*\[\d+(?:,\s*\d+)*\]/g, '').replace(/\s{2,}/g, ' ').trim();

/**
 * One story from /v1/stories, read at its latest update only. Articles are
 * projected as the feed projects them, so nothing the feed withholds (images,
 * full text, the credential) reaches a reader through a story either.
 */
export function projectStory(value: unknown, key: string, maxArticles = 20): AskNewsStory | null {
  const story = object(value);
  const update = object(Array.isArray(story?.updates) ? story!.updates[0] : null);
  if (!story || !update || typeof story.uuid !== 'string' || !/^[0-9a-f-]{36}$/i.test(story.uuid)) return null;
  const headline = cleanText(update.headline, 300, key);
  const ts = typeof update.story_update_ts === 'number' ? update.story_update_ts : typeof story.updated_ts === 'number' ? story.updated_ts : NaN;
  if (!headline || !Number.isFinite(ts)) return null;
  const raw = [...(Array.isArray(update.cluster_articles) ? update.cluster_articles : []), ...(Array.isArray(update.prompt_articles) ? update.prompt_articles : [])];
  const articles = mergeNews([], raw.map(a => projectArticle(a, key)).filter((a): a is AskNewsArticle => a !== null)).slice(0, maxArticles);
  const located = articles.find(a => a.coords && a.place);
  const countries = object(story.countries) ?? {};
  return {
    id: story.uuid,
    headline,
    summary: cleanText(update.story, 4000, key),
    key_takeaways: strings(update.key_takeaways, 6, key, 500).map(uncited).filter(Boolean),
    updated: new Date(ts * 1000).toISOString(),
    categories: strings(update.categories ?? story.categories, 5, key, 60),
    locations: strings(update.locations ?? story.locations, 8, key, 100),
    countries: Object.entries(countries)
      .filter(([code, n]) => /^[A-Z]{2}$/.test(code) && typeof n === 'number')
      .sort((a, b) => (b[1] as number) - (a[1] as number)).slice(0, 5).map(([code]) => code),
    n_articles: typeof update.n_articles === 'number' && update.n_articles >= 0 ? Math.floor(update.n_articles) : articles.length,
    articles,
    via: 'AskNews',
    place: located?.place ?? null,
    coords: located?.coords ?? null,
  };
}
