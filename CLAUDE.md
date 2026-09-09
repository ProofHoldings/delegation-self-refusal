# Delegation Self-Refusal CLAUDE.md

## Purpose

`@proof-holdings/delegation-self-refusal` — a delegated MCP server refuses its own tool calls
once its Proof of Delegation is revoked, suspended, or has expired. The reasoning is
`b-brainstorm-revocation-delivery`'s: a
revoked delegation only reaches a reader who asks, and roughly half never do
(`docs/agent-instruction-compliance.md`). The mechanism this package implements moves the check
from the reader — who might not ask — to the delegated server itself, which gates its own
dispatch and cannot be silently ignored the way an unasked question can.

## Narrative Summary

This is the mirror image of `packages/delegation-verifier`. The verifier is what a **caller**
runs to check someone else's delegation before trusting them — issuer-agnostic, no default
trust list, run by a non-customer. This package is what the **delegated server itself** runs, and
it is neither issuer-agnostic nor a verifier in that sense: it always polls proof.holdings'
`POST /api/v1/proofs/validate`, because that is the only registry that can answer for a
proof.holdings-issued delegation. A publisher installs it; a consumer of the delegated server
does nothing at all — the enforcement is entirely on the side that already holds the token.

**Scope limit, accepted knowingly and stated everywhere this package is described:** it binds a
*cooperative* server. It does not defend against a hostile operator who deletes the wiring — that
case is a separate concern (a Proof Holdings MCP checker the consumer installs, not this
package).

## Key Files

- `src/guard.ts` — `guardDelegation(server, opts)`, the entry point. Must run before any
  `server.tool()`/`registerTool()` call: `.bind()` on an MCP `McpServer` snapshots the function
  value, so this package positions itself as *the* replacement for
  `const tool = server.tool.bind(server)` rather than a side-effecting call placed elsewhere —
  placed late, it does nothing. Detects "installed after tools were already registered" by
  reading the SDK's undocumented internal `_registeredTools` field (there is no public API for
  this) and throws rather than running silently unguarded. With no `opts.token` it gates nothing —
  zero network calls, and it returns before the pre-registration check even runs, so a publisher who
  registered tools first is not refused for a gate they opted out of. It is NOT a no-op, and the
  difference is load-bearing: it hands out the raw registrar and RECORDS that (`markInstalled(…,
  'optout')`), which is the whole reason a later token-carrying call can be refused instead of
  patching a server whose registrar is already out.
  **Patches BOTH `server.tool` and
  `server.registerTool`** — the SDK exposes two independent public registration entry points that
  both populate `_registeredTools` (`mcp.js:660,701`), and gating only the first leaves the second a
  complete, silent bypass. The precondition check and the wrapper themselves live in
  `src/registrar.ts` and the verdict machine in `src/verdict.ts`, so `installProofLayer` runs the
  identical gate rather than a parallel one; this file is only the `guardDelegation` shape around
  them. The shared
  `wrapRegistrar(original, opts)` helper wraps whichever registrar is passed it, since both take
  the handler as their final positional argument. Its `currentVerdict` dispatch check is
  an ALLOW-list (`kind === 'valid'` runs the handler; anything else denies) rather than a deny-list
  keyed on `'refused'` — deliberately, so an unrecognized verdict shape fails closed instead of
  open; `cache.ts`'s `readCache` independently validates `lastDecided`'s shape for the same reason,
  so this is defense in depth, not the only line of defense.
- `src/poll.ts` — `pollDelegationStatus`, the only network call the GATE makes (the showcase's two
  outbound tools make their own, on their own budgets — see `src/showcase/`). Maps the
  issuer's response to `valid` / `refused` (a definitive answer — revoked, suspended, expired,
  unknown, invalid) / `unresolved` (the fetch itself failed, a non-2xx, a non-boolean `valid`
  field, OR the issuer answered `reason: 'status_unavailable'` — its own registry lookup failed
  server-side, which is not a "no"). Every call carries `AbortSignal.timeout(DEFAULT_TIMEOUT_MS)`
  (10s default) — mirrors `packages/delegation-verifier/src/status.ts`'s identical fetch-timeout
  and strict `typeof body.valid !== 'boolean'` pattern against the same backend contract.
