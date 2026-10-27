import { safeNewsUrl, type AskNewsArticle, type AskNewsEntity } from './domain';

const object = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;

export function projectArticle(value: unknown, key: string): AskNewsArticle | null {
  const row = object(value);
  if (!row) return null;
  const text = (v: unknown, max: number) => typeof v === 'string'
    ? (key ? v.replaceAll(key, '[redacted]').replaceAll(JSON.stringify(key).slice(1, -1), '[redacted]') : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
  const link = safeNewsUrl(row.article_url ?? row.url ?? row.link);
  const title = text(row.eng_title || row.title, 520);
  if (!title || !link || key && link.includes(key)) return null;
  const source = text(row.source_name || row.source || row.domain_url || new URL(link).hostname, 200);
  const date = row.pub_date ?? row.publication_date ?? row.published;
  const published = typeof date === 'string' && Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : '';
  const points = Array.isArray(row.key_points) ? row.key_points : [row.summary];
  let place: AskNewsArticle['place'] = null;
  let coords: AskNewsArticle['coords'] = null;
  const geo = object(row.geo_coordinates);
  if (geo) for (const name of Object.keys(geo).sort()) {
    const p = object(geo[name]);
    const label = text(name, 200);
    if (p && label && typeof p.latitude === 'number' && typeof p.longitude === 'number'
      && Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 90 && Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180) {
      place = { name: label, label, precision: 'mentioned-place' };
      coords = [p.latitude, p.longitude];
      break;
    }
  }
  const entities: Record<string, AskNewsEntity[]> = {};
  const rawEntities = object(row.wikidata_entities);
  if (rawEntities) for (const [group, values] of Object.entries(rawEntities).slice(0, 20)) {
    if (!Array.isArray(values)) continue;
    const entries = values.slice(0, 20).flatMap(value => {
      const entity = object(value);
      if (!entity || typeof entity.qid !== 'string' || !/^Q[1-9][0-9]*$/.test(entity.qid)
        || typeof entity.relevance !== 'number' || !Number.isFinite(entity.relevance)) return [];
      const title = text(entity.title, 200);
      return title ? [{ title, qid: entity.qid, relevance: entity.relevance }] : [];
    });
    const label = text(group, 100);
    if (label && entries.length) Object.defineProperty(entities, label, { value: entries, enumerable: true });
  }
  return { id: `asknews:${link}`, title, link, source, source_name: source, published,
    key_points: points.slice(0, 5).map(p => text(p, 520)).filter(Boolean), via: 'AskNews', place, coords,
    ...(Object.keys(entities).length ? { wikidata_entities: entities } : {}) };
}
