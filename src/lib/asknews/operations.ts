import { askNewsFor } from './index';
import type { AskNewsOperations } from './mcp-domain';

export function askNewsOperationsFor(headers: Headers): AskNewsOperations {
  const source = askNewsFor(headers) as ReturnType<typeof askNewsFor> & Partial<AskNewsOperations>;
  if (!source.tools || !source.call || !source.scrub) throw new Error('AskNews MCP composition is not installed.');
  return { tools: source.tools, call: source.call, scrub: source.scrub };
}
