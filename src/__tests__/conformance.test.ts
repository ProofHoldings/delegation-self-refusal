import { readFileSync } from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RecordStore } from '../cache.js';
import { replacementCacheKey, verdictCacheKey } from '../cache.js';
import { GATE_CONSTANTS } from '../constants.js';
import { classifyPollAnswer, BACKEND_DEFINITIVE_REASONS, KEY_ROTATION_REASONS, LOCAL_DEFINITIVE_REASONS, LOCAL_TRANSPORT_REASONS, refusalCodeOf, UNRECOGNIZED_REFUSAL, UNRESOLVED_BACKEND_REASONS } from '../reasons.js';
import { emptyRecords, type Mem, type PullOutcome, type TokenRecords } from '../core.js';
import { GateEngine, type GateDecision } from '../engine.js';
import { gateTextEnvelope, installProofHoldings, type McpServerLike } from '../installProofHoldings.js';
import { checkPulledToken } from '../pickup.js';
import type { PollResult } from '../reasons.js';
import { REFUSAL_TEXTS, refusalEnvelope } from '../refusal.js';
import { statusOutput, statusOutputSchema } from '../status.js';

/**
 * The TypeScript gate's runner for the shared fixtures in `sdks/shared/fixtures/mcp_delegation_gate`
 * (`docs/mcp-delegation-gate-contract.md` § 14). Decision cases replay against the real engine,
 * driven by fake timers and scripted transports.
 */

