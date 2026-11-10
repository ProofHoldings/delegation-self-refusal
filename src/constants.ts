export const GATE_VERSION = '0.5.1';

export const STATUS_TOOL_NAME = 'proof_holdings_status';

export const DEFAULT_BASE_URL = 'https://api.proof.holdings';

export const SURFACE_HEADER = 'X-Proof-Surface';
export const TRIGGER_HEADER = 'X-Proof-Trigger';
export const SURFACE_VALUE = `gate/ts/${GATE_VERSION}`;

/** The contract's constants (`docs/mcp-delegation-gate-contract.md` § 5). */
export const GATE_CONSTANTS = {
  poll_interval_default_ms: 300_000,
  poll_interval_floor_ms: 60_000,
  stale_refresh_multiple: 1,
  stale_await_multiple: 3,
  blocking_attempt_timeout_ms: 4_000,
  background_refresh_timeout_ms: 10_000,
  cold_retry_delay_ms: 1_000,
  cold_cycle_cap_ms: 10_000,
  backoff_cached_ms: 30_000,
  backoff_cold_interval_multiple: 1,
  validate_memo_ttl_ms: 5_000,
  status_poll_throttle_ms: 60_000,
  exp_leeway_ms: 300_000,
  expires_soon_ms: 1_209_600_000,
  pull_cap: 5,
  pull_first_gap_ms: 30_000,
  pull_gap_factor: 4,
  pull_max_gap_ms: 600_000,
  lineage_clock_tolerance_ms: 5_000,
  renewal_pull_gap_ms: 3_600_000,
  message_max_chars: 200,
  principal_max_chars: 64,
} as const;

export type GateConstants = { [K in keyof typeof GATE_CONSTANTS]: number };

/** At most 64 KiB of a pulled token's body is read (§ 6). */
export const MAX_PULL_BODY_BYTES = 64 * 1024;
