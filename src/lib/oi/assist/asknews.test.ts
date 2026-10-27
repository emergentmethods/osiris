import { describe, expect, it, vi } from 'vitest';
import { parseStep, sanitizeContext, sanitizeMessages, systemPrompt, transcript } from './protocol';
import { assistStep } from './server';
import { runCall, type Site } from './tools';
import type { ChatFn } from '../providers';
import type { AskNewsOperations } from '../../asknews/mcp-domain';

const catalog = [{ name: 'OddCamelTool', description: 'Arbitrary reporting', inputSchema: { type: 'object' } }];
const operations: AskNewsOperations = {
  tools: async () => catalog,
  call: async () => ({ articles: [], notes: [] }),
  scrub: text => text.replaceAll('private-key-sentinel', '[redacted]'),
};
describe('Assist model-selected AskNews', () => {
  it('describes a runtime catalog without scheduling an automatic call', async () => {
    const call = vi.fn(operations.call);
    const chat = vi.fn<ChatFn>(async () => ({ text: '{"say":"Hello","actions":[],"done":true}', input: 0, output: 0 }));
    const result = await assistStep({ messages: [{ role: 'user', text: 'Hello' }] }, { provider: 'demo' }, undefined, chat, { ...operations, call });
    expect(result.ok).toBe(true);
    expect(chat.mock.calls[0][0].system).toContain('OddCamelTool');
    expect(call).not.toHaveBeenCalled();
  });
  it('preserves remote casing and retains old results after catalog removal', () => {
    const step = parseStep('{"actions":[{"tool":"asknews","args":{"tool":"OddCamelTool","args":{}}}],"done":false}');
    expect(step.calls).toEqual([{ tool: 'asknews', args: { tool: 'OddCamelTool', args: {} } }]);
    const history = sanitizeMessages([{ role: 'tool', results: [{ tool: 'asknews', ok: true, summary: 'Earlier reporting', data: { article: 'old' } }] }]);
    expect(transcript(history)).toContain('Earlier reporting');
    expect(systemPrompt([])).not.toContain('OddCamelTool');
  });
  it('runs only the generic action and converts failures into failed CallResults', async () => {
    const asknews = vi.fn(async () => { throw new Error('unsafe upstream text'); });
    const site = { asknews } as unknown as Site;
    const result = await runCall({ tool: 'asknews', args: { tool: 'OddCamelTool', args: {} } }, site);
    expect(asknews).toHaveBeenCalledWith({ tool: 'OddCamelTool', args: {} }, undefined);
    expect(result.result).toMatchObject({ tool: 'asknews', ok: false });
    expect(JSON.stringify(result)).not.toContain('unsafe upstream');
  });
  it('scrubs the AskNews key from history before calling the model and from the model reply', async () => {
    const chat = vi.fn<ChatFn>(async () => ({ text: '{"say":"private-key-sentinel","actions":[],"done":true}', input: 0, output: 0 }));
    const out = await assistStep({ messages: [{ role: 'user', text: 'private-key-sentinel' }], context: sanitizeContext({}) }, { provider: 'demo' }, undefined, chat, operations);
    expect(chat.mock.calls[0][0].user).not.toContain('private-key-sentinel');
    expect(JSON.stringify(out)).not.toContain('private-key-sentinel');
  });
});