- `src/cache.ts` — on-disk cache, one JSON file per token (keyed by its SHA-256), under
  `~/.proof-holdings/delegation-self-refusal/` by default. Deliberately not in-memory: a stdio
  MCP server is commonly spawned per session and dies with it, so an in-memory failure counter
  would reset every session and a persisted counter is required to make "N consecutive failures"
  mean anything. `readCache` validates `lastDecided`'s shape (`isValidLastDecided`) and treats an
  unrecognized `kind` as a corrupt file (same as a JSON parse failure), rather than trusting
  whatever shape a future version or a hand-edited file might contain. `writeCache` failures are
  swallowed by `verdict.ts`'s `safeWriteCache` (logged to `console.error`, never `console.log` —
  stdout is the MCP stdio transport itself) so a filesystem error never discards an
  already-computed verdict or throws out of a gated handler.
- `src/registrar.ts` — `wrapRegistrar`, `assertInstallableBeforeRegistration`, the entry-point
  marker (`INSTALLED_MARKER`/`InstallKind`/`readInstallKind`/`markInstalled`/
  `assertNotAlreadyInstalled`, see § the two entry points below) and the structural
  `McpServerLike`/`ToolRegistrar` types, held here so `guard.ts` and `install.ts` share ONE gate
  implementation rather than a second one that merely agrees under test. Its gated handler
  passes the publisher's handler arguments through OPAQUELY — never read, indexed, logged or
  serialized — pinned behaviourally (a counting `Proxy`, not a grep for `JSON.stringify`) by
  `../../src/__tests__/drift/mcp-showcase.test.ts`. Its refusal text comes from `refusal.ts`; it
  holds no template of its own. `McpServerLike` also carries an optional `server?: { _instructions?:
  unknown }`, mirroring `McpServer.server` → `Server._instructions` in the real SDK — the field
  `install.ts`'s recognition-paragraph write targets, structurally typed for the same reason as
  `_registeredTools`: a test double or an unrecognized SDK shape may not carry it.
- `src/refusal.ts` — `refusalMessage(principal, reason)` and `REFUSAL_DETAILS_URL`, the
  reason→phrase map behind every refusal the gate and the showcase emit. `index.ts` re-exports both:
  a publisher rendering their own status page has the machine `reason` and would otherwise invent a
  second sentence their callers never see. The gate is SILENT on success, so under `guardDelegation`
  alone this string is often the only thing Proof ever says to a caller; under `installProofLayer`
  it is not, since the showcase's own tool descriptions (`showcase/descriptions.ts`) already name
  Proof and the revocation risk before any refusal fires. Either way it names Proof, names the
  publisher, gives one link and gives ONE action that can resolve the state it describes. Which is
  why the two reason classes are
  split rather than templated: `PUBLISHER_DECISION_REASONS` (the issuer ANSWERED no) carries
  "retrying will not fix this" and "contact the publisher"; `UNREACHABLE_REASONS`
  (`unresolved_at_startup`, `grace_exhausted` — `verdict.ts` could not ask) may say NEITHER, because
  there was no decision to ask anyone about and retrying is the only thing that can help there, so
  it names the connectivity failure and points at outbound access instead. A reason the map does not
  know still refuses — everything here fails closed — but its sentence claims LESS: no attributed
  act, no "retrying will not fix this" (a state this version cannot classify may yet be transient),
  and the issuer's own code echoed so an operator can look it up. Lookups go through `Object.hasOwn`:
  `reason` is network-derived and unvalidated, and a plain `map[reason]` answered every
  `Object.prototype` member — `valueOf`/`__proto__` threw a TypeError out of a gated handler inside
  a publisher's production, from the one path whose job is to say no gracefully. `boundIssuerText`
  caps every issuer-controlled string that reaches an agent's context (truncating by code point, so
  a surrogate pair is never cut in half) under TWO limits, not one: `MAX_ISSUER_REASON` (64) for a
  CODE and `MAX_ISSUER_MESSAGE` (200) for free-form PROSE. Separate because a single code-sized cap
  truncated this package's OWN 67-character `grace_exhausted` sentence — the one string in the
  reachable set that is ours, in the branch the split exists to keep legible.
