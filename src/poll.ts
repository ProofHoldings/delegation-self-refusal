import { SURFACE_HEADER, SURFACE_VALUE, TRIGGER_HEADER } from './constants.js';
import { classifyPollAnswer, type PollResult, type UnresolvedReason } from './reasons.js';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type PollTrigger = 'gate' | 'status';

const TLS_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/** Headers every poll and pull carries; a status poll adds the trigger (§ 12). */
export function surfaceHeaders(trigger?: PollTrigger): Record<string, string> {
  const headers: Record<string, string> = { [SURFACE_HEADER]: SURFACE_VALUE };
  if (trigger === 'status') headers[TRIGGER_HEADER] = 'status';
  return headers;
}

export function transportReason(error: unknown, timedOut: boolean): UnresolvedReason {
  if (timedOut) return 'timeout';
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && TLS_ERROR_CODES.has(code)) return 'tls_error';
    current = (current as { cause?: unknown }).cause;
  }
  return 'network_error';
}

/** A fetch bounded by a timer the caller's clock controls, so fake timers can drive it. */
export async function boundedFetch<T>(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  read: (response: Response) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; reason: UnresolvedReason }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    return { ok: true, value: await read(response) };
  } catch (error) {
    return { ok: false, reason: transportReason(error, timedOut) };
  } finally {
    clearTimeout(timer);
  }
}

export interface PollOptions {
  baseUrl: string;
  timeoutMs: number;
  trigger: PollTrigger;
  fetch?: FetchLike;
}

/** `POST {baseUrl}/api/v1/proofs/validate`, classified (§ 4). Never throws. */
export async function pollValidate(token: string, options: PollOptions): Promise<PollResult> {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const outcome = await boundedFetch(
    fetchImpl,
    joinUrl(options.baseUrl, '/api/v1/proofs/validate'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...surfaceHeaders(options.trigger) },
      body: JSON.stringify({ proof_token: token }),
      redirect: 'error',
    },
    options.timeoutMs,
    async (response) => {
      const text = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      return { httpStatus: response.status, body };
    },
  );
  if (!outcome.ok) return { kind: 'unresolved', reason: outcome.reason };
  return classifyPollAnswer(outcome.value);
}