const FIXTURES = new URL('../../../../sdks/shared/fixtures/mcp_delegation_gate/', import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function fixture(name: string): Json {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('constants.json', () => {
  it('equals the package constants', () => {
    const { _note, ...constants } = fixture('constants.json');
    expect(_note).toBeTypeOf('string');
    expect(GATE_CONSTANTS).toEqual(constants);
  });
});

describe('reasons.json', () => {
  const table = fixture('reasons.json');
  const rows: Json[] = table.rows;
  const select = (predicate: (row: Json) => boolean) => rows.filter(predicate).map((row) => row.reason).sort();

  it('holds the same reasons in the same classes as the package', () => {
    expect([...BACKEND_DEFINITIVE_REASONS].sort()).toEqual(
      select((row) => row.class === 'definitive' && row.origin.includes('backend')),
    );
    expect([...LOCAL_DEFINITIVE_REASONS].sort()).toEqual(
      select((row) => row.class === 'definitive' && row.origin.includes('local')),
    );
    expect([...KEY_ROTATION_REASONS].sort()).toEqual(select((row) => row.class === 'key_rotation'));
    expect([...UNRESOLVED_BACKEND_REASONS].sort()).toEqual(
      select((row) => row.class === 'unresolved' && row.origin.includes('backend')),
    );
    expect([...LOCAL_TRANSPORT_REASONS].sort()).toEqual(
      select((row) => row.class === 'unresolved' && row.origin.includes('local')),
    );
  });

  it('gives every refusing reason the envelope code and retryable flag of its row', () => {
    for (const row of rows.filter((r) => r.error !== null)) {
      expect({ reason: row.reason, ...refusalCodeOf(row.reason) }).toEqual({
        reason: row.reason,
        error: row.error,
        retryable: row.retryable,
      });
    }
    expect(refusalCodeOf('not_a_reason')).toEqual({
      error: table.unknown_reason.error,
      retryable: table.unknown_reason.retryable,
    });
    expect(UNRECOGNIZED_REFUSAL).toBe(table.unknown_reason.error);
  });

  it('refuses no retired reason', () => {
    for (const row of rows.filter((r) => r.class === 'retired')) {
      expect(refusalCodeOf(row.reason).error).toBe(UNRECOGNIZED_REFUSAL);
    }
  });
});

describe('refusal_texts.json', () => {
  it('equals the package templates and phrases', () => {
    const { _note, ...texts } = fixture('refusal_texts.json');
    expect(_note).toBeTypeOf('string');
    expect(REFUSAL_TEXTS).toEqual(texts);
  });
});

describe('poll_answers.json', () => {
  const cases: Json[] = fixture('poll_answers.json').cases;
  it.each(cases.map((c) => [c.id, c]))('%s', (_id, testCase) => {
    const { answer, expect: expected } = testCase;
    if (answer.transport) {
      expect(LOCAL_TRANSPORT_REASONS as readonly string[]).toContain(answer.transport);
      expect(expected).toEqual({ kind: 'unresolved', reason: answer.transport });
      return;
    }
    expect(classifyPollAnswer({ httpStatus: answer.http_status, body: answer.body })).toEqual(expected);
  });
});

describe('cache_keys.json', () => {
  const file = fixture('cache_keys.json');
  it.each((file.cases as Json[]).map((c) => [c.id, c]))('%s', (_id, testCase) => {
    const derive = testCase.kind === 'verdict' ? verdictCacheKey : replacementCacheKey;
    expect(derive(testCase.token, testCase.base_url)).toBe(testCase.expect_hex);
  });
});

describe('pickup_lineage.json', () => {
  const file = fixture('pickup_lineage.json');
  it.each((file.cases as Json[]).map((c) => [c.id, c]))('%s', (_id, testCase) => {
    expect(checkPulledToken(testCase.old ?? file.old, testCase.pulled, testCase.now ?? file.now, testCase.mode ?? 'rotation')).toBe(
      testCase.expect,
    );
  });
});

describe('status_cases.json', () => {
  const cases: Json[] = fixture('status_cases.json').cases;
  it.each(cases.map((c) => [c.id, c]))('%s', (_id, testCase) => {
    const output = statusOutput(testCase.input, GATE_CONSTANTS);
    expect(output).toEqual(testCase.expect);
    expect(JSON.parse(JSON.stringify(output))).toEqual(testCase.expect);
    expect(statusOutputSchema().safeParse(output).success).toBe(true);
  });

  it('the output schema refuses an undeclared field', () => {
    const output = statusOutput(cases[0].input, GATE_CONSTANTS);
    expect(statusOutputSchema().safeParse({ ...output, extra: true }).success).toBe(false);
    expect(
      statusOutputSchema().safeParse({ ...output, delegation: { ...output.delegation, extra: true } }).success,
    ).toBe(false);
  });
});

/** What a JSON Schema node admits, read the same way from the contract file and from the SDK's listing. */
function shape(node: Json): Json {
  if (!node || typeof node !== 'object') return node;
  const types = new Set<string>();
  const add = (value: Json) => (Array.isArray(value) ? value : value === undefined ? [] : [value]).forEach((t: string) => types.add(t));
  add(node.type);
  for (const branch of node.anyOf ?? []) add(branch.type);
  const format = node.format ?? (node.anyOf ?? []).map((branch: Json) => branch.format).find(Boolean);
  if (node.enum) node.enum.forEach((value: unknown) => types.add(typeof value));
  if (node.const !== undefined) types.add(typeof node.const);
  const out: Json = { types: [...types].sort() };
  if (format) out.format = format;
  if (node.enum) out.enum = [...node.enum].sort();
  if (node.const !== undefined) out.const = node.const;
  if (node.properties) {
    out.properties = Object.fromEntries(Object.entries(node.properties).map(([key, value]) => [key, shape(value)]));
    out.required = [...(node.required ?? [])].sort();
    out.additionalProperties = node.additionalProperties;
  }
  return out;
}

describe('status.schema.json', () => {
  it('is what the status tool lists as its outputSchema', async () => {
    const server = new McpServer({ name: 'publisher', version: '1.0.0' });
    installProofHoldings(server as unknown as McpServerLike, {});
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'consumer', version: '1.0.0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const { tools } = await client.listTools();
    const listed = tools.find((tool) => tool.name === 'proof_holdings_status')?.outputSchema;
    expect(shape(listed)).toEqual(shape(fixture('status.schema.json')));
    expect(shape(listed).properties.delegation.properties.issued_at).toEqual({ types: ['null', 'string'], format: 'date-time' });
  });
});

/** Text cases that parse an API `<code>: ` prefix: `mcp/src`'s `errorResult`, never a gate's. */
const MCP_SRC_ONLY_ENVELOPE_CASES = [
  'text_invalid_arguments',
  'text_not_found',
  'text_unauthorized',
  'text_2fa_required',
  'text_rate_limited',
  'text_timeout',
  'text_network_error',
  'text_service_unavailable',
  'text_rate_limit_exceeded',
  'text_http_429',
  'text_http_503',
  'text_unavailable_503',
  'text_http_500',
  'text_identity_declined',
  'text_challenge_delivery_failed',
  'text_pass_through_unlisted_code',
  'text_no_code_is_internal_error',
  'text_uppercase_prefix_is_not_a_code',
  'text_message_bounded',
  'text_token_redacted',
];
const GATE_TEXT_CASES = [
  'text_sdk_validation_error_rewritten',
  'text_sdk_output_validation_error',
  'text_sdk_output_validation_error_bounded',
];

describe('envelope_cases.json', () => {
  const cases: Json[] = fixture('envelope_cases.json').cases;

  it('every case is either run here or named as mcp/src-only', () => {
    const run = cases.filter((c) => c.kind === 'refusal').map((c) => c.id).concat(GATE_TEXT_CASES);
    expect([...run, ...MCP_SRC_ONLY_ENVELOPE_CASES].sort()).toEqual(cases.map((c) => c.id).sort());
    expect(new Set([...run, ...MCP_SRC_ONLY_ENVELOPE_CASES]).size).toBe(cases.length);
  });

  it.each(cases.filter((c) => c.kind === 'refusal').map((c) => [c.id, c]))('%s', (_id, testCase) => {
    expect(refusalEnvelope(testCase.reason, testCase.principal)).toEqual(testCase.expect);
  });

  it.each(cases.filter((c) => GATE_TEXT_CASES.includes(c.id)).map((c) => [c.id, c]))('%s', (_id, testCase) => {
    expect(gateTextEnvelope(testCase.text)).toEqual(testCase.expect);
  });
});

// --------------------------------------------------------------------------------------------
// Decision cases — replayed against the real engine
// --------------------------------------------------------------------------------------------

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function caseToken(name: string, spec: Json): string {
  const payload: Record<string, unknown> = {
    sub: name,
    principal: 'example.com',
    delegate: 'pkg:npm/example-mcp',
    iat: 1798761000,
  };
  if (spec && Object.hasOwn(spec, 'exp')) payload.exp = spec.exp;
  return `${b64({ alg: 'none', kid: name })}.${b64(payload)}.sig`;
}

function trackingStore(): RecordStore & { records: Map<string, TokenRecords> } {
  const records = new Map<string, TokenRecords>();
  const replacements = new Map<string, string>();
  const clone = (value: TokenRecords) => JSON.parse(JSON.stringify(value)) as TokenRecords;
  return {
    records,
    readRecords: (token) => clone(records.get(token) ?? emptyRecords()),
    writeRecords: (token, value) => void records.set(token, clone(value)),
    deleteRecords: (token) => void records.delete(token),
    readReplacement: (configured) => replacements.get(configured) ?? null,
    writeReplacement: (configured, token) => void replacements.set(configured, token),
  };
}

function toPollResult(response: Json): PollResult {
  switch (response.answer) {
    case 'valid':
      return { kind: 'valid' };
    case 'refused':
      return { kind: 'refused', code: response.reason };
    case 'key_revoked':
      return { kind: 'key_revoked' };
    case 'unresolved':
      return { kind: 'unresolved', reason: response.reason };
    default:
      throw new Error(`a poll consumed a non-poll response: ${JSON.stringify(response)}`);
  }
}

function after<T>(ms: number, value: T): Promise<T> {
  return ms <= 0 ? Promise.resolve(value) : new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

async function replay(testCase: Json) {
  const names = new Map<string, string>();
  const tokens = new Map<string, string>();
  for (const [name, spec] of Object.entries(testCase.tokens ?? {})) {
    const token = caseToken(name, spec);
    names.set(token, name);
    tokens.set(name, token);
  }
  const real = (name: string) => {
    const token = tokens.get(name);
    if (!token) throw new Error(`case ${testCase.id}: unknown token ${name}`);
    return token;
  };
  const nameOf = (token: string | null) => (token === null ? null : (names.get(token) ?? token));

  const events: Json[] = [...testCase.events].sort((a, b) => a.at - b.at);
  vi.useFakeTimers({ now: events[0].at, toFake: ['setTimeout', 'clearTimeout', 'Date'] });

  const store = trackingStore();
  for (const [name, records] of Object.entries(testCase.cache_in ?? {})) store.writeRecords(real(name), records as TokenRecords);

  const responses: Json[] = [...testCase.responses];
  const requests: Json[] = [];
  const next = () => {
    const response = responses.shift();
    if (!response) throw new Error(`case ${testCase.id}: ran out of scripted responses`);
    return response;
  };

  const engine = new GateEngine({
    token: testCase.configured_token === null ? null : real(testCase.configured_token),
    pollIntervalMs: testCase.opts?.poll_interval_ms,
    store,
    warn: () => undefined,
    poll: (token, trigger, timeoutMs) => {
      requests.push({ at: Date.now(), kind: 'poll', trigger, token: nameOf(token) });
      const response = next();
      const result = toPollResult(response);
      const latency =
        result.kind === 'unresolved' && result.reason === 'timeout' ? timeoutMs : Math.min(response.latency_ms ?? 0, timeoutMs);
      return after(latency, result);
    },
    pull: (token, timeoutMs, mode) => {
      requests.push({ at: Date.now(), kind: 'pull', trigger: mode === 'renewal' ? 'renewal' : 'gate', token: nameOf(token) });
      const response = next();
      if (!('pull' in response)) throw new Error(`case ${testCase.id}: a pull consumed a poll response`);
      const outcome: PullOutcome =
        response.pull === 'accepted' ? { kind: 'accepted', token: real(response.token) } : { kind: 'rejected', reason: response.reason };
      return after(Math.min(response.latency_ms ?? 0, timeoutMs), outcome);
    },
  });
  Object.assign(engine.mem, testCase.mem_in ?? {});

  const calls: Json[] = [];
  const pending: Array<Promise<void>> = [];
  for (const event of events) {
    await vi.advanceTimersByTimeAsync(event.at - Date.now());
    const entry: Json = { at: event.at, call: event.call };
    calls.push(entry);
    if (event.call === 'status') {
      pending.push(
        engine.status().then(({ output }) => {
          Object.assign(entry, {
            outcome: 'status',
            result: 'status',
            status: output.delegation.status,
            source: output.delegation.source,
            done_at: Date.now(),
          });
        }),
      );
    } else {
      pending.push(
        engine.gate().then((decision: GateDecision) => {
          Object.assign(entry, {
            outcome: decision.outcome,
            result: decision.result,
            ...(decision.code !== undefined ? { code: decision.code } : {}),
            ...(decision.neverValidated ? { never_validated: true } : {}),
            done_at: Date.now(),
          });
        }),
      );
    }
    await vi.advanceTimersByTimeAsync(0);
  }
  for (let round = 0; round < 50 && (pending.length > 0 || vi.getTimerCount() > 0); round += 1) {
    await vi.runAllTimersAsync();
    await Promise.all(pending.splice(0));
  }
  await engine.idle();

  const cacheOut: Record<string, TokenRecords> = {};
  for (const [token, records] of store.records) cacheOut[nameOf(token) as string] = records;
  return {
    calls,
    requests,
    cache_out: cacheOut,
    configured_token_out: nameOf(engine.activeToken()),
    mem: { ...engine.mem } as Mem,
    unconsumed: responses.length,
  };
}

describe('decision_cases.json — replayed against the engine', () => {
  const cases: Json[] = fixture('decision_cases.json').cases;

  it('has cases to replay', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases.map((c) => [c.id, c]))('%s', async (_id, testCase) => {
    const out = await replay(testCase);
    expect(out.unconsumed).toBe(0);
    expect(out.calls).toEqual(testCase.expect.calls);
    expect(out.requests).toEqual(testCase.expect.requests);
    expect(out.cache_out).toEqual(testCase.expect.cache_out);
    if (testCase.expect.configured_token_out !== undefined) {
      expect(out.configured_token_out).toBe(testCase.expect.configured_token_out);
    }
    for (const [field, value] of Object.entries(testCase.expect.mem_out ?? {})) {
      expect({ field, value: out.mem[field as keyof Mem] }).toEqual({ field, value });
    }
  });
});
