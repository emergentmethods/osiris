import { askNewsFor, AskNewsError } from '@/lib/asknews';
import { disabled, limited, readBody } from '@/lib/oi/service';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });

export async function POST(req: Request) {
  if (disabled()) return json({ error: 'OI is switched off on this server.' }, 503);
  const origin = req.headers.get('origin');
  if (origin) {
    try {
      const host = (req.headers.get('x-forwarded-host') || req.headers.get('host') || new URL(req.url).host).split(',')[0].trim();
      if (new URL(origin).host !== host) return json({ error: 'Origin not allowed.' }, 403);
    } catch { return json({ error: 'Origin not allowed.' }, 403); }
  }
  if (limited(req, 'asknews', 40)) return json({ error: 'Too many actions in a minute.' }, 429);
  const body = await readBody(req, 4608);
  if (!body || typeof body.tool !== 'string' || !body.args || typeof body.args !== 'object' || Array.isArray(body.args)) return json({ error: 'Invalid AskNews request.', code: 'bad-input' }, 400);
  try {
    const output = await askNewsFor(req.headers).call({ tool: body.tool, args: body.args as Record<string, unknown> }, req.signal);
    return json(output);
  } catch (error) {
    const code = error instanceof AskNewsError ? error.code : 'unavailable';
    const status = code === 'auth' || code === 'missing-key' ? 401 : code === 'forbidden' ? 403 : code === 'quota' ? 402 : code === 'rate' ? 429 : code === 'bad-input' ? 400 : code === 'cancelled' ? 499 : 502;
    return json({ code, error: error instanceof AskNewsError ? error.message : 'AskNews is unavailable.' }, status);
  }
}
