import { describe, expect, it } from 'vitest';

import { GATE_CONSTANTS as C } from '../constants.js';
import { applyPoll, applyPull, decide, effectiveInterval, emptyRecords, pullGapMs, type GateRecord, type Mem } from '../core.js';
import { boundText, redact, REDACTED, refusalEnvelope } from '../refusal.js';

const NOW = 1_800_000_000_000;
const EXP = NOW / 1000 + 86_400;
const I = C.poll_interval_default_ms;
const NO_MEM: Mem = { backoff_until: null, status_polled_at: null };

const valid = (age: number): GateRecord => ({ verdict: { kind: 'valid' }, checked_at: NOW - age });
const refused = (age: number): GateRecord => ({ verdict: { kind: 'refused', code: 'revoked' }, checked_at: NOW - age });

describe('decide', () => {
  it.each([
    ['exp missing', null, NO_MEM, undefined, 'refuse(local_malformed)'],
    ['exp not numeric', valid(0), NO_MEM, '1800', 'refuse(local_malformed)'],
    ['past exp plus the leeway', valid(0), NO_MEM, (NOW - C.exp_leeway_ms - 1) / 1000, 'refuse(local_expired)'],
    ['exactly at exp plus the leeway', valid(0), NO_MEM, (NOW - C.exp_leeway_ms) / 1000, 'serve'],
    ['no verdict', null, NO_MEM, EXP, 'await_cold'],
    ['no verdict inside a backoff', null, { ...NO_MEM, backoff_until: NOW + 1 }, EXP, 'run_unvalidated'],
    ['a stale refusal inside a backoff', refused(10 * I), { ...NO_MEM, backoff_until: NOW + 1 }, EXP, 'refuse(cached_refused)'],
    ['a future checked_at', valid(-1), NO_MEM, EXP, 'await'],
    ['age just below I', valid(I - 1), NO_MEM, EXP, 'serve'],
    ['a refusal younger than I', refused(I - 1), NO_MEM, EXP, 'refuse(cached_refused)'],
    ['age exactly I', valid(I), NO_MEM, EXP, 'serve+refresh'],
    ['age exactly 3I', valid(3 * I), NO_MEM, EXP, 'serve+refresh'],
    ['age past 3I', valid(3 * I + 1), NO_MEM, EXP, 'await'],
  ] as const)('%s', (_label, gate, mem, exp, outcome) => {
    expect(decide(gate, NOW, I, mem, exp, C)).toBe(outcome);
  });

  it('an episode with a pull due awaits the pull; without one it serves the refusal', () => {
    const episode = (next: number, pulls = 0): GateRecord => ({
      verdict: { kind: 'refused', code: 'key_revoked' },
      checked_at: NOW,
      key_rotation: { pulls, next_pull_at: next },
    });
    expect(decide(episode(NOW), NOW, I, NO_MEM, EXP, C)).toBe('await_pull');
    expect(decide(episode(NOW + 1), NOW, I, NO_MEM, EXP, C)).toBe('refuse(cached_refused)');
    expect(decide(episode(NOW, C.pull_cap), NOW, I, NO_MEM, EXP, C)).toBe('refuse(cached_refused)');
  });

  it('runs a below-floor interval on the floor and an unset one on the default', () => {
    expect(effectiveInterval(1_000, C)).toBe(C.poll_interval_floor_ms);
    expect(effectiveInterval(undefined, C)).toBe(C.poll_interval_default_ms);
  });
});

describe('applyPoll', () => {
  it('a decided answer overwrites the verdict and clears unresolved_since', () => {
    const before = { gate: refused(5), info: { unresolved_since: NOW - 10 } };
    expect(applyPoll(before, { kind: 'valid' }, NOW)).toEqual({
      gate: { verdict: { kind: 'valid' }, checked_at: NOW },
      info: { unresolved_since: null },
    });
  });

  it('an unresolved answer keeps the verdict and sets unresolved_since once', () => {
    const first = applyPoll({ gate: valid(5), info: { unresolved_since: null } }, { kind: 'unresolved', reason: 'timeout' }, NOW);
    expect(first).toEqual({ gate: valid(5), info: { unresolved_since: NOW } });
    expect(applyPoll(first, { kind: 'unresolved', reason: 'http_error' }, NOW + 9)).toEqual(first);
  });

  it('key_revoked opens an episode, and inside one only stamps checked_at', () => {
    const opened = applyPoll(emptyRecords(), { kind: 'key_revoked' }, NOW);
    expect(opened.gate).toEqual({
      verdict: { kind: 'refused', code: 'key_revoked' },
      checked_at: NOW,
      key_rotation: { pulls: 0, next_pull_at: NOW },
    });
    const later = applyPull(opened, { kind: 'rejected', reason: 'pull_unavailable' }, NOW + 1, C).records;
    expect(applyPoll(later, { kind: 'key_revoked' }, NOW + 5).gate).toEqual({ ...later.gate, checked_at: NOW + 5 });
  });
});

describe('applyPull', () => {
  it('spaces rejected pulls 30 s, 2 min, 8 min, 10 min and turns the fifth into reissue_unavailable', () => {
    let records = applyPoll(emptyRecords(), { kind: 'key_revoked' }, NOW);
    const gaps: number[] = [];
    for (let pull = 1; pull <= C.pull_cap; pull += 1) {
      records = applyPull(records, { kind: 'rejected', reason: 'pull_not_found' }, NOW, C).records;
      gaps.push(records.gate!.key_rotation!.next_pull_at - NOW);
    }
    expect(gaps.slice(0, 4)).toEqual([30_000, 120_000, 480_000, 600_000]);
    expect(pullGapMs(5, C)).toBe(C.pull_max_gap_ms);
    expect(records.gate!.verdict).toEqual({ kind: 'refused', code: 'reissue_unavailable' });
  });

  it('an accepted pull hands back the token with empty records', () => {
    const opened = applyPoll(emptyRecords(), { kind: 'key_revoked' }, NOW);
    expect(applyPull(opened, { kind: 'accepted', token: 'T2' }, NOW, C)).toEqual({ records: emptyRecords(), token: 'T2' });
  });
});

describe('refusal envelope', () => {
  it('bounds a long principal and keeps every message within message_max_chars', () => {
    const principal = 'é'.repeat(200);
    for (const code of ['revoked', 'key_revoked', 'reissue_unavailable', 'not_a_reason']) {
      const { message } = refusalEnvelope(code, principal);
      expect(message).toContain(`${'é'.repeat(C.principal_max_chars - 1)}…`);
      expect([...message].length).toBeLessThanOrEqual(C.message_max_chars);
    }
  });

  it('replaces every occurrence of the token', () => {
    expect(redact('a TOKEN b TOKEN', 'TOKEN')).toBe(`a ${REDACTED} b ${REDACTED}`);
    expect(redact('unchanged', undefined)).toBe('unchanged');
    expect(refusalEnvelope('revoked', 'TOKEN.example', 'TOKEN').message).toContain(`${REDACTED}.example`);
  });

  it('cuts by code point, never inside a surrogate pair', () => {
    expect(boundText('😀'.repeat(5), 3)).toBe('😀😀…');
  });
});
