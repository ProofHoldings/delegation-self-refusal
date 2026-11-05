import { GATE_CONSTANTS, type GateConstants } from './constants.js';
import {
  applyPoll,
  applyPull,
  decide,
  effectiveInterval,
  emptyRecords,
  localExpiry,
  pullGapMs,
  type DecideOutcome,
  type Mem,
  type PullOutcome,
  type TokenRecords,
} from './core.js';
import type { RecordStore } from './cache.js';
import { replacementAcceptable } from './pickup.js';
import type { PollTrigger } from './poll.js';
import type { PollResult } from './reasons.js';
import { statusOutput, type StatusOutput } from './status.js';
import { statusClaims, tokenExp } from './token.js';

/**
 * The shell around the pure core (`docs/mcp-delegation-gate-contract.md` §§ 2, 3, 6, 10): it runs
 * the poll or pull an outcome asks for, applies the answer to the records as they are when it
 * arrives, persists them and keeps the per-process memory.
 */

export type PollFn = (token: string, trigger: PollTrigger, timeoutMs: number) => Promise<PollResult>;
export type PullFn = (token: string, timeoutMs: number) => Promise<PullOutcome & { detail?: string }>;

export interface EngineDeps {
  token: string | null;
  pollIntervalMs?: number;
  store: RecordStore;
  poll: PollFn;
  pull: PullFn;
  now?: () => number;
  constants?: GateConstants;
  warn?: (line: string) => void;
}

export type GateOutcome = DecideOutcome;

export interface GateDecision {
  outcome: GateOutcome;
  result: 'run' | 'refuse';
  code?: string;
  neverValidated?: boolean;
  token: string | null;
}

export interface StatusAnswer {
  output: StatusOutput;
}

type Settled = TokenRecords & { local?: string };

interface Operation {
  kind: 'await' | 'pull' | 'refresh';
  token: string;
  promise: Promise<Settled>;
  decided: boolean;
}

