/** Matches the MCP `CallToolResult` shape (content blocks + isError) without a runtime SDK import. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * A successful result carrying structured data. The MCP content model has no JSON block, so the
 * repo-wide convention (mcp/src/types.ts `jsonResult`) is a single pretty-printed text block —
 * mirrored here rather than imported, since this package cannot depend on the MCP server.
 */
export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false };
}