- `src/verdict.ts` — `currentVerdict`, `resolveOptions`, `ResolvedOptions`, `safeWriteCache`, held
  apart from `guard.ts` for the showcase's sake: `showcase/tools.ts` must read the SAME verdict the
  gate reads, and importing `guard.ts` to get it would close a `guard → showcase → guard` cycle. Both
  entry points resolve options exactly ONCE and hand the same object to gate and showcase — two
  independent resolutions could disagree on `cacheDir` and split the grace state machine across two
  files. `ResolvedOptions.fetchImpl?: typeof fetch` (l-mcp-showcase-verdict-surface-marker) is
  threaded one line further into `pollDelegationStatus` inside `currentVerdict` — typed as the
  built-in `fetch`, never a type from `showcase/`, so the gate does not import the layer built on
  top of it. Only `install.ts` ever fills it; `guard.ts` leaves it `undefined`, and `poll.ts`'s
  default parameter falls back to the global `fetch`, byte-identical to before this field existed.
- `src/install.ts` — `installProofLayer(server, opts)` plus `SHOWCASE_VERSION`, the SHOWCASE entry
  point, used INSTEAD of `guardDelegation`. Its order is the whole reason it is a separate function rather
  than an option: precondition → capture the un-gated registrars → register the showcase through
  them → append the Proof recognition paragraph to `instructions` → patch → return the gating
  registrar. Registering the showcase before `guardDelegation`
  is impossible (it throws on any pre-existing tool, taking the publisher's server down at startup);
  registering it after means the gate covers it, and a revoked delegation then kills
  `proof_check_this_server` — the one tool whose job is to report that revocation. A repeat install
  throws its OWN error, keyed on a `Symbol.for` marker checked before the pre-registration check, so
  the message written for "the publisher registered tools first" is never shown for a double call.
  Showcase registration is ALL-OR-NOTHING: a throw on the second or third tool deletes the names
  already written into `_registeredTools` and rethrows, so a publisher who defensively wraps this
  call cannot end up advertising Proof tools on a server whose registrars were never patched (the
  realistic trigger is a duplicate `zod` instance failing inside the SDK's schema conversion — the
  reason `zod` is a PEER dependency), and a retry still meets the precondition it should. With no token the showcase installs, NOTHING is gated and the RAW
  registrar is returned, mirroring `guardDelegation`'s opt-out. When a token IS present, `resolved`
  is built with `fetchImpl: createLayerSurfaceFetch(SHOWCASE_VERSION)` (`showcase/marked-fetch.ts`)
  — the ONLY place this is wired, so every poll `currentVerdict` makes through THIS entry point,
  whether the gate's own periodic check or one triggered via `proof_check_this_server` reading the
  same verdict, carries `X-Proof-Surface: layer/<version>`. `guardDelegation` never touches this
  function, so its poll stays exactly as before.
  The local `appendShowcaseInstructions(server, principal)` helper — called unconditionally between
  `markInstalled` and the no-token early return, so both the gated and opt-out paths carry the
  paragraph — reads, builds and writes `server.server._instructions` inside ONE `try/catch`: a
  missing `.server` field returns early, and a throwing read or write (a frozen object, a future
  getter-only field) degrades the same way, silently. Never throws out of `installProofLayer`.
  Appends via a `\n\n` separator on a TRUTHY existing value, never on `typeof === 'string'` — the
  SDK's own `initialize` response already treats an empty string as absent
  (`...(this._instructions && {instructions: this._instructions})` in `server/index.js`), so the
  truthy check alone reproduces that behaviour without a special case. Text lives in
  `showcase/instructions.ts`, independent of `guardDelegation` — verified by a real `McpServer` in
  `__tests__/real-sdk.test.ts`, since `_instructions` is SDK-private state no hand-written fake can
  stand in for. Neither `installProofLayer` nor `guardDelegation` touches disk: the paragraph write
  is in-memory only, and the on-disk cache (`cache.ts`) is reached solely through `verdict.ts`'s
  `currentVerdict`/`safeWriteCache`, which `registrar.ts`'s `wrapRegistrar` calls only inside
  `gatedHandler` — i.e. at the first gated tool call, not at install time. Proven behaviourally in
  `__tests__/install.test.ts`'s "SC-12: install never touches disk" block, against a `cacheDir`
  pointed at a path that deliberately does not exist.
- `src/showcase/` — the three embedded tools. `tools.ts` registers them (`SHOWCASE_TOOL_NAMES`);
  `descriptions.ts` holds their copy with ZERO external imports, so the issuer-side drift suite can
  assert the REAL strings instead of text-scanning for them — including the three identity rules
  `proof_verify_delegation` must state (identity never read from inside the artifact being checked,
  "nothing to compare against" when no independent identity exists, resolve afresh at call time),
  which are held across this copy AND the full server's by
  `../../src/__tests__/drift/mcp-showcase.test.ts`. That guard also reads the `delegate.value` HINT
  in `tools.ts`, not just the description: a live agent read an artifact's own `package.json` and
  accused its publisher, and the narrow wording survived in the hint after the description was
  widened — the argument the agent actually fills in. Beside `showcaseFooter` (the
  cross-reference to the full server) it also exports `showcaseConsequence(principal)`, appended to
  all three descriptions before the footer: the short consequence form from
  `docs/agent-instruction-compliance.md` Finding 2 (naming the impersonation risk, not explaining
  the mechanism, is what moved compliance 9/10 vs 3/10). Its own docblock states plainly that the
  9/10 figure was measured on a tool the agent was already calling for its own task, which these
  three are not — carried as an unmeasured hypothesis, not a confirmed result. `instructions.ts`
  (a sibling module, also zero imports) holds `showcaseInstructionsParagraph(principal)` — the
  "channel of first recognition": appended to the `initialize` response's `instructions` field by
  `install.ts`, so a model reads it before it has seen or asked about any tool. Deliberately a
  DIFFERENT text from `showcaseConsequence`, not built by concatenating one from the other.
  `breaker.ts` is the showcase's OWN
  circuit breaker — ONE INSTANCE PER OUTBOUND TOOL, never shared, see `ShowcaseContext` for the
  measured reason — plus its two budgets: `SHOWCASE_TIMEOUT_MS` (4.5s) bounds the WHOLE call, and
  `SHOWCASE_PER_REQUEST_TIMEOUT_MS` (1125ms) is what the verifier gets per FETCH, derived as
  `floor(TOTAL / (SHOWCASE_MAX_LEGS + 1))`. The derivation is the point: one verification walks up
  to three sequential requests, so a per-request bound
  does not bound the call, equal numbers leave zero room for the work between legs, and a
  per-request budget squeezed too tight aborts against a LIVE issuer — which `isIssuerUnreachable`
  then charges to the breaker as a false cooldown. The total stays deliberately below the
  verifier's 5s, because these calls run synchronously inside a user-facing call in someone else's
  production process with no grace window behind them. Neither budget reaches
  `proof_check_this_server`; between the two outbound tools the whole-call bound applies to BOTH
  and the per-fetch cap only to `proof_verify_delegation` (`proof_connect` passes no `timeoutMs`,
  so its single request is bounded by the breaker deadline alone). What COUNTS as a failure is a
  predicate, not a throw: the verifier reports an unreachable issuer by RETURNING
  `{valid: false, outcome: 'unconfirmed'}`, so `breaker.run` takes an `isFailure` hook and
  `tools.ts`'s `isIssuerUnreachable` narrows it to `jwks_unavailable`/`status_unavailable` — the
  whole `unconfirmed` class also holds `status_uri_untrusted`, a property of the TOKEN being
  checked, and charging that would let three checks of one badly-published artifact deny
  verification of every other one for a cooldown. `proof_check_this_server` reads the gate's own
  verdict, so a poll it triggers runs on `poll.ts`'s 10s timeout and INSIDE the grace machine —
  deliberate, not an omission. On a refusal it returns the bounded issuer `reason`/`message` PLUS a
  `refusal_message` built by `refusal.ts`, the byte-identical sentence a gated tool is handing the
  publisher's callers right now: without it the publisher reads a machine string here while their
  users read something else at the moment it matters, which is what makes this tool the documented
  self-check. `marked-fetch.ts` adds
  `X-Proof-Surface: showcase/<version>` so `GET /api/v1/mcp/connect` can count the showcase's reach
  (`src/controllers/mcp.ts`) — that is the NUMERATOR, one signal per TOOL CALL. The same file's
  `LAYER_SURFACE_PREFIX`/`createLayerSurfaceFetch` (l-mcp-showcase-verdict-surface-marker) mark the
  gate's own verdict poll instead, deliberately with a textually disjoint value (`layer/<version>`,
  never `showcase/`) since `proof_verify_delegation` marks its OWN call to the SAME status route
  (`/api/v1/proofs/validate`) — a shared prefix would make that rare, deliberate tool-call signal
  indistinguishable from this mechanical per-installation heartbeat. `install.ts` is the only
  caller; `src/controllers/proofs.ts`'s `validateProof` is the DENOMINATOR-side counter, one signal
  per INSTALLATION rather than per call. `connect.ts` fetches the live invitation text at call time with a
  packaged `OFFLINE_FALLBACK` labelled as such — the copy freezes into the publisher's
  `node_modules`, and the live answer changes as the platform does. That read takes the
  same posture as the verifier's remote reads, `redirect: 'error'` plus a body cap, for a sharper
  reason: what comes back becomes INSTRUCTIONS in the agent's context and `baseUrl` is the
  publisher's to configure, so a redirect would carry the read off the chosen origin with the answer
  still presented as ours.
  ⚠️ **`fetchConnectInfo` copies the body FIELD BY FIELD, so an issuer-side addition is inert here
  until it is taught.** That is the right default for text becoming instructions in someone else's
  context, and it is also a trap: the backend can grow a field, ship it, and have this package drop
  it in transit with both suites green. It happened — `remote_url` / `remote_config` /
  `install_caveat` (the hosted-server route, which needs no install and no key) had to be added to
  `ConnectInfo`, to the whitelist AND to `OFFLINE_FALLBACK`, and the two sides' field NAMES are now
  held equal by `../../src/__tests__/drift/mcp-showcase.test.ts`. The fallback carries the
  production address, the same posture `docs_url` already takes.
