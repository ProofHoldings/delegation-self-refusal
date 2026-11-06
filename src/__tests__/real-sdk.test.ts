import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createDiskStore, verdictCacheKey } from '../cache.js';
import { GATE_CONSTANTS, GATE_VERSION, STATUS_TOOL_NAME } from '../constants.js';
import * as entry from '../index.js';
import { installProofHoldings, instructionsLine, type McpServerLike } from '../installProofHoldings.js';

/**
 * Against the real `@modelcontextprotocol/sdk` this package locks (1.30.0): the `tools/call`
 * handler it wraps, the input validation that runs behind the gate, and the `initialize` answer.
 */

const NOW_S = Math.floor(Date.now() / 1000);

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function token(overrides: Record<string, unknown> = {}): string {
  return `${b64({ alg: 'ES256', kid: 'k1' })}.${b64({
    sub: 'ph_dlg_00000000000000000000000000000001',
    principal: 'example.com',
    delegate: 'pkg:npm/example-mcp',
    iat: NOW_S - 60,
    exp: NOW_S + 30 * 86_400,
    ...overrides,
  })}.signature-part`;
}

const TOKEN = token();

let dir: string;
let fetchCalls: Array<{ url: string; body: unknown }>;
let handlerCalls: number;

function answer(body: unknown, status = 200) {
  fetchCalls = [];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(body), { status });
  });
}

function newServer(instructions?: string): McpServer {
  return new McpServer({ name: 'publisher', version: '1.0.0' }, instructions ? { instructions } : undefined);
}

function registerEcho(server: McpServer): void {
  server.registerTool(
    'echo',
    { description: 'echo', inputSchema: { mode: z.enum(['fast', 'slow']) } },
    async ({ mode }) => {
      handlerCalls += 1;
      return { content: [{ type: 'text', text: `echo ${mode}` }] };
    },
  );
}

async function connect(server: McpServer): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'consumer', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

