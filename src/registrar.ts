import { refusalMessage } from './refusal.js';
import { errorResult } from './result.js';
import { currentVerdict, type ResolvedOptions } from './verdict.js';

export type ToolRegistrar = (...args: unknown[]) => unknown;

/**
 * Records that this package has already run on a server, and WHICH WAY.
 *
 * A registry-wide `Symbol.for` so a duplicated copy of this package in one process still sees it.
 * Both entry points set it and both check it, because the dangerous combination is silent: after
 * `guardDelegation` runs, nothing is registered and `server.tool` is already the gating wrapper, so
 * `installProofLayer`'s precondition passes and it registers the showcase THROUGH the gate — and a
 * revoked delegation then kills `proof_check_this_server`, the exact failure this package's second
 * entry point exists to prevent. Measured in code review; it manifests only at revocation time.
 *
 * The KIND matters because the two states are not the same fact. `gated` means a gate is installed
 * and a registrar was handed out. `optout` means only the second half: `guardDelegation` with no
 * token returned the server's RAW registrar and gated nothing. Recording them identically made a
 * benign repeat of the opt-out crash the publisher's startup with a message asserting a layer that
 * is not there — introduced by the fix for the real hole, caught in the next review round.
 */
export type InstallKind = 'gated' | 'optout';

export const INSTALLED_MARKER = Symbol.for('proof-holdings.delegation-self-refusal.installed');

export function readInstallKind(server: McpServerLike): InstallKind | undefined {
  const value = (server as McpServerLike & Record<symbol, unknown>)[INSTALLED_MARKER];
  if (value === 'optout') return 'optout';
  // ANY other truthy value reads as `gated`, not as absent. The marker key is a `Symbol.for`, so it
  // is shared with every OTHER copy of this package in the process — and the direction that matters
  // is FORWARD: a newer copy may write a kind this version has never heard of, and a strict
  // two-string check would read such a server as untouched and install a second layer over an
  // existing gate. (An earlier version of this comment justified the widening by a copy written
  // BEFORE kinds existed. That was false and a reviewer proved it: the marker string appears in no
  // commit — `git log --all -S` finds nothing — and no version of this package had been published
  // at the time, so the FIRST installable version already carries kinds. The rule is right; the
  // story was not.)
  // Erring toward `gated` errs toward refusing, which is the direction that cannot silently ungate
  // anything; the cost is a clear error where an exotic combination might have been survivable.
  if (value) return 'gated';
  return undefined;
}

export function markInstalled(server: McpServerLike, kind: InstallKind): void {
  (server as McpServerLike & Record<symbol, unknown>)[INSTALLED_MARKER] = kind;
}

/**
 * Refuses a second call that cannot cover the registrar a first call already handed out.
 *
 * The two states fail for OPPOSITE reasons, which is why one summary cannot serve both. After
 * `gated`, a second call would install over a working gate. After `optout`, the raw registrar stays
 * perfectly VALID and simply bypasses whatever is installed next — nothing invalidated it. The
 * message below is picked from the kind for that reason: claiming an installed layer where only a
 * raw registrar was handed out sends the reader looking for something that does not exist.
 */
export function assertNotAlreadyInstalled(server: McpServerLike, entryPoint: string): void {
  const kind = readInstallKind(server);
  if (kind === undefined) return;

  if (kind === 'optout') {
    throw new Error(
      `${entryPoint}: a previous call with no token already handed out this server's RAW ` +
        'registrar. Whatever is installed now cannot cover it — tools registered through the ' +
        'registrar that is already out would bypass it. Configure the token before the first ' +
        'call, or keep using the un-gated one.',
    );
  }

  // No per-case CONSEQUENCE in the text. The previous tail ("running both leaves the showcase
  // gated by it") held only where a showcase is registered after a gate exists, and was false in
  // guard→guard (no showcase anywhere) and install→guard (the showcase is already registered,
  // un-gated, and a later gate cannot retroactively cover it). What IS true in all four gated
  // cells is only the state and the instruction, so that is all this says.
  throw new Error(
    `${entryPoint}: this server already carries the Proof self-refusal layer. Install it exactly ` +
      'ONCE — call either guardDelegation or installProofLayer, never both (installProofLayer ' +
      'includes the gate).',
  );
}