- `src/result.ts` — `ToolResult`/`errorResult`/`jsonResult`, mirroring `mcp/src/types.ts`'s shape
  without importing it (this package cannot depend on the MCP server).
- `src/schedule.ts` — `MAX_GRACE_FAILURES` (hard-coded, not a `GuardOptions` field — an unbounded
  grace window was found CRITICAL in `b-brainstorm-delegation-revocation`'s SEC-DLG-02, and the
  fix there was a library-enforced ceiling, not a documented recommendation) and `nextIntervalMs`
  (jittered, deterministically never an exact multiple of 60 000 ms when given the default base —
  a fleet polling on the wall-clock minute is a self-inflicted thundering herd).

## Grace state machine

Implemented in `verdict.ts`'s `currentVerdict` (exported, so the showcase reads the same verdict
rather than polling separately): a cached `valid`/`refused` answer is
served across up to `MAX_GRACE_FAILURES` consecutive `unresolved` polls. A cold start — no cache
file at all — has no grace to extend: an unresolved first poll refuses immediately. This is the
`purl` cold-start path referenced in the task's SC-11/SC-12; it applies identically regardless of
`artifactType`, which shapes only documentation, not this logic.

## Dependencies — not zero, unlike the verifier

The showcase is what costs them. This package declares
`@proof-holdings/delegation-verifier` as a runtime dependency (`proof_verify_delegation` needs it;
it is ours and itself dependency-free) and `zod` as a PEER dependency, never a normal one — a second
zod instance in the publisher's process breaks `instanceof` checks inside
`@modelcontextprotocol/sdk` when it converts a schema to JSON Schema. The SDK itself stays
dev-only: the showcase registers through a captured registrar and makes no runtime SDK import.
⚠️ Precise statement of the `zod` cost: the GATE never USES it, but `index.ts` statically re-exports
`install.js` → `showcase/tools.js` → `import { z } from 'zod'`, so `import { guardDelegation }`
FAILS AT MODULE LOAD if `zod` does not resolve. Harmless in practice (any MCP SDK install brings
it) and stated plainly in the README rather than papered over — a `./gate` subpath export or a lazy
`await import()` inside `installProofLayer` would be the way to make the narrower claim true.