function envelopeOf(result: unknown): { error: string; message: string; retryable: boolean } {
  const r = result as { isError?: boolean; content: Array<{ text: string }> };
  expect(r.isError).toBe(true);
  expect(r.content).toHaveLength(1);
  return JSON.parse(r.content[0].text);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'self-refusal-sdk-'));
  handlerCalls = 0;
  answer({ valid: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('the export surface', () => {
  it('is the one entry point plus its constants and the tombstone reset', () => {
    expect(Object.keys(entry).sort()).toEqual(['GATE_VERSION', 'STATUS_TOOL_NAME', 'clearTombstones', 'installProofHoldings']);
  });

  it('GATE_VERSION is the package version', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(GATE_VERSION).toBe(manifest.version);
  });
});

describe('the gate sits in tools/call, before SDK input validation', () => {
  it('refuses a schema-invalid call under a revoked token with the envelope, not -32602', async () => {
    answer({ valid: false, reason: 'revoked' });
    const server = newServer();
    registerEcho(server);
    installProofHoldings(server as unknown as McpServerLike, { token: TOKEN, cacheDir: dir });
    const client = await connect(server);

    const envelope = envelopeOf(await client.callTool({ name: 'echo', arguments: { mode: 'not-a-mode' } }));
    expect(envelope).toEqual({
      error: 'revoked',
      message:
        "Refused by Proof: example.com's authorization was revoked. Retrying will not fix this. Details: proof.holdings/delegation",
      retryable: false,
    });
    expect(handlerCalls).toBe(0);
    expect(fetchCalls).toHaveLength(1);
  });

  it('gates a tool registered after install', async () => {
    answer({ valid: false, reason: 'suspended' });
    const server = newServer();
    installProofHoldings(server as unknown as McpServerLike, { token: TOKEN, cacheDir: dir });
    registerEcho(server);
    const client = await connect(server);

    expect(envelopeOf(await client.callTool({ name: 'echo', arguments: { mode: 'fast' } })).error).toBe('suspended');
    expect(handlerCalls).toBe(0);
  });

  it('runs the tool under a valid verdict', async () => {
    const server = newServer();
    installProofHoldings(server as unknown as McpServerLike, { token: TOKEN, cacheDir: dir });
    registerEcho(server);
    const client = await connect(server);

    expect(await client.callTool({ name: 'echo', arguments: { mode: 'fast' } })).toMatchObject({
      content: [{ type: 'text', text: 'echo fast' }],
    });
    expect(handlerCalls).toBe(1);
  });

  it('answers a schema-invalid call under a valid verdict with invalid_arguments', async () => {
    const server = newServer();
    registerEcho(server);
    installProofHoldings(server as unknown as McpServerLike, { token: TOKEN, cacheDir: dir });
    const client = await connect(server);

    const envelope = envelopeOf(await client.callTool({ name: 'echo', arguments: { mode: 'sideways' } }));
    expect(envelope.error).toBe('invalid_arguments');
    expect(envelope.retryable).toBe(false);
    expect(envelope.message).toMatch(/^Input validation error: Invalid arguments for tool echo/);
    expect([...envelope.message].length).toBeLessThanOrEqual(GATE_CONSTANTS.message_max_chars);
  });

  it('redacts the token the SDK repeats in a validation message (zod 3 enum)', async () => {
    const server = newServer();
    registerEcho(server);
    installProofHoldings(server as unknown as McpServerLike, { token: TOKEN, cacheDir: dir });
    const client = await connect(server);

    const ungated = newServer();
    registerEcho(ungated);
    const raw = (await (await connect(ungated)).callTool({ name: 'echo', arguments: { mode: TOKEN } })) as {
      content: Array<{ text: string }>;
    };
    expect(raw.content[0].text).toContain(TOKEN);

    const envelope = envelopeOf(await client.callTool({ name: 'echo', arguments: { mode: TOKEN } }));
    expect(envelope.error).toBe('invalid_arguments');
    expect(envelope.message).not.toContain(TOKEN);
    expect(envelope.message).not.toContain(TOKEN.slice(0, 40));
    expect(envelope.message).toContain('[redacted]');
  });

  it('answers a tool whose own structured output fails its outputSchema with internal_error, not invalid_arguments', async () => {
    const registerReport = (target: McpServer) =>
      target.registerTool('get_report', { description: 'report', outputSchema: { total: z.number() } }, async () => {
        handlerCalls += 1;
        return { structuredContent: { total: 'x' }, content: [{ type: 'text', text: '{"total":"x"}' }] };
      });
    const ungated = newServer();
    registerReport(ungated);
    const raw = (await (await connect(ungated)).callTool({ name: 'get_report', arguments: {} })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(raw.isError).toBe(true);
    expect(raw.content[0].text).toMatch(/^MCP error -32602: Output validation error: Invalid structured content for tool get_report/);

    const server = newServer();
    registerReport(server);
    installProofHoldings(server as unknown as McpServerLike, { token: TOKEN, cacheDir: dir });
    const client = await connect(server);

    const envelope = envelopeOf(await client.callTool({ name: 'get_report', arguments: {} }));
    expect(handlerCalls).toBe(2);
    expect(envelope.error).toBe('internal_error');
    expect(envelope.retryable).toBe(false);
    expect(envelope.message).toMatch(/^Output validation error: Invalid structured content for tool get_report/);
    expect([...envelope.message].length).toBeLessThanOrEqual(GATE_CONSTANTS.message_max_chars);
  });

  it('redacts the token a tool repeats in its own schema-invalid output (zod 3 enum)', async () => {
    const registerMode = (target: McpServer) =>
      target.registerTool('get_mode', { description: 'mode', outputSchema: { mode: z.enum(['fast', 'slow']) } }, async () => ({
        structuredContent: { mode: TOKEN },
        content: [{ type: 'text', text: 'mode' }],
      }));
    const ungated = newServer();
    registerMode(ungated);
    const raw = (await (await connect(ungated)).callTool({ name: 'get_mode', arguments: {} })) as {
      content: Array<{ text: string }>;
    };
    expect(raw.content[0].text).toMatch(/^MCP error -32602: Output validation error/);
    expect(raw.content[0].text).toContain(TOKEN);

    const server = newServer();
    registerMode(server);
    installProofHoldings(server as unknown as McpServerLike, { token: TOKEN, cacheDir: dir });
    const client = await connect(server);

    const envelope = envelopeOf(await client.callTool({ name: 'get_mode', arguments: {} }));
    expect(envelope.error).toBe('internal_error');
    expect(envelope.message).not.toContain(TOKEN);
    expect(envelope.message).not.toContain(TOKEN.slice(0, 40));
    expect(envelope.message).toContain('[redacted]');
  });

  it('passes the status tool through under a revoked token', async () => {
    answer({ valid: false, reason: 'revoked' });
    const server = newServer();
    installProofHoldings(server as unknown as McpServerLike, { token: TOKEN, cacheDir: dir });
    const client = await connect(server);

    const result = (await client.callTool({ name: STATUS_TOOL_NAME, arguments: {} })) as {
      isError?: boolean;
      structuredContent: { delegation: Record<string, unknown> };
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.delegation).toMatchObject({
      status: 'refused',
      reason: 'revoked',
      principal: 'example.com',
      delegate: 'pkg:npm/example-mcp',
      source: 'live',
    });
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.structuredContent) }]);
  });

  it('lists the status tool read-only with an output schema', async () => {
    const server = newServer();
    installProofHoldings(server as unknown as McpServerLike, { token: TOKEN, cacheDir: dir });
    const client = await connect(server);
    const { tools } = await client.listTools();
    const status = tools.find((tool) => tool.name === STATUS_TOOL_NAME);
    expect(status?.annotations?.readOnlyHint).toBe(true);
    expect(status?.outputSchema).toMatchObject({ type: 'object' });
  });
});

