import { askNewsOperationsFor } from '@/lib/asknews/operations';
import { assistStep } from '@/lib/oi/assist/server';
import { credentials, disabled, json, limited, readBody } from '@/lib/oi/service';

/**
 * OSIRIS OI Assist — one step of the conversation.
 *
 * POST /api/oi/assist
 *   headers  X-OI-Provider, X-OI-Key (or Authorization: Bearer), X-OI-Model (optional)
 *   body     { messages: [...], context: { view, layersOn, loaded, forecast } }
 *   returns  { step: { say, actions, done }, usage }
 *
 * The page runs the actions on the map and, when the step is not done, sends
 * their results back for the next step. Nothing is stored here.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const privateJson = (body: unknown, status = 200) => json(body, status, { 'Cache-Control': 'private, no-store' });

export async function POST(req: Request) {
  if (disabled()) return privateJson({ error: 'OI is switched off on this server.' }, 503);
  if (limited(req, 'assist', 40)) return privateJson({ error: 'Too many steps in a minute. Wait a moment.' }, 429);
  const body = await readBody(req, 96_000);
  if (!body) return privateJson({ error: 'Send a JSON body: { "messages": [...], "context": {...} }.' }, 400);
  const creds = credentials(req, body);
  if ('error' in creds) return privateJson({ error: creds.error }, 400);

  const out = await assistStep(body, creds, req.signal, undefined, askNewsOperationsFor(req.headers));
  if (!out.ok) return privateJson({ error: out.error }, out.status);
  return privateJson({ step: { say: out.step.say, actions: out.step.calls, done: out.step.done }, usage: out.usage });
}