function verdictOf(records: TokenRecords): Pick<GateDecision, 'result' | 'code' | 'neverValidated'> {
  const gate = records.gate;
  if (!gate) return { result: 'run', neverValidated: true };
  return gate.verdict.kind === 'valid' ? { result: 'run' } : { result: 'refuse', code: gate.verdict.code };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GateEngine {
  readonly mem: Mem = { backoff_until: null, status_polled_at: null };
  private readonly configured: string | null;
  private active: string | null;
  private replacementChecked = false;
  private readonly interval: number;
  private readonly c: GateConstants;
  private readonly now: () => number;
  private readonly warn: (line: string) => void;
  private awaited: Operation | null = null;
  private refresh: Operation | null = null;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(private readonly deps: EngineDeps) {
    this.configured = deps.token && deps.token.length > 0 ? deps.token : null;
    this.active = this.configured;
    this.c = deps.constants ?? GATE_CONSTANTS;
    this.interval = effectiveInterval(deps.pollIntervalMs, this.c);
    this.now = deps.now ?? Date.now;
    this.warn = deps.warn ?? ((line) => process.stderr.write(`${line}\n`));
  }

  get intervalMs(): number {
    return this.interval;
  }

  /** The token the gate runs on: the configured one, or the re-signed one that replaced it. */
  activeToken(): string | null {
    this.adoptReplacement();
    return this.active;
  }

  /** Resolves once every operation in flight has settled. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  async gate(): Promise<GateDecision> {
    const token = this.activeToken();
    if (token === null) return { outcome: 'serve', result: 'run', token: null };

    const shared = this.awaited;
    if (shared && (shared.token === token || shared.kind === 'pull')) {
      const outcome: GateOutcome = shared.kind === 'pull' ? 'await_pull' : this.read(token).gate ? 'await' : 'await_cold';
      const settled = await shared.promise;
      if (settled.local) return { outcome, result: 'refuse', code: settled.local, token: this.active };
      return { outcome, ...verdictOf(settled), token: this.active };
    }

    const now = this.now();
    const records = this.read(token);
    const outcome = decide(records.gate, now, this.interval, this.mem, tokenExp(token), this.c);
    switch (outcome) {
      case 'refuse(local_expired)':
        return { outcome, result: 'refuse', code: 'expired', token };
      case 'refuse(local_malformed)':
        return { outcome, result: 'refuse', code: 'malformed', token };
      case 'refuse(cached_refused)':
      case 'serve':
        return { outcome, ...verdictOf(records), token };
      case 'run_unvalidated':
        return { outcome, result: 'run', neverValidated: true, token };
      case 'serve+refresh':
        if (!this.refresh) this.startRefresh(token);
        return { outcome, ...verdictOf(records), token };
      case 'await':
        return { outcome, ...verdictOf(await this.startAwaited('await', token, (op) => this.runAwait(token, op))), token };
      case 'await_cold':
        return { outcome, ...verdictOf(await this.startAwaited('await', token, (op) => this.runCold(token, op))), token };
      case 'await_pull': {
        const settled = await this.startAwaited('pull', token, (op) => this.runPull(token, op));
        if (settled.local) return { outcome, result: 'refuse', code: settled.local, token: this.active };
        return { outcome, ...verdictOf(settled), token: this.active };
      }
    }
  }

  async status(): Promise<StatusAnswer> {
    const token = this.activeToken();
    if (token === null) {
      return { output: this.output(null, emptyRecords(), this.now(), 'cache') };
    }
    const now = this.now();
    const throttled =
      this.mem.status_polled_at !== null && now - this.mem.status_polled_at < this.c.status_poll_throttle_ms;
    if (throttled) return { output: this.output(token, this.read(token), now, 'cache') };
    this.mem.status_polled_at = now;

    const shared = [this.awaited, this.refresh].find(
      (op): op is Operation => op !== null && op.kind !== 'pull' && op.token === token,
    );
    if (shared) {
      const records = await shared.promise;
      return { output: this.output(token, records, this.now(), shared.decided ? 'live' : 'cache') };
    }

    const result = await this.poll(token, 'status', this.c.blocking_attempt_timeout_ms);
    const at = this.now();
    const records = this.apply(token, [{ result, at }]);
    return { output: this.output(token, records, at, result.kind === 'unresolved' ? 'cache' : 'live') };
  }

  private output(token: string | null, records: TokenRecords, now: number, source: 'live' | 'cache'): StatusOutput {
    return statusOutput(
      { configured: token !== null, claims: token === null ? null : statusClaims(token), records, now, source },
      this.c,
    );
  }

  private adoptReplacement(): void {
    if (this.replacementChecked || this.configured === null) return;
    this.replacementChecked = true;
    const replacement = this.deps.store.readReplacement(this.configured);
    if (replacement && replacement !== this.configured && replacementAcceptable(this.configured, replacement, this.now())) {
      this.active = replacement;
    }
  }

  private read(token: string): TokenRecords {
    return this.deps.store.readRecords(token);
  }

  /** Applies answers in order to the records as they are now; an answer for a swapped-out token is dropped. */
  private apply(token: string, answers: Array<{ result: PollResult; at: number }>): TokenRecords {
    const settled = answers.reduce((records, answer) => applyPoll(records, answer.result, answer.at), this.read(token));
    if (token === this.active) this.deps.store.writeRecords(token, settled);
    return settled;
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inFlight.add(promise);
    void promise.finally(() => this.inFlight.delete(promise)).catch(() => undefined);
    return promise;
  }

  private async poll(token: string, trigger: PollTrigger, timeoutMs: number): Promise<PollResult> {
    try {
      return await this.deps.poll(token, trigger, timeoutMs);
    } catch {
      return { kind: 'unresolved', reason: 'network_error' };
    }
  }

  private startAwaited(kind: Operation['kind'], token: string, run: (op: Operation) => Promise<Settled>): Promise<Settled> {
    const op = { kind, token, decided: false } as Operation;
    this.awaited = op;
    op.promise = this.track(
      run(op).finally(() => {
        if (this.awaited === op) this.awaited = null;
      }),
    );
    return op.promise;
  }

  private async runAwait(token: string, op: Operation): Promise<Settled> {
    const result = await this.poll(token, 'gate', this.c.blocking_attempt_timeout_ms);
    const at = this.now();
    op.decided = result.kind !== 'unresolved';
    const records = this.apply(token, [{ result, at }]);
    if (result.kind === 'unresolved' && token === this.active) this.mem.backoff_until = at + this.c.backoff_cached_ms;
    return records;
  }

  private async runCold(token: string, op: Operation): Promise<Settled> {
    const started = this.now();
    const answers: Array<{ result: PollResult; at: number }> = [];
    let result = await this.poll(token, 'gate', this.c.blocking_attempt_timeout_ms);
    answers.push({ result, at: this.now() });
    if (result.kind === 'unresolved') {
      await delay(this.c.cold_retry_delay_ms);
      const remaining = started + this.c.cold_cycle_cap_ms - this.now();
      if (remaining > 0) {
        result = await this.poll(token, 'gate', Math.min(this.c.blocking_attempt_timeout_ms, remaining));
        answers.push({ result, at: this.now() });
      }
    }
    const end = answers[answers.length - 1].at;
    op.decided = result.kind !== 'unresolved';
    const records = this.apply(token, answers);
    if (result.kind === 'unresolved' && token === this.active) {
      this.mem.backoff_until = end + this.interval * this.c.backoff_cold_interval_multiple;
    }
    return records;
  }

  private startRefresh(token: string): void {
    const op = { kind: 'refresh', token, decided: false } as Operation;
    this.refresh = op;
    op.promise = this.track(
      (async () => {
        try {
          const result = await this.poll(token, 'gate', this.c.background_refresh_timeout_ms);
          op.decided = result.kind !== 'unresolved';
          return this.apply(token, [{ result, at: this.now() }]);
        } catch {
          return this.read(token);
        } finally {
          if (this.refresh === op) this.refresh = null;
        }
      })(),
    );
  }

  private async pullOnce(token: string): Promise<PullOutcome & { detail?: string }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<PullOutcome>((resolve) => {
      timer = setTimeout(
        () => resolve({ kind: 'rejected', reason: 'pull_unavailable' }),
        this.c.blocking_attempt_timeout_ms,
      );
    });
    try {
      return await Promise.race([
        this.deps.pull(token, this.c.blocking_attempt_timeout_ms).catch(
          (): PullOutcome => ({ kind: 'rejected', reason: 'pull_unavailable' }),
        ),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async runPull(token: string, op: Operation): Promise<Settled> {
    const outcome = await this.pullOnce(token);
    const at = this.now();
    const current = this.read(token);
    if (!current.gate?.key_rotation) return current;
    const applied = applyPull(current, outcome, at, this.c);
    if (applied.token === null) {
      this.deps.store.writeRecords(token, applied.records);
      const pulls = applied.records.gate?.key_rotation?.pulls ?? 0;
      const reason = outcome.kind === 'rejected' ? outcome.reason : 'unknown';
      const detail = outcome.kind === 'rejected' && outcome.detail ? ` (${outcome.detail})` : '';
      this.warn(
        `delegation-self-refusal: re-signed delegation not accepted (pull ${pulls} of ${this.c.pull_cap}): ${reason}${detail}`,
      );
      return applied.records;
    }
    return this.swap(token, applied.token, at, op);
  }

  private async swap(previous: string, token: string, at: number, op: Operation): Promise<Settled> {
    if (this.configured !== null) this.deps.store.writeReplacement(this.configured, token);
    this.deps.store.deleteRecords(previous);
    this.active = token;
    this.deps.store.writeRecords(token, emptyRecords());

    const local = localExpiry(tokenExp(token), at, this.c);
    if (local !== 'ok') return { ...emptyRecords(), local };

    const result = await this.poll(token, 'gate', this.c.blocking_attempt_timeout_ms);
    const end = this.now();
    op.decided = result.kind !== 'unresolved';
    let records = applyPoll(this.read(token), result, end);
    if (result.kind === 'key_revoked' && records.gate?.key_rotation) {
      records = {
        ...records,
        gate: { ...records.gate, key_rotation: { pulls: 0, next_pull_at: end + pullGapMs(1, this.c) } },
      };
    }
    if (token === this.active) {
      this.deps.store.writeRecords(token, records);
      if (result.kind === 'unresolved') this.mem.backoff_until = end + this.interval * this.c.backoff_cold_interval_multiple;
    }
    return records;
  }
}