describe('initialize and the instructions line', () => {
  it('appends exactly the contract line to the publisher instructions with a token', async () => {
    const server = newServer('Publisher instructions.');
    installProofHoldings(server as unknown as McpServerLike, { token: TOKEN, cacheDir: dir });
    const client = await connect(server);
    expect(client.getInstructions()).toBe(
      'Publisher instructions.\n\nVerified by Proof Holdings (delegated by example.com). Call proof_holdings_status for details.',
    );
    expect(instructionsLine('example.com')).toBe(
      'Verified by Proof Holdings (delegated by example.com). Call proof_holdings_status for details.',
    );
  });

  it('is the whole instructions when the publisher has none', async () => {
    const server = newServer();
    installProofHoldings(server as unknown as McpServerLike, { token: TOKEN, cacheDir: dir });
    expect((await connect(server)).getInstructions()).toBe(instructionsLine('example.com'));
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
  ])('with an %s token: no line, nothing gated, status not_configured', async (_label, configured) => {
    answer({ valid: false, reason: 'revoked' });
    const server = newServer('Publisher instructions.');
    registerEcho(server);
    installProofHoldings(server as unknown as McpServerLike, { token: configured, cacheDir: dir });
    const client = await connect(server);

    expect(client.getInstructions()).toBe('Publisher instructions.');
    expect(await client.callTool({ name: 'echo', arguments: { mode: 'fast' } })).toMatchObject({
      content: [{ text: 'echo fast' }],
    });
    const status = (await client.callTool({ name: STATUS_TOOL_NAME, arguments: {} })) as {
      structuredContent: { delegation: Record<string, unknown> };
    };
    expect(status.structuredContent.delegation).toMatchObject({ status: 'not_configured', source: 'cache' });
    expect(fetchCalls).toEqual([]);
  });
});

