# @proof-holdings/delegation-self-refusal

A delegated MCP server enforces its own authorization. This package holds your Proof of
Delegation token, polls the issuer on a jittered interval, caches the answer on disk, and gates
your own tool dispatch — so a consumer who never checks anything still cannot get a tool call out
of a server whose authorization has been revoked, suspended, or has expired.

```bash
npm install @proof-holdings/delegation-self-refusal
```

Node ≥ 18. One runtime dependency (`@proof-holdings/delegation-verifier`, itself dependency-free)
and one peer dependency (`zod`, which your MCP SDK already installs). The GATE uses neither — but
be precise about what that means: both are loaded when you `import` from this package at all,
because the package index re-exports the optional Proof layer described below. In practice this
costs nothing (every MCP SDK install already brings `zod`), but "the gate needs no dependencies"
would be false as written.

## What this is not

This is **not** a consumer-side verifier. `@proof-holdings/delegation-verifier` is the
issuer-agnostic package a caller runs to check *your* delegation before trusting you. This
package is the opposite direction: it runs inside *your own* server so that when your own
delegation stops being valid, your server stops itself — whether or not the caller ever asked.

## Usage

Replace the one line where you bind your tool registrar:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { guardDelegation } from '@proof-holdings/delegation-self-refusal';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });

// Was: const tool = server.tool.bind(server);
const tool = guardDelegation(server, {
  token: process.env.DELEGATION_TOKEN,   // omit/empty to disable the gate entirely
  principal: 'example.com',              // the domain named in the refusal message
  artifactType: 'url',                   // 'url' (you operate the server) or 'purl' (consumers install it)
});

registerMyTools(tool, http); // unchanged — every module still receives a ToolRegistrar
```

`guardDelegation` **must run before any `server.tool()`/`registerTool()` call.** Registering a
tool first and calling `guardDelegation` with a token afterward throws — a gate installed too late
to see a call it was supposed to guard would otherwise silently protect nothing. With NO token the
opt-out returns before that check runs and nothing is thrown, because nothing was going to be
gated; that path is silent by design and is the one state this rule cannot warn you about.

## Optional: install the Proof layer instead

`installProofLayer` is the alternative to `guardDelegation` for a publisher who also wants their
users to be able to see Proof from inside the server they already have. It installs the same gate
AND registers three tools:

| Tool | What it does |
| --- | --- |
| `proof_check_this_server` | Reports whether THIS server's delegation is valid right now — and keeps answering while every other tool is refusing |
| `proof_verify_delegation` | Verifies someone ELSE's Proof of Delegation. No API key |
| `proof_connect` | Returns the current instructions for connecting the client to the full Proof MCP server |

```ts
import { installProofLayer } from '@proof-holdings/delegation-self-refusal';

