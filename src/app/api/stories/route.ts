import { NextResponse } from 'next/server';
import { askNewsFor, AskNewsError } from '@/lib/asknews';
import { placeStories } from '@/lib/asknews/story-places';
import type { AskNewsStatus } from '@/lib/asknews/domain';

/**
 * OSIRIS — AskNews stories.
 *
 * The narratives AskNews updated in the last day, each with its latest
 * articles, read with the reader's key or the operator fallback. Private to
 * the key that asked: nothing here is cached or shared between readers.
 * Stories whose articles carry no coordinates are pinned to the first named
 * place that resolves, so the map can show where each narrative is playing.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  const headers = { 'Cache-Control': 'private, no-store' };
  const timestamp = new Date().toISOString();
  try {
    const stories = await askNewsFor(req.headers).stories(req.signal);
    await placeStories(stories);
    return NextResponse.json({ stories, asknews: { status: 'ok' as AskNewsStatus, count: stories.length }, timestamp }, { headers });
  } catch (error) {
    const status: AskNewsStatus = error instanceof AskNewsError ? error.code : 'unavailable';
    return NextResponse.json({ stories: [], asknews: { status, count: 0 }, timestamp }, { headers });
  }
}
