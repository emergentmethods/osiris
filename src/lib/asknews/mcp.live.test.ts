import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mcpOperations } from './mcp';

it.skipIf(process.env.RUN_LIVE_TESTS !== '1' || !process.env.ASKNEWS_API_KEY)('live catalog and harmless schema-invalid rejection before tool execution', async () => {
  const key = process.env.ASKNEWS_API_KEY!;
  const tools = await mcpOperations(key).tools();
  expect(tools.length > 0).toBe(true);
  const tool = tools.find(t => {
    const properties = t.inputSchema.properties as Record<string, { type?: string }> | undefined;
    return properties?.query?.type === 'string';
  });
  if (!tool) throw new Error('No provably string query schema. Stopped without calling a tool.');
  const client = new Client({ name: 'osiris-contract', version: '1' });
  const signal = AbortSignal.timeout(10_000);
  let callCount = 0;
  const transport = new StreamableHTTPClientTransport(new URL('https://mcp.asknews.app/'), {
    requestInit: { headers: { 'X-API-Key': key }, cache: 'no-store' },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 0, maxReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
    fetch: async (url, init) => {
      if (init?.method === 'GET') return new Response(null, { status: 405 });
      if (JSON.parse(String(init?.body)).method === 'tools/call') callCount++;
      return fetch(url, { ...init, signal, cache: 'no-store', redirect: 'error' });
    },
  });
  try {
    await client.connect(transport, { signal, timeout: 10_000 });
    const result = await client.callTool({ name: tool.name, arguments: { query: { invalid_object_not_a_string: true } } }, undefined, { signal, timeout: 10_000 });
    const content = JSON.stringify(result);
    const validation = result.isError === true && /validation|invalid.*argument|input should be a valid string/i.test(content) && /query/i.test(content);
    expect(validation).toBe(true);
    expect(callCount).toBe(1);
  } catch (error) {
    if (error instanceof Error && error.message.includes(key)) throw new Error('Live contract failed. Credential removed.');
    throw error;
  } finally { await client.close(); await transport.close(); }
}, 30_000);
