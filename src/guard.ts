import {
  assertInstallableBeforeRegistration,
  assertNotAlreadyInstalled,
  markInstalled,
  readInstallKind,
  wrapRegistrar,
  type McpServerLike,
  type ToolRegistrar,
} from './registrar.js';
import type { GuardOptions } from './types.js';
import { resolveOptions } from './verdict.js';

export type { McpServerLike, ToolRegistrar };

/**
 * Replaces `server.tool.bind(server)` as the registrar every `registerTools(tool, http)` module
 * receives. Must run before ANY `server.tool()`/`registerTool()` call — `.bind()` snapshots the
 * function value, so patching `server.tool` after a publisher already captured it has no effect
 * (this is why the package IS the bind point, not a side-effecting call placed elsewhere).
 *
 * With no `opts.token`, this is a no-op: returns the server's own bound `tool`, makes zero network
 * calls, and does not touch `_registeredTools` at all (SC-7).
 *
 * A publisher who also wants the three Proof showcase tools inside their server calls
 * `installProofLayer` (`install.ts`) INSTEAD of this — not in addition to it. The order that
 * function performs cannot be reproduced by composing the two from the outside, which is why it is
 * a separate entry point rather than an option here.
 */
export function guardDelegation(server: McpServerLike, opts: GuardOptions): ToolRegistrar {
  // A REPEAT of the opt-out is idempotent, not an error: it gated nothing the first time and would
  // hand back the identical raw registrar, so throwing would crash a startup over a benign pair
  // while asserting a layer that is not installed. Anything else — an opt-out after a gate, or a
  // gated call after either — still refuses below.
  if (!opts.token && readInstallKind(server) === 'optout') {
    return server.tool.bind(server);
  }

  // Checked BEFORE the opt-out otherwise: a no-token call on a GATED server is still a caller
  // running both entry points, and answering it silently would hide the same mistake.
  assertNotAlreadyInstalled(server, 'guardDelegation');

  if (!opts.token) {
    // The opt-out HANDS OUT a registrar — the raw, un-gated one — so it counts as having installed,
    // and the marker must be set here too. Without it the reverse order was silently broken:
    // `guardDelegation({no token})` gave the publisher the raw `server.tool`, a later
    // `installProofLayer({token})` passed both preconditions and patched the instance, and every
    // tool registered through the registrar the publisher was still holding ran UNGATED under a
    // revoked delegation. Measured in code review; the token-present direction was already covered
    // and this one was not.
    markInstalled(server, 'optout');
    return server.tool.bind(server);
  }

  assertInstallableBeforeRegistration(server, 'guardDelegation');

  const resolved = resolveOptions({ ...opts, token: opts.token });

  const originalTool = server.tool.bind(server);
  const wrappedTool = wrapRegistrar(originalTool, resolved);

  markInstalled(server, 'gated');

  // Patch the instance too — not just returning the wrapper — so any OTHER code path that later
  // does its own `server.tool.bind(server)` or calls `server.tool(...)` directly still gates.
  server.tool = wrappedTool;

  // registerTool is a second, independent public SDK entry point that also populates
  // _registeredTools — leaving it unwrapped would let a publisher register a fully unguarded
  // tool through it while the pre-registration throw above stays silent (nothing was registered
  // yet at guard-install time).
  if (typeof server.registerTool === 'function') {
    const originalRegisterTool = server.registerTool.bind(server);
    server.registerTool = wrapRegistrar(originalRegisterTool, resolved);
  }

  return wrappedTool;
}