/**
 * The subset of `McpServer` this package touches, expressed structurally so no runtime import of
 * `@modelcontextprotocol/sdk` is needed (it stays a dev-only dependency for typing tests).
 * `_registeredTools` is undocumented SDK internal state — the only field that exposes "how many
 * tools are registered" (mcp/node_modules/@modelcontextprotocol/sdk/dist/cjs/server/mcp.js:18-22).
 * `registerTool` is optional because older SDK versions may not expose it, but when present it is
 * a SECOND, independent public entry point that also populates `_registeredTools`
 * (mcp.js:660,701) — both must be gated, or a publisher who calls it instead of `.tool()` gets a
 * completely unguarded handler.
 *
 * `server` mirrors `McpServer.server` — a public field holding the underlying `Server` instance,
 * whose private `_instructions` (`server/index.js:53`) is what `install.ts`'s showcase-recognition
 * write targets. Optional for the same reason as `_registeredTools`: a stand-in in a test, or an
 * SDK shape this package has never seen, may not carry it at all.
 */
export interface McpServerLike {
  tool: ToolRegistrar;
  registerTool?: ToolRegistrar;
  _registeredTools?: Record<string, unknown>;
  server?: { _instructions?: unknown };
}

/**
 * The shared precondition both entry points check: the SDK must expose `_registeredTools`, and
 * nothing may be registered yet. Placed late, this package does nothing — `.bind()` snapshots the
 * function value — so refusing to run is the only honest answer to "installed too late".
 */
export function assertInstallableBeforeRegistration(server: McpServerLike, entryPoint: string): void {
  // The entry point is a PARAMETER because this message is read by a publisher staring at a
  // startup crash: naming `guardDelegation` when they called `installProofLayer` sends them to fix
  // a function they never invoked — the same ambiguity SC-13 exists to remove at the other
  // precondition.
  if (server._registeredTools === undefined) {
    throw new Error(
      `${entryPoint}: the installed @modelcontextprotocol/sdk McpServer does not expose ` +
        '_registeredTools — this package cannot verify no tools were registered before the gate ' +
        'and refuses to run silently unguarded. Pin a known-compatible SDK version.',
    );
  }

  const alreadyRegistered = Object.keys(server._registeredTools);
  if (alreadyRegistered.length > 0) {
    throw new Error(
      `${entryPoint} must run before any server.tool()/registerTool() call — ` +
        `${alreadyRegistered.length} tool(s) already registered: ${alreadyRegistered.join(', ')}`,
    );
  }
}

/**
 * Wraps a registrar (`server.tool` or `server.registerTool` — both take the handler as their
 * final positional argument) so every call through it is gated on `currentVerdict`.
 *
 * The dispatch check is a deliberate ALLOW-LIST (`kind === 'valid'` runs the handler; anything
 * else, including a shape `currentVerdict`'s return type does not admit but that could reach here
 * through some future bug, refuses) rather than a deny-list keyed on `'refused'` — a security gate
 * must default to denying what it does not positively recognize as authorized.
 *
 * The handler's own arguments are passed through OPAQUELY: never read, indexed, logged or
 * serialized. This package runs inside someone else's production process, where those arguments
 * are that publisher's user data — `src/__tests__/drift/mcp-showcase.test.ts` pins the property
 * behaviourally rather than trusting this comment.
 */
export function wrapRegistrar(original: ToolRegistrar, opts: ResolvedOptions): ToolRegistrar {
  return (...args: unknown[]) => {
    const handler = args[args.length - 1];
    if (typeof handler !== 'function') {
      return original(...args);
    }

    const gatedHandler = async (...handlerArgs: unknown[]) => {
      const verdict = await currentVerdict(opts);
      if (verdict.kind === 'valid') {
        return (handler as (...a: unknown[]) => unknown)(...handlerArgs);
      }
      return errorResult(refusalMessage(opts.principal, verdict.reason));
    };

    return original(...args.slice(0, -1), gatedHandler);
  };
}
