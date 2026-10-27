import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpOperations } from './mcp';

const key = 'offline-secret-sentinel';
const tool = { name: 'OddCamelTool', description: 'Invented reporting tool', inputSchema: { type: 'object' as const, properties: { return_type: { enum: ['string', 'dicts'] } } } };
let server: Server;
let url: string;
let requests: { method: string; rpc?: string; auth?: string; args?: unknown }[];
let result: unknown;
let sse = false;
let catalog: Record<string, unknown>;
let responseMode: 'normal' | 'pending' | 'truncated' = 'normal';
let pendingMethod = 'tools/call';
let status = 200;
let holdOversized = false;
let active: Set<ServerResponse>;
let started: (() => void) | undefined;
beforeEach(async () => {
  requests = [];
  sse = false;
  catalog = { tools: [tool] };
  responseMode = 'normal';
  pendingMethod = 'tools/call';
  status = 200;
  holdOversized = false;
  active = new Set();
  started = undefined;
  result = { content: [{ type: 'text', text: JSON.stringify({ as_dicts: [{ eng_title: `Headline ${key}`, article_url: 'https://publisher.test/story', source_name: 'Publisher', key_points: ['Evidence'], full_text: 'DROP ME' }] }) }] };
  server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const rpc = body ? JSON.parse(body) : {};
    requests.push({ method: req.method!, rpc: rpc.method, auth: req.headers['x-api-key'] as string, args: rpc.params?.arguments });
    if (!('id' in rpc)) { res.writeHead(202).end(); return; }
    if (rpc.method === pendingMethod && responseMode !== 'normal') {
      active.add(res); res.on('close', () => active.delete(res));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('id: ambiguous-completion\ndata: \n\n');
      started?.();
      if (responseMode === 'truncated') res.end();
      return;
    }
    if (rpc.method === 'tools/call' && status !== 200) { res.writeHead(status).end(key); return; }
    const value = rpc.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : rpc.method === 'tools/list' ? catalog : result;
    const payload = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: value });
    res.writeHead(200, { 'Content-Type': sse && rpc.method === 'tools/call' ? 'text/event-stream' : 'application/json' });
    if (rpc.method === 'tools/call' && holdOversized) {
      active.add(res); res.on('close', () => active.delete(res));
      res.write((sse ? 'event: message\ndata: ' : '') + payload);
      return;
    }
    res.end(sse && rpc.method === 'tools/call' ? `event: message\ndata: ${payload}\n\n` : payload);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterEach(async () => { vi.restoreAllMocks(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

describe('request-owned MCP operations through real HTTP', () => {
  it('discovers arbitrary case-sensitive tools, authenticates each POST and projects safe reporting', async () => {
    const source = mcpOperations(key, { url });
    expect((await source.tools()).map(t => t.name)).toEqual(['OddCamelTool']);
    const output = await source.call({ tool: 'OddCamelTool', args: {} });
    expect(output.articles[0]).toMatchObject({ title: 'Headline [redacted]', link: 'https://publisher.test/story', key_points: ['Evidence'], via: 'AskNews' });
    expect(JSON.stringify(output)).not.toContain(key);
    expect(JSON.stringify(output)).not.toContain('DROP ME');
    expect(requests.filter(r => r.rpc === 'tools/call')).toHaveLength(1);
    expect(requests.find(r => r.rpc === 'tools/call')?.args).toEqual({ return_type: 'dicts' });
    expect(requests.every(r => r.method === 'POST' && r.auth === key)).toBe(true);
  });
  it('rejects mismatched casing, arrays and oversized arguments without executing', async () => {
    const source = mcpOperations(key, { url });
    for (const call of [{ tool: 'oddcameltool', args: {} }, { tool: tool.name, args: [] }, { tool: tool.name, args: { x: 'x'.repeat(4096) } }]) {
      await expect(source.call(call as never)).rejects.toMatchObject({ code: 'bad-input' });
    }
    expect(requests.filter(r => r.rpc === 'tools/call')).toHaveLength(0);
  });
  it('bounds JSON and SSE results before accumulation and never retries', async () => {
    for (const streamed of [false, true]) {
      sse = streamed; holdOversized = true; result = { content: [{ type: 'text', text: 'x'.repeat(1_048_577) }] };
      await expect(mcpOperations(key, { url }).call({ tool: tool.name, args: {} })).rejects.toMatchObject({ code: 'too-large' });
      await vi.waitFor(() => expect(active.size).toBe(0));
    }
    expect(requests.filter(r => r.rpc === 'tools/call')).toHaveLength(2);
  });
  it('accepts SSE DeepNews sources, bounded synthesis, mentioned places and empty dates', async () => {
    sse = true;
    result = { content: [{ type: 'text', text: JSON.stringify({ overview: key + 'z'.repeat(5000), sources: [{ title: 'Reporting', url: 'https://publisher.test/a', summary: 's'.repeat(700), geo_coordinates: { Berlin: { latitude: 52, longitude: 13 } } }] }) }] };
    const output = await mcpOperations(key, { url }).call({ tool: tool.name, args: {} });
    expect(output.articles[0]).toMatchObject({ published: '', coords: [52, 13], place: { name: 'Berlin', precision: 'mentioned-place' } });
    expect(output.articles[0].key_points[0]).toHaveLength(520);
    expect(output.notes[0]).toMatchObject({ kind: 'synthesis', title: 'AskNews DeepNews synthesis' });
    expect(output.notes[0].text).toHaveLength(4000);
    expect(output.notes[0].text).toContain('[redacted]');
    expect(JSON.stringify(output)).not.toContain(key);
  });
  it('bounds reporting and combines synthesis and reference notes while dropping unsafe fields', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ title: `Article ${i}`, url: `https://publisher.test/${i}`, summary: 'Summary', raw_text: 'DROP RAW', image_url: 'https://publisher.test/image.jpg', metadata: { secret: key } }));
    result = { content: [
      { type: 'text', text: JSON.stringify({ overview: 'First overview', sources: [{ title: 'Unsafe', url: 'javascript:alert(1)' }, ...rows] }) },
      { type: 'text', text: JSON.stringify({ overview: 'Second overview', sources: rows }) },
      { type: 'text', text: `Reference ${key}` },
      { type: 'text', text: 'r'.repeat(5000) },
    ] };
    const output = await mcpOperations(key, { url }).call({ tool: tool.name, args: {} });
    expect(output.articles).toHaveLength(25);
    expect(output.articles.every(a => a.coords === null && a.place === null && a.published === '')).toBe(true);
    expect(output.notes).toHaveLength(2);
    expect(output.notes[0]).toEqual({ kind: 'synthesis', title: 'AskNews DeepNews synthesis', text: 'First overview\nSecond overview' });
    expect(output.notes[1]).toMatchObject({ kind: 'reference', title: 'AskNews reference' });
    expect(output.notes[1].text).toHaveLength(4000);
    expect(output.notes[1].text).toContain('Reference [redacted]');
    for (const excluded of [key, 'DROP RAW', 'image.jpg', 'metadata', 'javascript:']) expect(JSON.stringify(output)).not.toContain(excluded);
  });
  it('returns a safe failure for server tool errors', async () => {
    result = { isError: true, content: [{ type: 'text', text: key }] };
    await expect(mcpOperations(key, { url }).call({ tool: tool.name, args: {} })).rejects.toMatchObject({ code: 'bad-input', message: 'Invalid AskNews request.' });
  });
  it('cancels before connecting without sending a request', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(mcpOperations(key, { url }).tools(ctrl.signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(requests).toEqual([]);
  });
  it('rejects an oversized catalog without calling a tool', async () => {
    catalog = { tools: [{ ...tool, description: 'x'.repeat(65_537) }] };
    await expect(mcpOperations(key, { url }).tools()).rejects.toMatchObject({ code: 'too-large' });
    expect(requests.filter(r => r.rpc === 'tools/call')).toHaveLength(0);
  });
  it('bounds the combined catalog across individually bounded pages', async () => {
    catalog = { tools: Array.from({ length: 3 }, (_, i) => ({ ...tool, name: `Paged${i}`, description: 'x'.repeat(16_000) })), nextCursor: 'more' };
    await expect(mcpOperations(key, { url }).tools()).rejects.toMatchObject({ code: 'too-large' });
    expect(requests.filter(r => r.rpc === 'tools/list')).toHaveLength(2);
  });
  it('scrubs catalog text and schemas without making a tool call', async () => {
    catalog = { tools: [{ ...tool, description: `Description ${key}`, inputSchema: { type: 'object', properties: { query: { type: 'string', description: key } } } }] };
    const tools = await mcpOperations(key, { url }).tools();
    expect(tools[0].name).toBe(tool.name);
    expect(JSON.stringify(tools)).toContain('[redacted]');
    expect(JSON.stringify(tools)).not.toContain(key);
    expect(requests.filter(r => r.rpc === 'tools/call')).toHaveLength(0);
  });
  it('rejects recursive and multibyte oversized arguments without executing', async () => {
    const recursive: Record<string, unknown> = {}; recursive.self = recursive;
    const source = mcpOperations(key, { url });
    for (const args of [recursive, { query: 'é'.repeat(2100) }, null]) {
      await expect(source.call({ tool: tool.name, args } as never)).rejects.toMatchObject({ code: 'bad-input' });
    }
    expect(requests.filter(r => r.rpc === 'tools/call')).toHaveLength(0);
  });
  it.each([[401, 'auth'], [402, 'quota'], [403, 'forbidden'], [429, 'rate'], [503, 'unavailable']] as const)('scrubs HTTP %s errors and sends no paid retry', async (httpStatus, code) => {
    status = httpStatus;
    const error = await mcpOperations(key, { url }).call({ tool: tool.name, args: {} }).catch(error => error);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain(key);
    expect(requests.filter(r => r.rpc === 'tools/call')).toHaveLength(1);
    expect(requests.every(r => r.method === 'POST')).toBe(true);
  });
  it('closes a pending HTTP response when the caller cancels without retrying', async () => {
    responseMode = 'pending';
    const ready = new Promise<void>(resolve => { started = resolve; });
    const ctrl = new AbortController();
    const pending = mcpOperations(key, { url }).call({ tool: tool.name, args: {} }, ctrl.signal);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await ready;
    expect(active.size).toBe(1);
    ctrl.abort();
    await assertion;
    await vi.waitFor(() => expect(active.size).toBe(0));
    expect(requests.filter(r => r.rpc === 'tools/call')).toHaveLength(1);
    expect(requests.every(r => r.method === 'POST')).toBe(true);
  });
  it('does not reconnect or repeat a call after an ambiguous SSE completion', async () => {
    responseMode = 'truncated';
    await expect(mcpOperations(key, { url }).call({ tool: tool.name, args: {} })).rejects.toMatchObject({ code: 'invalid-response' });
    await vi.waitFor(() => expect(active.size).toBe(0));
    expect(requests.filter(r => r.rpc === 'tools/call')).toHaveLength(1);
    expect(requests.every(r => r.method === 'POST')).toBe(true);
  });
  it.each([['tools/list', 10_000], ['tools/call', 90_000]] as const)('applies the %s deadline and closes its response', async (method, duration) => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const deadlines: AbortController[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      if (ms !== duration) return timeout(ms);
      const ctrl = new AbortController(); deadlines.push(ctrl); return ctrl.signal;
    });
    responseMode = 'pending'; pendingMethod = method;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const source = mcpOperations(key, { url });
    const pending = method === 'tools/list' ? source.tools() : source.call({ tool: tool.name, args: {} });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await ready;
    expect(deadlines.length).toBeGreaterThan(0);
    deadlines.forEach(ctrl => ctrl.abort(new DOMException('Test deadline', 'TimeoutError')));
    await assertion;
    await vi.waitFor(() => expect(active.size).toBe(0));
    expect(requests.filter(r => r.rpc === method)).toHaveLength(1);
  });
});