⚠️ This package and the verifier are both cleared for npm since `h-npm-registry-release` (manifests
un-privated, `publishConfig.access: public`), and the RELEASE itself is a gated ops step — so until
the verifier is actually resolvable on the registry, `package.json` declares a semver a plain
`npm ci` here still 404s on. Three things bridge that: `node_modules` resolves it through a local
symlink, CI repoints the specifier to `file:../delegation-verifier` for the duration of the job (the
same arrangement `mcp/` uses), and `vitest.config.ts` aliases the package SOURCE. Only the middle
one is the workaround — `docs/runbooks/npm-release.md` § 8 step 8 retires it. The source alias stays
either way: it exists so the suite is green on a fresh clone with no build, which publication does
not change.

## The two entry points are mutually exclusive

`guardDelegation` and `installProofLayer` both set and both check a shared `Symbol.for` marker
(`registrar.ts`'s `INSTALLED_MARKER`), so running both throws in either order — with ONE narrow
exception: a no-token `guardDelegation` on a server already in the `optout` state returns again
instead of throwing, because nothing was gated, nothing was patched, and the same raw registrar is
handed back. The exception belongs to `guardDelegation` ALONE. `installProofLayer` asserts
unconditionally, so `install`→`install` and `guard`→`install` throw even with no token anywhere: the
raw registrar is already out and nothing installed afterwards can cover it, and a second install
would additionally re-register the showcase. Do not "restore" idempotence on those cells.

The marker exists because the failure it prevents is silent. `guardDelegation` registers nothing, so
after it runs the "nothing registered yet" precondition still passes while `server.tool` is already
the gating wrapper — `installProofLayer` would then register the showcase THROUGH the gate, and a
revoked delegation would kill `proof_check_this_server`, verbatim the failure that entry point
exists to prevent, visible only at revocation time. It records a KIND (`gated` | `optout`) rather
than a bare flag, because a repeat of the harmless opt-out must not crash a publisher's startup with
a message asserting a layer that is not installed. Ordering: the `optout` → `optout` carve-out
returns first, then `assertNotAlreadyInstalled`, then `guardDelegation`'s no-token opt-out — so a
no-token call on a GATED server still refuses. `installProofLayer` records the kind from `resolved`,
so its own no-token call is `optout` too: it installs no gate and hands back the raw registrar, and
a later refusal must say so rather than claim a layer that is not there. `readInstallKind` treats
any truthy value that is not the exact string `'optout'` as `gated`: the key is a process-wide
`Symbol.for`, a newer copy of this package may write a kind this version has never heard of, and
erring toward `gated` errs toward refusing rather than toward silently installing a second layer.

## Testing against the real SDK

`src/__tests__/real-sdk.test.ts` is the only suite that imports `@modelcontextprotocol/sdk`; every
other one drives a hand-written `FakeServer`. It exists because two claims rest on what this package
actually binds rather than on the stand-in: `_registeredTools` is real SDK internal state that
`install.ts`'s rollback `delete`s keys out of, and `server.tool` on a real `McpServer` is a
PROTOTYPE method, so patching an instance property shadows it — a different operation from what the
fake exercises.

## The guard that keeps the un-gated registrar in

`src/__tests__/no-ungated-registrar.test.ts` (SC-2) does not read names or source — it EXERCISES the
surface: every exported function is called with a server and options, everything function-shaped that
comes back is used to register a probe tool, and each probe must refuse under a revoked delegation.
The walk is deliberately wide because a leak is silent (a publisher routing one tool around the gate
looks identical from outside): it unwraps promises (an `async` factory), descends TWO levels into a
returned container, walks a returned function's OWN properties (`wrapped.raw = originalTool`), and
separately sweeps `Reflect.ownKeys(server)` for a stash. An input ECHO is skipped only when BOTH the
candidate is reference-identical to what went in AND the server is untouched — the same registrar
handed back AFTER the patch is a real leak, and skipping on identity alone reopened the hole once.
STATED BOUNDS: own keys only, so a stash on the PROTOTYPE is outside the probe (nothing does that),
and the walk is anti-vacuity-pinned (`guardDelegation`/`installProofLayer` present, ≥2 registrars
actually exercised). The handlers themselves are exercised in `showcase-tools.test.ts`, which drives
the REAL registered showcase handlers rather than the helpers behind them — the breaker's
returned-failure defect was invisible until something called them.

## Build/Test

`npm run build` / `npm test` (vitest, `src/__tests__/`) from this directory. **CI runs them in the
`self-refusal-tests` job** (`.github/workflows/ci.yml`), gated by the `self-refusal` paths filter
over this package AND the verifier. That job repoints the verifier specifier to
`file:../delegation-verifier` and builds the verifier first, because `dist/` is gitignored and the
verifier declares no `prepare` script, so the compile step would otherwise fail TS2307 on the
verifier import. That step is `self-refusal:build`
(`tsc`), not `typecheck` (`tsc --noEmit`): same tsconfig and therefore the same type coverage,
plus the one thing `--noEmit` cannot answer — whether this package still EMITS, which is what a
publisher installs.

Some of the showcase's boundaries are pinned from here — composition (`install.test.ts`: exactly
three tools and nothing else), the whole marker matrix, and the un-gated registrar
(`no-ungated-registrar.test.ts`). The others live issuer-side instead — name-disjointness, the
two-sided header contract, the `SHOWCASE_VERSION` lockstep, and the named `render_auth_link` ban.
That last one appears in no test in this package at all, so if the issuer-side suite is ever
deleted, nothing here stops `qrcode` coming back. They are in
`../../src/__tests__/drift/mcp-showcase.test.ts`: name-disjointness needs `parseMcpToolNames` over
`mcp/src/tools`, which this package cannot see, and the `X-Proof-Surface` contract has its two
halves in different build graphs: `SHOWCASE_SURFACE_HEADER` + the `showcase/` prefix here against
the literals `src/controllers/mcp.ts` reads, plus `SHOWCASE_VERSION` against this `package.json`.
Renaming either side is invisible to BOTH suites on their own, and the only symptom is that every
showcase call is tallied as ordinary traffic. A SECOND, independent two-sided contract in the same
drift file pins `LAYER_SURFACE_PREFIX` here against the same-named literal `src/controllers/proofs.ts`
reads, plus the prefix-disjointness rule against `showcase/`'s own extracted value — renaming
either side there silently tallies every `installProofLayer` poll as unmarked traffic instead. Not wired into root jest otherwise, following the
`packages/delegation-verifier` precedent exactly — `packages/**` stays
outside root jest by convention (see root `CLAUDE.md` § Directory Crawl for the same "outside
`tsc`/eslint, watch the test count" caveat class, though this package's SOURCE is TypeScript-checked
by its own `tsc` — the CI build step above, and `npm run typecheck` locally for the same check
without emit). Stated with its bound: `tsconfig.json` excludes `src/__tests__`, so nothing
type-checks the test files themselves — vitest transpiles them without checking. Watch the test
COUNT here too.

## Empirical validation

`../../docs/delegation-self-refusal-e2e-walkthrough.md` — the live proof this direction was gated
on: a throwaway server wired with `guardDelegation`, revoked mid-run over the real staging API,
refuses a consumer that was told nothing about delegation/revocation, with a same-cadence
unguarded negative control confirming the refusal is the mechanism and not coincidence. Scope: `url`
only, and only the immediate-definitive-refusal path — the grace-window/`MAX_GRACE_FAILURES` branch
was not exercised by that run (its own § 4).

## Related Documentation

- `README.md` — public usage, refusal shape, network-egress and clock/cache-replay caveats.
- `../delegation-verifier/CLAUDE.md` — the consumer-side counterpart this package mirrors.
- `../../docs/brainstorm-results/revocation-delivery.md` — full reasoning behind the
  self-refusal mechanism and why a signed status artifact was rejected in favor of it.
- `../../docs/delegation-self-refusal-e2e-walkthrough.md` — the live end-to-end proof (see above).
- `../../mcp/src/server.ts` — the exact bind line (`const tool = server.tool.bind(server)`) this
  package's entry point is designed to replace.