describe('install', () => {
  it('throws on a second install', () => {
    const server = newServer();
    installProofHoldings(server as unknown as McpServerLike, { token: TOKEN, cacheDir: dir });
    expect(() => installProofHoldings(server as unknown as McpServerLike, { token: TOKEN, cacheDir: dir })).toThrow(
      /already carries/,
    );
  });

  it('runs a below-floor interval on the floor', async () => {
    const server = newServer();
    registerEcho(server);
    installProofHoldings(server as unknown as McpServerLike, { token: TOKEN, cacheDir: dir, pollIntervalMs: 1_000 });
    createDiskStore({ dir }).writeRecords(TOKEN, {
      gate: { verdict: { kind: 'valid' }, checked_at: Date.now() - 30_000 },
      info: { unresolved_since: null },
    });
    const client = await connect(server);
    await client.callTool({ name: 'echo', arguments: { mode: 'fast' } });
    expect(fetchCalls).toEqual([]);
    expect(GATE_CONSTANTS.poll_interval_floor_ms).toBeGreaterThan(30_000);
  });

  it.each([NaN, Infinity, -Infinity, '300000'])('throws on a pollIntervalMs of %s', (value) => {
    const server = newServer();
    expect(() =>
      installProofHoldings(server as unknown as McpServerLike, { token: TOKEN, cacheDir: dir, pollIntervalMs: value as number }),
    ).toThrow(TypeError);
  });

  it.each([
    ['the same options', undefined, undefined],
    ['the default interval spelled out', undefined, GATE_CONSTANTS.poll_interval_default_ms],
    ['two intervals below the floor', 1_000, GATE_CONSTANTS.poll_interval_floor_ms],
  ])('shares one engine per process (%s): a second server keeps the first one\'s cold backoff', async (_label, firstInterval, secondInterval) => {
    answer({ error: 'unavailable' }, 503);
    const first = newServer();
    const second = newServer();
    for (const [server, pollIntervalMs] of [[first, firstInterval], [second, secondInterval]] as const) {
      registerEcho(server);
      installProofHoldings(server as unknown as McpServerLike, { token: TOKEN, cacheDir: dir, pollIntervalMs });
    }
    await (await connect(first)).callTool({ name: 'echo', arguments: { mode: 'fast' } });
    expect(fetchCalls).toHaveLength(2);
    await (await connect(second)).callTool({ name: 'echo', arguments: { mode: 'fast' } });
    expect(fetchCalls).toHaveLength(2);
    expect(handlerCalls).toBe(2);
  });

  it('uses PROOF_CACHE_DIR when cacheDir is unset', async () => {
    vi.stubEnv('PROOF_CACHE_DIR', dir);
    const server = newServer();
    registerEcho(server);
    installProofHoldings(server as unknown as McpServerLike, { token: TOKEN });
    const client = await connect(server);
    await client.callTool({ name: 'echo', arguments: { mode: 'fast' } });
    expect(existsSync(join(dir, `${verdictCacheKey(TOKEN)}.json`))).toBe(true);
    expect(readdirSync(dir)).toContain(`${verdictCacheKey(TOKEN)}.json`);
  });

  it('throws with a token when the server exposes no request-handler map', () => {
    const stub = { registerTool: vi.fn(), server: {} } as unknown as McpServerLike;
    expect(() => installProofHoldings(stub, { token: TOKEN, cacheDir: dir })).toThrow(/_requestHandlers/);
    expect(stub.registerTool).not.toHaveBeenCalled();
  });

  it.each([
    ['no server field', {}],
    ['a plain object instead of a Map', { server: { _requestHandlers: {} } }],
  ])('throws with a token on %s', (_label, shape) => {
    const stub = { registerTool: vi.fn(), ...shape } as unknown as McpServerLike;
    expect(() => installProofHoldings(stub, { token: TOKEN, cacheDir: dir })).toThrow(/ungated/);
  });

  it('throws, and withdraws the status tool, when no tools/call handler was registered', () => {
    const remove = vi.fn();
    const stub = {
      registerTool: vi.fn(() => ({ remove })),
      server: { _requestHandlers: new Map() },
    } as unknown as McpServerLike;
    expect(() => installProofHoldings(stub, { token: TOKEN, cacheDir: dir })).toThrow(/no tools\/call handler/);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('installs the status tool and gates nothing without a token, whatever the server shape', () => {
    const stub = { registerTool: vi.fn(), server: {} } as unknown as McpServerLike;
    expect(() => installProofHoldings(stub, { cacheDir: dir })).not.toThrow();
    expect(stub.registerTool).toHaveBeenCalledWith(STATUS_TOOL_NAME, expect.anything(), expect.any(Function));
  });

  it('refuses a server with no registerTool', () => {
    expect(() => installProofHoldings({ server: { _requestHandlers: new Map() } } as unknown as McpServerLike, { token: TOKEN })).toThrow(
      /registerTool/,
    );
  });
});
