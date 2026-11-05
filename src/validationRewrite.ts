export const VALIDATION_MESSAGE_MAX_CHARS = 200;

const VALIDATION_PREFIX = /^MCP error -32602: ?/;

export function boundText(value: string, limit: number): string {
  const points = [...value];
  return points.length > limit ? `${points.slice(0, limit - 1).join('')}…` : value;
}

export function rewriteValidationError<T>(result: T): T {
  if (result === null || typeof result !== 'object') return result;
  const r = result as { isError?: unknown; content?: unknown };
  if (r.isError !== true || !Array.isArray(r.content) || r.content.length !== 1) return result;
  const block = r.content[0] as { type?: unknown; text?: unknown } | null;
  if (!block || block.type !== 'text' || typeof block.text !== 'string') return result;
  if (!VALIDATION_PREFIX.test(block.text)) return result;
  const envelope = {
    error: 'invalid_arguments',
    message: boundText(block.text.replace(VALIDATION_PREFIX, ''), VALIDATION_MESSAGE_MAX_CHARS),
    retryable: false,
  };
  return { ...r, content: [{ type: 'text', text: JSON.stringify(envelope) }], isError: true } as T;
}
