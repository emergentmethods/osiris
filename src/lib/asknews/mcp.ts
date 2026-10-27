import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AskNewsError, classifyAskNewsStatus } from './domain';
import { projectArticle } from './project';
import { validAskNewsCall, type AskNewsCall, type AskNewsOperations, type AskNewsOutput, type AskNewsTool } from './mcp-domain';

const object = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;

export function mcpOperations(key: string, options: { url?: string } = {}): AskNewsOperations {
  const scrub = (text: string) => key ? text.replaceAll(key, '[redacted]').replaceAll(JSON.stringify(key).slice(1, -1), '[redacted]') : text;
  const text = (v: unknown, max: number) => typeof v === 'string' ? scrub(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
  async function operation<T>(duration: number, caller: AbortSignal | undefined, run: (client: Client, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!key) throw new AskNewsError('missing-key');
    if (!/^[\x21-\x7e]{8,400}$/.test(key)) throw new AskNewsError('auth');
    const signal = AbortSignal.any([AbortSignal.timeout(duration), ...(caller ? [caller] : [])]);
    let failure: AskNewsError | undefined;
    const client = new Client({ name: 'osiris-asknews', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(options.url ?? process.env.ASKNEWS_MCP_URL ?? 'https://mcp.asknews.app/'), {
      requestInit: { headers: { 'X-API-Key': key }, cache: 'no-store' },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 0, maxReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
      fetch: async (url, init) => {
        if (init?.method === 'GET') return new Response(null, { status: 405 });
        let method = '';
        try { method = JSON.parse(String(init?.body)).method ?? ''; } catch {}
        const cap = method === 'tools/call' ? 1_048_576 : 65_536;
        const response = await fetch(url, { ...init, cache: 'no-store', redirect: 'error', signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) });
        if (!response.ok) {
          await response.body?.cancel();
          failure = new AskNewsError(classifyAskNewsStatus(response.status)); throw failure;
        }
        if (!response.body) return response;
        const reader = response.body.getReader();
        let bytes = 0;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) { controller.close(); return; }
              bytes += next.value.byteLength;
              if (bytes > cap) { failure = new AskNewsError('too-large'); await reader.cancel(); controller.error(failure); return; }
              controller.enqueue(next.value);
            } catch (error) { controller.error(error); }
          },
          cancel: reason => reader.cancel(reason),
        });
        return new Response(body, { status: response.status, headers: response.headers });
      },
    });
    const close = () => { void transport.close(); };
    signal.addEventListener('abort', close, { once: true });
    client.onerror = close;
    try {
      signal.throwIfAborted();
      await client.connect(transport, { signal, timeout: duration });
      return await run(client, signal);
    } catch (error) {
      if (caller?.aborted) throw new AskNewsError('cancelled');
      if (signal.aborted) throw new AskNewsError('timeout');
      if (failure) throw failure;
      if (error instanceof AskNewsError) throw error;
      throw new AskNewsError('invalid-response');
    } finally {
      signal.removeEventListener('abort', close);
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }
  async function discover(client: Client, signal: AbortSignal): Promise<AskNewsTool[]> {
    const tools: AskNewsTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { signal, timeout: 10_000 }).catch(error => {
        if (signal.aborted) throw new AskNewsError('timeout');
        throw error;
      });
      for (const t of page.tools) {
        if (t.name.includes(key)) throw new AskNewsError('invalid-response');
        tools.push({ name: t.name, description: text(t.description, 16_000), inputSchema: JSON.parse(scrub(JSON.stringify(t.inputSchema))) });
      }
      if (new TextEncoder().encode(JSON.stringify(tools)).byteLength > 65_536) throw new AskNewsError('too-large');
      if (page.nextCursor && page.nextCursor === cursor) throw new AskNewsError('invalid-response');
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }
  function project(result: Record<string, unknown>): AskNewsOutput {
    if (result.isError) throw new AskNewsError('bad-input');
    const output: AskNewsOutput = { articles: [], notes: [] };
    const values: unknown[] = [];
    if (object(result.structuredContent)) values.push(result.structuredContent);
    else if (Array.isArray(result.content)) for (const block of result.content) {
      const b = object(block); if (b?.type !== 'text' || typeof b.text !== 'string') continue;
      try { values.push(JSON.parse(b.text)); } catch { values.push(b.text); }
    }
    for (const value of values) {
      const data = object(value);
      const rows = Array.isArray(value) ? value : data && (Array.isArray(data.as_dicts) ? data.as_dicts : Array.isArray(data.sources) ? data.sources : Array.isArray(data.articles) ? data.articles : null);
      if (rows) for (const item of rows.slice(0, 25)) {
        const article = projectArticle(item, key);
        if (article) delete article.wikidata_entities;
        if (article && output.articles.length < 25 && !output.articles.some(a => a.link === article.link)) output.articles.push(article);
      }
      if (data && typeof data.overview === 'string') output.notes.push({ kind: 'synthesis', title: 'AskNews DeepNews synthesis', text: text(data.overview, 4000) });
      else if (!rows) {
        const reference = typeof value === 'string' ? value : data?.text ?? data?.as_string ?? data?.content ?? data?.result;
        if (typeof reference === 'string') output.notes.push({ kind: 'reference', title: 'AskNews reference', text: text(reference, 4000) });
      }
    }
    output.notes = (['synthesis', 'reference'] as const).flatMap(kind => {
      const notes = output.notes.filter(n => n.kind === kind);
      return notes.length ? [{ kind, title: notes[0].title, text: notes.map(n => n.text).join('\n').slice(0, 4000) }] : [];
    });
    return output;
  }
  return {
    scrub,
    tools: signal => operation(10_000, signal, discover),
    call: (call: AskNewsCall, signal) => operation(90_000, signal, async (client, operationSignal) => {
      const catalog = await discover(client, AbortSignal.any([operationSignal, AbortSignal.timeout(10_000)]));
      if (!validAskNewsCall(call, catalog)) throw new AskNewsError('bad-input');
      const schema = catalog.find(t => t.name === call.tool)!.inputSchema;
      const format = object(object(schema.properties)?.return_type);
      const offered = Array.isArray(format?.enum) && format.enum.includes('dicts') || Array.isArray(format?.anyOf) && format.anyOf.some(v => Array.isArray(object(v)?.enum) && (object(v)!.enum as unknown[]).includes('dicts'));
      const args = offered ? { ...call.args, return_type: 'dicts' } : call.args;
      if (new TextEncoder().encode(JSON.stringify(args)).byteLength > 4096) throw new AskNewsError('bad-input');
      return project(await client.callTool({ name: call.tool, arguments: args }, undefined, { signal: operationSignal, timeout: 90_000 }));
    }),
  };
}
