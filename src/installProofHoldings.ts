import { resolve } from 'node:path';

import { createDiskStore, defaultCacheDir, normalizeBaseUrl } from './cache.js';
import { DEFAULT_BASE_URL, GATE_CONSTANTS, STATUS_TOOL_NAME } from './constants.js';
import { effectiveInterval } from './core.js';
import { GateEngine } from './engine.js';
import { pullReissuedDelegation } from './pickup.js';
import { pollValidate } from './poll.js';
import { boundText, envelopeResult, redact, refusalEnvelope } from './refusal.js';
import { statusOutputSchema } from './status.js';
import { principalOf } from './token.js';
import { rewriteValidationError } from './validationRewrite.js';

export interface InstallProofHoldingsOptions {
  /** The delegation token. Absent or empty: nothing is gated and no instructions line is added. */
  token?: string;
  /** Default 300 000; a lower value is raised to 60 000. */
  pollIntervalMs?: number;
  /** Default `PROOF_CACHE_DIR`, then `~/.proof-holdings/delegation-self-refusal`. */
  cacheDir?: string;
  /** Default `https://api.proof.holdings`. */
  baseUrl?: string;
}

type RequestHandler = (request: unknown, extra: unknown) => Promise<unknown>;

/** The parts of `McpServer` this package touches, typed structurally (the SDK is not a runtime dependency). */
export interface McpServerLike {
  registerTool: (name: string, config: Record<string, unknown>, handler: (...args: unknown[]) => unknown) => unknown;
  server?: { _requestHandlers?: unknown; _instructions?: unknown };
}

const INSTALLED_MARKER = Symbol.for('proof-holdings.delegation-self-refusal.installed');

const STATUS_DESCRIPTION =
  "Reports whether this server's Proof of Delegation holds, as answered by proof.holdings, its issuer: " +
  'the status, the delegating principal, the delegate and the expiry. Read-only; takes no arguments.';

export function instructionsLine(principal: string): string {
  return `Verified by Proof Holdings (delegated by ${boundText(principal, GATE_CONSTANTS.principal_max_chars)}). Call ${STATUS_TOOL_NAME} for details.`;
}

function redactAll(text: string, tokens: Array<string | null>): string {
  return tokens.reduce<string>((value, token) => redact(value, token ?? undefined), text);
}

/** The -32602 rewrite, applied to a copy whose text no longer carries the token (contract § 8). */
function rewriteRedacted(result: unknown, tokens: Array<string | null>): unknown {
  if (rewriteValidationError(result) === result) return result;
  const r = result as { content: Array<{ type: 'text'; text: string }> };
  return rewriteValidationError({ ...r, content: [{ ...r.content[0], text: redactAll(r.content[0].text, tokens) }] });
}

/**
 * One engine per process for each (token, baseUrl, cacheDir, effective interval): a server built per request
 * or per session still shares the single-flight operation, the backoff and the status throttle
 * (contract § 1 `mem`, § 3).
 */
const engines = new Map<string, GateEngine>();

function engineFor(token: string | null, baseUrl: string, cacheDir: string, pollIntervalMs: number | undefined): GateEngine {
  const key = JSON.stringify([token, normalizeBaseUrl(baseUrl), cacheDir, effectiveInterval(pollIntervalMs, GATE_CONSTANTS)]);
  let engine = engines.get(key);
  if (!engine) {
    engine = new GateEngine({
      token,
      pollIntervalMs,
      store: createDiskStore({ dir: cacheDir, baseUrl }),
      poll: (pollToken, trigger, timeoutMs) => pollValidate(pollToken, { baseUrl, timeoutMs, trigger }),
      pull: (previousToken, timeoutMs) => pullReissuedDelegation({ previousToken, baseUrl, cacheDir, timeoutMs }),
    });
    engines.set(key, engine);
  }
  return engine;
}

function requestHandlersOf(server: McpServerLike): Map<string, RequestHandler> | null {
  const handlers = server.server?._requestHandlers;
  return handlers instanceof Map ? (handlers as Map<string, RequestHandler>) : null;
}

/**
 * Installs the delegation gate on an MCP server: one `proof_holdings_status` tool outside the gate,
 * a wrapper around the SDK's `tools/call` handler that refuses before the original handler (and
 * the SDK's input validation) runs, and one line in the server's instructions.
 */
export function installProofHoldings(server: McpServerLike, opts: InstallProofHoldingsOptions = {}): void {
  if (!server || typeof server !== 'object') throw new TypeError('installProofHoldings: server must be an McpServer');
  if ((server as unknown as Record<symbol, unknown>)[INSTALLED_MARKER]) {
    throw new Error('installProofHoldings: this server already carries the Proof Holdings gate; install it once.');
  }
  if (typeof server.registerTool !== 'function') {
    throw new Error(
      'installProofHoldings: this McpServer has no registerTool(); upgrade @modelcontextprotocol/sdk to a version that has it.',
    );
  }

  if (opts.pollIntervalMs !== undefined && (typeof opts.pollIntervalMs !== 'number' || !Number.isFinite(opts.pollIntervalMs))) {
    throw new TypeError('installProofHoldings: pollIntervalMs must be a finite number of milliseconds.');
  }

  const token = opts.token && opts.token.length > 0 ? opts.token : null;
  if (token !== null && !requestHandlersOf(server)) {
    throw new Error(
      'installProofHoldings: the installed @modelcontextprotocol/sdk does not expose server._requestHandlers as a Map, ' +
        'so the gate cannot be installed and tools would run ungated. Pin a known-compatible SDK version.',
    );
  }

  const engine = engineFor(token, opts.baseUrl ?? DEFAULT_BASE_URL, resolve(opts.cacheDir ?? defaultCacheDir()), opts.pollIntervalMs);

  const registered = server.registerTool(
    STATUS_TOOL_NAME,
    {
      title: 'Proof Holdings delegation status',
      description: STATUS_DESCRIPTION,
      outputSchema: statusOutputSchema(),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { output } = await engine.status();
      return { structuredContent: output, content: [{ type: 'text', text: JSON.stringify(output) }] };
    },
  ) as { remove?: () => void } | undefined;

  if (token !== null) {
    const handlers = requestHandlersOf(server);
    const original = handlers?.get('tools/call');
    if (!handlers || typeof original !== 'function') {
      registered?.remove?.();
      throw new Error(
        'installProofHoldings: the installed @modelcontextprotocol/sdk registered no tools/call handler where this ' +
          'package expects it, so tools would run ungated. Pin a known-compatible SDK version.',
      );
    }

    const gated: RequestHandler = async (request, extra) => {
      const params = (request as { params?: { name?: unknown } } | null)?.params;
      if (params?.name === STATUS_TOOL_NAME) return original(request, extra);
      const decision = await engine.gate();
      if (decision.result === 'refuse') {
        const active = decision.token ?? token;
        const envelope = refusalEnvelope(decision.code ?? 'invalid', principalOf(active), active);
        return envelopeResult({ ...envelope, message: redact(envelope.message, token) });
      }
      const result = await original(request, extra);
      try {
        return rewriteRedacted(result, [token, decision.token]);
      } catch {
        return result;
      }
    };
    handlers.set('tools/call', gated);

    const inner = server.server as { _instructions?: unknown };
    const line = instructionsLine(principalOf(token));
    inner._instructions = typeof inner._instructions === 'string' && inner._instructions ? `${inner._instructions}\n\n${line}` : line;
  }

  Object.defineProperty(server, INSTALLED_MARKER, { value: true, enumerable: false });
}
