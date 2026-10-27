import { expect, it } from 'vitest';
import { startPrediction } from '@/lib/oi/service';
import { waitForEnd } from '@/lib/oi/runs';
import { createDemoChat } from '@/lib/oi/demo';
import { GET } from './[id]/route';
import { GET as events } from './[id]/events/route';
import { POST as ask } from './[id]/ask/route';

it('keeps shared run reads, events and follow-up answers private and no-store', async () => {
  const started = startPrediction({ question: 'Will the envoys agree by year end?', depth: 'quick', use_feeds: false }, { provider: 'demo' }, 'privacy-fixture', { chat: createDemoChat() });
  if (!started.ok) throw new Error(started.error);
  await waitForEnd(started.run, 1000);
  const params = Promise.resolve({ id: started.run.id });
  for (const [handler, path] of [[GET, '?view=full'], [GET, ''], [events, '/events']] as const) {
    const res = await handler(new Request(`http://localhost/api/oi/runs/${started.run.id}${path}`), { params });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('private');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await res.text()).toContain(path === '/events' ? '"t":"end"' : started.run.id);
  }
  const res = await ask(new Request(`http://localhost/api/oi/runs/${started.run.id}/ask`, { method: 'POST', headers: { 'X-OI-Provider': 'demo' }, body: JSON.stringify({ message: 'What matters most?' }) }), { params });
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('private, no-store');
});