const tool = installProofLayer(server, {
  token: process.env.DELEGATION_TOKEN,
  principal: 'example.com',
  artifactType: 'url',
});
```

Call it **instead of** `guardDelegation`, not in addition to it — it includes the gate, and a
second install throws. The same "before any registration" rule applies, and here it applies
UNCONDITIONALLY: `installProofLayer` runs the check with or without a token, since it registers the
three tools either way.

Two properties are deliberate and worth knowing:

- **`proof_check_this_server` is not gated.** It is the tool that reports a revocation, so gating
  it would kill it in exactly the situation it exists for. It is registered through the original
  registrar before the gate is installed. **Whenever a token is configured**, that un-gated
  registrar is never returned or exported, because routing your own tool through it would silently
  disable your self-enforcement while the installation still looked correct from outside. With no
  token there is no gate to bypass, and the call returns exactly that raw registrar — the same
  thing `guardDelegation`'s opt-out hands back.
- **The two outbound showcase tools call out on their own budget.** `proof_verify_delegation` and
  `proof_connect` are bounded at 4.5s end to end per call — below the verifier's own 5s default —
  because unlike the gate they have no grace window and run synchronously inside your users'
  calls. `proof_connect` makes ONE request and that figure is its only bound.
  `proof_verify_delegation` walks up to three sequential requests, so it additionally caps each
  individual fetch at 1125 ms, derived from the total rather than equal to it. Each of the two has
  its OWN circuit breaker, so a dead issuer cannot be hidden by the other tool's successes.
  `proof_check_this_server` is deliberately outside all of this: it reads the same verdict the gate
  reads, so any poll it triggers runs on the gate's 10s timeout and its grace schedule, not on the
  showcase budget. If proof.holdings is unreachable, `proof_connect`
  serves a packaged copy of the instructions clearly labelled `offline_fallback`, and
  `proof_verify_delegation` answers `unconfirmed` — never a negative verdict about the artifact.

The calls those two tools make carry an `X-Proof-Surface: showcase/<version>` header so
proof.holdings can count them — a count of tool CALLS, not of installations. `installProofLayer`'s
own periodic status poll carries the SAME header with a different, textually disjoint value,
`layer/<version>`, never a `showcase/`-prefixed one: that is the denominator, one signal per
installation that carries the showcase rather than one per call. A `guardDelegation` installation's
poll carries no header at all and is indistinguishable from any other caller of proof.holdings'
public status endpoint.

What rides alongside the header differs by call, and none of them carries anything beyond what
that call was already sending. The layer poll always carries THIS installation's own delegation
token (`pollDelegationStatus` posts `{proof_token: token}`) — there the marker binds "this install
carries the showcase" to a request that already identifies the installation, and adds nothing else.
`proof_connect`'s marked call is a bare `GET` with no body at all — the header is everything it
adds, not even a token rides with it. `proof_verify_delegation`'s marked call carries whatever card
or token the CALLER supplied, to check SOMEONE ELSE's delegation — never this installation's own,
and no different from what that call already sent before this header existed. In every case:
no identity, no argument, nothing about you or your users is added by the marker — it rides calls
that were happening anyway, and no request is made on its own.

With no `token`, the three tools are still installed and nothing is gated;
`proof_check_this_server` then reports `configured: false` rather than presenting the absence of a
delegation as a valid one.

When the delegation is NOT valid, `proof_check_this_server` returns `reason`, `message` and
`refusal_message` about it — named rather than counted, because a number typed beside a list drifts
the moment the list grows and nothing here would go red.
`reason` is the issuer's machine code and `message` its own sentence — but both are OURS more
often than that suggests. This package writes `message` in the two unreachable branches (a cold
start and an exhausted grace window), and it substitutes either field INDEPENDENTLY when the issuer
omits it — `invalid` for a missing reason, "This delegation is not valid" for a missing message. Both are
TRUNCATED past a bound (code-sized for `reason`, prose-sized for `message`), because whatever the
issuer sends lands in the calling agent's context. `refusal_message` beside them is never
substituted and never the issuer's: it is the exact sentence your gated tools are returning to
their callers right now, from the same function, not a paraphrase.

So `invalid` has more than one source and they read differently: usually the issuer asserting it,
with a specific `message` (bad signature, unsupported schema version, missing claims) — read that
message, it is the diagnostic. Only when `message` is our substituted sentence does `invalid` mean
"the issuer did not tell us why". The two fields are substituted INDEPENDENTLY, so there is a third
cell the split above would hide: a reply carrying a real `message` and no `reason` at all shows our
substituted `invalid` beside the issuer's own sentence. The instruction does not change — read the
message — which is why the reading rule is stated per field rather than per pair. That is what makes
this tool a usable self-check: you read what your users read, without waiting for one of them to
tell you.

### What the Proof layer does NOT gate

All three showcase tools keep answering when your delegation is revoked — not just
`proof_check_this_server`. That is deliberate for the one that reports the revocation, and the
other two inherit it because they share the same un-gated registration. So a revoked server keeps
offering a working third-party verification tool and a working invitation; only
`proof_check_this_server` discloses that the server's own authorization is gone.

If you render your own status surface, `currentVerdict` / `resolveOptions` give you the same
verdict the gate enforces, and `refusalMessage(principal, reason)` / `REFUSAL_DETAILS_URL` give you
the sentence your callers are receiving — so you do not have to write a second one that drifts from
it.

## What a refusal looks like

A gated tool call, when the delegation is not currently valid, returns an MCP tool error result
instead of running your handler. This gate is silent on success and speaks only when it refuses.

With `guardDelegation` alone, that refusal text is the first thing most readers ever see from
Proof — it names Proof, names you, and gives one action. With `installProofLayer` it is not: the
three showcase tools' own descriptions already name Proof and the same revocation risk before any
call is ever refused.

**When the issuer answered and the answer was no**, each reason has its OWN lead clause — the
states are different facts and a reader who is told "revoked" about a pause acts on the wrong one.
`revoked`:

```
example.com's authorization to run this was revoked, and Proof (proof.holdings) cannot confirm it
as valid — retrying will not fix this. Details: proof.holdings/delegation. If this is unexpected,
contact example.com.
```

`suspended`, where the difference is the whole point — a pause is reversible and nothing published
has to be removed:

```
example.com's authorization to run this is paused, and Proof (proof.holdings) cannot confirm it as
valid while the pause holds — retrying will not fix this. Details: proof.holdings/delegation. If
this is unexpected, contact example.com.
```

`expired` says it ran out, `unknown_delegation` that there is no record of it, and `invalid` that
Proof does not consider it valid; each keeps the same closing link and action.

**When we could not ask at all** the wording is deliberately different, and the difference is the
point — this is a connectivity failure where your server runs, not a decision anyone made about
you, and telling the reader to contact you would send them to ask about something that did not
happen. The two cases have their own lead clause, because one has a cached answer behind it and
the other never had one:

`grace_exhausted` — we had a good answer and could not renew it:

```
Proof (proof.holdings) has been unreachable for several consecutive checks, so example.com's
authorization to run this can no longer be confirmed — a connectivity failure here, not a decision
by example.com. Details: proof.holdings/delegation. Check outbound network access to
proof.holdings from wherever this server runs.
```

`unresolved_at_startup` — a first run with nothing cached to extend:

```
Proof (proof.holdings) could not be reached to confirm example.com's authorization to run this, so
this call is refused rather than assumed — a connectivity failure here, not a decision by
example.com. Details: proof.holdings/delegation. Check outbound network access to proof.holdings
from wherever this server runs.
```

A reason this version has never seen is refused with the reason carried through (truncated past a
bound, since it reaches an agent's context) and no claim about what happened — the issuer may add one, and an unrecognized verdict fails closed here
the same way it does everywhere else in this package.

The refusal never throws through your own HTTP client, is never retried internally, and is
excluded from any retry policy your server otherwise applies to its own outbound calls — a
refusal is not treated as a transient failure by anything in this package.

## What this cannot protect against

This package binds a **cooperative** server. It defends the honest publisher who lost
authorization — a contract that ended, a key that was rotated, a domain that was not
re-verified — because the check lives in code the publisher installed and did not remove. It
does **not** defend against a hostile operator who deletes the wiring: nothing running inside a
process can force a different, adversarial version of that process to check anything.
Verification that does not depend on the server's own cooperation is a separate concern, tracked
under Proof Holdings' own MCP checker.

Both public MCP SDK registration entry points — `server.tool()` and `server.registerTool()` — are
gated identically. A publisher who later calls the SDK's own `registeredTool.update()` to redefine
a tool's callback after registration bypasses the gate for that tool, the same way editing any
other line of the publisher's own code would; this package cannot intercept a call it is not on
the path of.

## Network egress

For a `url` artifact (you operate the server), the poll leaves **your** infrastructure — no
different from any other outbound call your service already makes.

For a `purl` artifact (a package a consumer installs and runs themselves), the poll leaves the
**consumer's** network, every interval, for as long as their process runs. Air-gapped and
egress-filtered deployments are **permanently denied, not degraded**: the on-disk grace window
only extends the *last good answer already obtained*, and a first run has none to extend — a
brand-new install with no cached verdict and no reachable issuer refuses on its very first tool
call. There is no offline mode.

## What defeats this without touching our code

Two things bypass this mechanism entirely, and neither requires touching the delegated server's
code:

- **Rolling the system clock backward.** The grace window is measured against wall-clock time;
  an operator or a compromised host that can move the clock can extend it indefinitely.
- **Replaying a stale cache file.** The on-disk cache is a plain JSON file. Restoring an older
  copy (from a backup, a snapshot, a container image built before revocation) restores whatever
  verdict was cached at that point.

Neither of these requires cooperation from THIS package to defeat — they operate on the
environment underneath it, which is exactly why the scope limit above matters: this is
self-enforcement by a cooperative, unmodified process, not tamper-resistance.
