import type { GateConstants } from './constants.js';
import type { PollResult } from './reasons.js';

/** The pure core of `docs/mcp-delegation-gate-contract.md` §§ 2, 3 and 6: no I/O and no clock. */

export type Verdict = { kind: 'valid' } | { kind: 'refused'; code: string };

export interface KeyRotationEpisode {
  pulls: number;
  next_pull_at: number;
}

export interface GateRecord {
  verdict: Verdict;
  checked_at: number;
  key_rotation?: KeyRotationEpisode;
}

export interface InfoRecord {
  unresolved_since: number | null;
}

export interface TokenRecords {
  gate: GateRecord | null;
  info: InfoRecord;
}

export interface Mem {
  backoff_until: number | null;
  status_polled_at: number | null;
}

export type DecideOutcome =
  | 'refuse(local_expired)'
  | 'refuse(local_malformed)'
  | 'refuse(cached_refused)'
  | 'serve'
  | 'serve+refresh'
  | 'await'
  | 'await_cold'
  | 'await_pull'
  | 'run_unvalidated';

export type PullOutcome = { kind: 'accepted'; token: string } | { kind: 'rejected'; reason: string };

export type LocalExpiry = 'ok' | 'expired' | 'malformed';

export function emptyRecords(): TokenRecords {
  return { gate: null, info: { unresolved_since: null } };
}

export function localExpiry(exp: unknown, now: number, c: GateConstants): LocalExpiry {
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return 'malformed';
  return now > exp * 1000 + c.exp_leeway_ms ? 'expired' : 'ok';
}

export function effectiveInterval(configured: number | undefined, c: GateConstants): number {
  return Math.max(configured ?? c.poll_interval_default_ms, c.poll_interval_floor_ms);
}

export function pullDue(episode: KeyRotationEpisode, now: number, c: GateConstants): boolean {
  return episode.pulls < c.pull_cap && now >= episode.next_pull_at;
}

export function pullGapMs(failedPulls: number, c: GateConstants): number {
  return Math.min(c.pull_first_gap_ms * c.pull_gap_factor ** Math.max(0, failedPulls - 1), c.pull_max_gap_ms);
}

export function decide(
  gate: GateRecord | null,
  now: number,
  intervalMs: number,
  mem: Mem,
  exp: unknown,
  c: GateConstants,
): DecideOutcome {
  const local = localExpiry(exp, now, c);
  if (local === 'malformed') return 'refuse(local_malformed)';
  if (local === 'expired') return 'refuse(local_expired)';

  if (gate?.key_rotation) return pullDue(gate.key_rotation, now, c) ? 'await_pull' : 'refuse(cached_refused)';

  if (mem.backoff_until !== null && now < mem.backoff_until) {
    if (!gate) return 'run_unvalidated';
    return gate.verdict.kind === 'valid' ? 'serve' : 'refuse(cached_refused)';
  }

  if (!gate) return 'await_cold';

  const age = now - gate.checked_at;
  if (age < 0) return 'await';
  if (age < intervalMs * c.stale_refresh_multiple) {
    return gate.verdict.kind === 'valid' ? 'serve' : 'refuse(cached_refused)';
  }
  if (age <= intervalMs * c.stale_await_multiple) return 'serve+refresh';
  return 'await';
}

export function applyPoll(records: TokenRecords, result: PollResult, at: number): TokenRecords {
  if (result.kind === 'key_revoked' && records.gate?.key_rotation) {
    return { gate: { ...records.gate, checked_at: at }, info: { unresolved_since: null } };
  }
  switch (result.kind) {
    case 'valid':
      return { gate: { verdict: { kind: 'valid' }, checked_at: at }, info: { unresolved_since: null } };
    case 'refused':
      return {
        gate: { verdict: { kind: 'refused', code: result.code }, checked_at: at },
        info: { unresolved_since: null },
      };
    case 'key_revoked':
      return {
        gate: {
          verdict: { kind: 'refused', code: 'key_revoked' },
          checked_at: at,
          key_rotation: { pulls: 0, next_pull_at: at },
        },
        info: { unresolved_since: null },
      };
    case 'unresolved':
      return { gate: records.gate, info: { unresolved_since: records.info.unresolved_since ?? at } };
  }
}

export function applyPull(
  records: TokenRecords,
  outcome: PullOutcome,
  at: number,
  c: GateConstants,
): { records: TokenRecords; token: string | null } {
  if (outcome.kind === 'accepted') return { records: emptyRecords(), token: outcome.token };
  const gate = records.gate;
  if (!gate?.key_rotation) throw new Error('applyPull without an open key-rotation episode');
  const pulls = gate.key_rotation.pulls + 1;
  const code = pulls >= c.pull_cap ? 'reissue_unavailable' : 'key_revoked';
  return {
    records: {
      gate: {
        verdict: { kind: 'refused', code },
        checked_at: gate.checked_at,
        key_rotation: { pulls, next_pull_at: at + pullGapMs(pulls, c) },
      },
      info: records.info,
    },
    token: null,
  };
}
