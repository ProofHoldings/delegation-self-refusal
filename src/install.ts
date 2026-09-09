import { DEFAULT_BASE_URL } from './poll.js';
import {
  assertInstallableBeforeRegistration,
  assertNotAlreadyInstalled,
  markInstalled,
  wrapRegistrar,
  type McpServerLike,
  type ToolRegistrar,
} from './registrar.js';
import type { GuardOptions } from './types.js';
import { resolveOptions } from './verdict.js';
import { createBreaker } from './showcase/breaker.js';
import { createLayerSurfaceFetch, createMarkedFetch } from './showcase/marked-fetch.js';
import { registerShowcase, SHOWCASE_TOOL_NAMES } from './showcase/tools.js';
import { showcaseInstructionsParagraph } from './showcase/instructions.js';

/** Version reported in the `X-Proof-Surface` header. Kept in lockstep with package.json by a drift test. */
export const SHOWCASE_VERSION = '0.1.0';

export interface InstallProofLayerOptions extends GuardOptions {}

/**
 * Installs the self-refusal gate AND the three-tool Proof showcase in one call — the alternative
 * to `guardDelegation` for a publisher who wants their users to see Proof inside the server they
 * already have.
 *
 * The ORDER below is the whole reason this is a separate entry point rather than a flag, and it is
 * not reproducible by composing the two halves from outside:
 *
 *   1. precondition — nothing registered yet, and this layer not already installed;
 *   2. capture the ORIGINAL, un-gated registrars;
 *   3. register the showcase through them;
 *   4. append the Proof recognition paragraph to `server.server._instructions` — unconditionally,
 *      on both the token and no-token paths, degrading silently on either failure class (the field
 *      absent, or the read/write throwing) rather than aborting an otherwise-successful install;
 *   5. only then patch `server.tool` / `server.registerTool` with the gate;
 *   6. return the gating registrar.
 *
 * Registering the showcase BEFORE `guardDelegation` is impossible — it throws on any pre-existing
 * tool (`registrar.ts`'s precondition), taking the publisher's server down at startup. Registering
 * it AFTER means the gate covers it, and a revoked delegation kills `proof_check_this_server` —
 * the one tool whose job is to report that revocation. Hence: inside, between capture and patch.
 *
 * The un-gated registrar captured at step 2 is never returned and never exported WHEN A TOKEN IS
 * CONFIGURED. A publisher who got hold of it could route their own tool around the gate, silently
 * nulling the self-enforcement while the installation still looked correct from the outside (SC-2).
 * The one exception is the no-token path below, which returns exactly that registrar — correctly,
 * since with no token nothing is gated at all and it is identical to `guardDelegation`'s opt-out.
 * Stated rather than left as an absolute, because an unqualified claim beside a guard is the kind
 * of sentence that stops being read once it is false.
 *
 * With no `opts.token` the showcase is still installed but NOTHING is gated — the same opt-out
 * `guardDelegation` offers, and `proof_check_this_server` then reports `configured: false` rather
 * than dressing the absence up as a positive verdict.
 */
/**
 * Appends the Proof recognition paragraph to `server.server._instructions` (SC-1..6), the SDK's
 * private field the `initialize` handler reads on every connection. Never throws: called between
 * `markInstalled` (already committed) and the no-token early return, a throw here would abort an
 * otherwise-successful install after the gate is already live.
 *
 * Two failure classes, one degradation: `server.server` may simply not exist (an unrecognized SDK
 * shape, or a test double) — handled by the early return; or reading/building/writing
 * `_instructions` may throw (a frozen object, a future getter-only field) — handled by the
 * try/catch. Both leave the server exactly as capable as it was before this call, just without the
 * paragraph.
 *
 * Truthy check, not `typeof === 'string'` (SC-1): the SDK itself treats an empty string as absent
 * (`server/index.js`'s `...(this._instructions && {instructions: this._instructions})`), so
 * appending after one would silently double as "replace nothing with the paragraph" — which is the
 * outcome the truthy check already produces on its own, without a special case.
 */
function appendShowcaseInstructions(server: McpServerLike, principal: string): void {
  const inner = server.server;
  if (inner === undefined) return;

  try {
    const existing = inner._instructions;
    const paragraph = showcaseInstructionsParagraph(principal);
    inner._instructions = existing ? `${existing}\n\n${paragraph}` : paragraph;
  } catch {
    // Read or write threw — degrade silently, the gate above is already live.
  }
}

export function installProofLayer(server: McpServerLike, opts: InstallProofLayerOptions): ToolRegistrar {
  assertNotAlreadyInstalled(server, 'installProofLayer');
  assertInstallableBeforeRegistration(server, 'installProofLayer');

  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const resolved = opts.token
    ? resolveOptions({ ...opts, token: opts.token, fetchImpl: createLayerSurfaceFetch(SHOWCASE_VERSION) })
    : null;

  const originalTool = server.tool.bind(server);
  const originalRegisterTool =
    typeof server.registerTool === 'function' ? server.registerTool.bind(server) : undefined;

  try {
    registerShowcase(originalTool, {
      resolved,
      principal: opts.principal,
      baseUrl,
      verifyBreaker: createBreaker(),
      connectBreaker: createBreaker(),
      markedFetch: createMarkedFetch(SHOWCASE_VERSION),
    });
  } catch (error) {
    // ALL-OR-NOTHING. A throw on the second or third registration would otherwise leave one or two
    // Proof-named tools on a server whose `tool`/`registerTool` were never patched — so a
    // publisher who defensively wraps this call in try/catch would run with ZERO self-refusal while
    // advertising tools that imply otherwise. The trigger is not hypothetical: it is the duplicate
    // `zod` instance SC-17 exists to prevent, failing inside the SDK's schema conversion. Rolling
    // back also keeps a retry possible — otherwise the precondition check would see OUR tools and
    // answer with the message written for a publisher who registered first.
    for (const name of SHOWCASE_TOOL_NAMES) {
      delete (server._registeredTools as Record<string, unknown>)[name];
    }
    throw error;
  }

  // The kind must match what actually happened: with no token this call installs NO gate and
  // returns the RAW registrar below — which is the definition of `optout`, not `gated`. Recording
  // it as gated made every later refusal on such a server assert a layer that is not there: the
  // very defect the kind split was introduced to remove, surviving on the other entry point.
  // The POSITION stays above the no-token return — a round-3 finding rests on it.
  markInstalled(server, resolved ? 'gated' : 'optout');

  appendShowcaseInstructions(server, opts.principal);

  if (!resolved) {
    return originalTool;
  }

  const wrappedTool = wrapRegistrar(originalTool, resolved);
  server.tool = wrappedTool;

  if (originalRegisterTool) {
    server.registerTool = wrapRegistrar(originalRegisterTool, resolved);
  }

  return wrappedTool;
}
