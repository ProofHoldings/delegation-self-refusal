# @proof-holdings/delegation-self-refusal

[![Proof of Delegation](https://proof.holdings/badge/npm/@proof-holdings/delegation-self-refusal)](https://proof.holdings/npm/@proof-holdings/delegation-self-refusal)

A delegated MCP server enforces its own authorization. This package holds your Proof of
Delegation token, gates your server's tool calls on it, and caches the issuer's answer on disk — so
a consumer who never checks anything still cannot get a tool call out of a server whose
authorization has been revoked, suspended, or has expired.

```bash
npm install @proof-holdings/delegation-self-refusal
```

Node ≥ 18. One runtime dependency (`@proof-holdings/delegation-verifier`, itself dependency-free,
used to verify a re-signed token after a signing-key revocation) and one peer dependency (`zod`,
which your MCP SDK already installs, used for the status tool's output schema).

## What this is not

This is **not** a consumer-side verifier. `@proof-holdings/delegation-verifier` is the
issuer-agnostic package a caller runs to check *your* delegation before trusting you. This
package is the opposite direction: it runs inside *your own* server so that when your own
delegation stops being valid, your server stops itself — whether or not the caller ever asked.

## Setup

Setup has two steps, and both are required.

1. **Publish the token** where readers look for it: in your MCP `server.json` under
   `_meta["holdings.proof/delegation"]`, in an A2A agent card as a `capabilities.extensions[]`
   entry with `uri: "https://proof.holdings/delegation"`, or through the `_mcp.<domain>` DNS
   pointer, which names such a card. The delegation page of your Proof dashboard prints the exact
   snippet for your token. Directories, `npx @proof-holdings/proof-check` and verifying clients read
   the published token whatever this package does, so a server that installs the gate without
   publishing is invisible to them.
2. **Install the gate** in the server itself, as below.

## Usage

One call, after you create the server. Tools may be registered before or after it.

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { installProofHoldings } from '@proof-holdings/delegation-self-refusal';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });

installProofHoldings(server, {
  token: process.env.DELEGATION_TOKEN, // omit or leave empty to gate nothing
});

registerMyTools(server); // unchanged
```

| Option | Default | Meaning |
|---|---|---|
| `token` | none | The delegation token. Absent or empty: nothing is gated, no instructions line is added, and the status tool reports `not_configured`. |
| `pollIntervalMs` | `300000` | How long a cached answer is served without asking again. A lower value is raised to `60000`; anything but a finite number throws. |
| `cacheDir` | `PROOF_CACHE_DIR`, else `~/.proof-holdings/delegation-self-refusal` | Where verdicts are kept between processes. |
| `baseUrl` | `https://api.proof.holdings` | The issuer's API. |

The principal, delegate and expiry are read from the token; there is nothing else to configure.

`installProofHoldings` does three things:

- **Gates `tools/call`.** It wraps the SDK's own `tools/call` handler, so every tool is gated —
  whenever it was registered — and a refusal is returned before the SDK validates the call's
  arguments. If the installed SDK does not expose that handler where this package expects it and a
  token is configured, the call throws rather than leaving your tools ungated. Calling it twice on
  one server throws. Servers built per request or per session in one process share one gate state
  for the same token, `baseUrl`, `cacheDir` and effective poll interval.
- **Registers `proof_holdings_status`.** A read-only tool, outside the gate, that reports the
  delegation's status, principal, delegate, expiry, and when Proof last answered. It answers from
  the cache, and asks Proof afresh at most once a minute per process.
- **Adds one line to your server's instructions** (with a token):
  `Verified by Proof Holdings (delegated by example.com). Call proof_holdings_status for details.`

With a token, it also rewrites the SDK's input-validation errors for your own tools (`MCP error -32602: …`) into
the same JSON envelope as a refusal, with `error: "invalid_arguments"`, the message cut at 200
characters and any copy of your token replaced with `[redacted]`. When the error is the SDK's
`Output validation error` (your tool's own answer failing its `outputSchema`), the envelope says
`error: "internal_error"` instead, so the agent is not told to change arguments that were fine.
Every other result of your tools passes through unchanged.

## When it asks Proof

The check runs on tool calls, never on a timer, so a server nobody is calling sends nothing. With
`I` the poll interval:

- an answer younger than `I` is served as it is;
- between `I` and `3 × I` it is served, and the call starts one background refresh;
- older than that, or with no answer at all, the call waits for one attempt of at most 4 seconds
  (with no answer at all and a first attempt that fails: one more attempt a second after it).

Calls that arrive while an attempt is in flight share it; at most one background refresh runs at a
time.

**How fast a revocation lands:** ≤ ~6 min after revocation while Proof is reachable, plus at most
one call within 3× the interval. At the default interval, while Proof is reachable: a revoked
delegation is refused within about six minutes of active use, at most one more call runs, and only
within 15 minutes of the last answer — never after a day idle, because an answer older than `3 × I`
is not served while a fresh one can be had.

The token's own `exp` is checked locally on every call, first: past `exp` plus five minutes the call
is refused as `expired` whatever the cache or Proof says.

**While Proof is unreachable, the last answer stands.** A cached `valid` keeps running and a cached
refusal keeps refusing, for as long as the outage lasts; after a failed attempt the server stops
waiting on Proof for 30 seconds (in memory only). With no answer at all — a first start, or a lost
cache — the tools run once the two attempts are spent, and `proof_holdings_status` reports
`never_validated: true`; the server then stops waiting for one interval. Revocation is enforced only
while Proof can be reached.

## What a refusal looks like

A refused call returns one text block holding compact JSON:

```json
{"error":"revoked","message":"Refused by Proof: example.com's authorization was revoked. Retrying will not fix this. Details: proof.holdings/delegation","retryable":false}
```

`error` is the reason (`revoked`, `suspended`, `expired`, `unknown_delegation`, `invalid`,
`malformed`, `unsupported_version`, … — an answer this version does not know refuses as
`unrecognized_refusal`). `retryable` is `true` only for `key_revoked`, below.

## Key revocation

Proof rotates the keys it signs delegations with. A planned rotation changes nothing for you: old
signatures stay verifiable. When a signing key is **revoked** (for example after a suspected
compromise), Proof re-signs every delegation that key signed under its current key — same
delegation, same claims, a new signature — and `POST /proofs/validate` answers `key_revoked` for
the token you configured. Without help, your server would then refuse every tool call while your
delegation is still perfectly valid.

So the gate picks the re-signed token up itself:

1. Only a `key_revoked` answer starts this. `revoked`, `suspended`, `expired` and every other
   answer refuse exactly as before.
2. It refetches the issuer's JWKS, then pulls the current token by handle from the public
   `GET /api/v1/proofs/delegation-token/:handle`.
3. It accepts the pulled token only if it is a different token signed under a different key, names
   the same handle (`sub`), delegate and `jti` as your token, was issued no earlier than your token
   and no more than 5 seconds in the future, does not expire later than your token, and verifies
   under a key that is not revoked against your token's issuer and principal. Anything else is a
   failed pull.
4. An accepted token replaces the configured one for this process and is written to `cacheDir`,
   so the next process picks it up from disk — after re-checking its lineage, issuer and principal
   against the configured token (its signature was verified when it was accepted) — instead of
   pulling again. The old token's cached verdict is dropped and the new token is checked
   with Proof in the same call.
5. Pulls run inside tool calls (there is no background timer): the first on the call after the
   `key_revoked` answer, then after 30 s, 2 min, 8 min and 10 min — five per episode, persisted
   across restarts. If none is accepted, the gate keeps refusing.

While it pulls, a call is refused with `key_revoked` (`retryable: true`):

```
Refused by Proof: example.com's authorization is being re-signed under a new key. Retry in a few minutes. Details: proof.holdings/delegation
```

Once the five pulls are spent, with `reissue_unavailable`:

```
Refused by Proof: example.com's authorization was re-signed; this server could not fetch it. Ask its publisher. Details: proof.holdings/delegation
```

To recover from that state, configure the current token (from your dashboard, any SDK's
`delegations` resource, or the public pull above) — a new configured token starts with a clean
cache entry.

The key set the pickup verifies against is persisted in `cacheDir` as well (`jwks-*.json`),
tombstones included: a revoked key stays revoked across restarts until `revoked_at + 365 days`.
`clearTombstones({ cacheDir, baseUrl })` is the only way to drop one sooner.

Your published copy in `server.json` or `agent-card.json` still carries the old token: refresh it
with `delegation-publisher refresh` (`@proof-holdings/delegation-publisher`). A DNS pointer
(`_mcp.<domain>`) needs no change, because it names the card, not the token.

## Renewal

When a delegation is renewed in place, Proof signs a new token for the same handle with a later
expiry, keeping the handle (`sub`), `jti`, principal and delegate. The token you configured stays
valid until its own `exp`, and from 0.5.0 the gate fetches the renewed one itself:

1. In the 14 days before your token expires, a tool call served on a fresh `valid` answer is served
   at once and also starts one background pull from
   `GET /api/v1/proofs/delegation-token/:handle`. At most one runs at a time.
2. Until you renew, the pull answers the same token; the next pull is made an hour later at the
   earliest. A pull that cannot reach Proof is retried after 30 seconds instead.
3. The gate accepts a pulled token only if it names the same handle, `jti` and delegate, was issued
   no earlier than your token, expires later than it, and verifies against the issuer's keys. An
   accepted token replaces the configured one and is written to `cacheDir`, like a re-signed one
   (above).
4. A call made after your token has expired waits for one pull before refusing `expired`, so a
   server that was idle through the whole window still picks the renewal up.

Nothing is redeployed. What does not change is every place you PUBLISHED the old token (agent
card, MCP server card, `server.json`): put the new token there before the old one expires.

A gate older than 0.5.0 keeps the token it was deployed with, which verifies until its own `exp`,
and then refuses every tool call. Upgrade before renewing.

## The cache

One file per token and issuer in `cacheDir`, named by a SHA-256 of the token, written atomically
(temporary file, then rename; mode 0600). If the directory cannot be written, verdicts are kept in
memory for the life of the process and one line is written to stderr — never to stdout, which is
the MCP stdio transport. Files written by 0.1.x and 0.2.x are not read.

## What this cannot protect against

This package binds a **cooperative** server. It defends the honest publisher who lost
authorization — a contract that ended, a key that was rotated, a domain that was not
re-verified — because the check lives in code the publisher installed and did not remove. It
does **not** defend against a hostile operator who deletes the wiring: nothing running inside a
process can force a different, adversarial version of that process to check anything.

The same bound covers `proof_holdings_status`. Its answer is only as honest as the process giving
it, and the cache is not a trust boundary against the publisher: a planted cache file is read like
a real one. Verify a server you do not run from outside it.

## Network egress

For a `url` artifact (you operate the server), the poll leaves **your** infrastructure — no
different from any other outbound call your service already makes.

For a `purl` artifact (a package a consumer installs and runs themselves), the poll leaves the
**consumer's** network, and only while their tools are being called: about once per interval while
Proof answers, more often while it cannot be reached, plus at most one a minute per process
through `proof_holdings_status`. On a network that cannot
reach Proof the tools keep running on the last answer, or — with none — run unvalidated after the
first attempts, as described above.

## What defeats this without touching our code

- **Blocking the network to Proof.** A cached `valid` then stands for as long as Proof cannot be
  reached.
- **Stopping or slowing the system clock.** Cache age is measured against wall-clock time. Rolling
  it backward does not help: an answer stamped later than now makes the next call ask again.
- **Replaying a stale cache file.** Restoring an older copy restores whatever verdict it held.

Neither requires cooperation from this package — they operate on the environment underneath it.
This is self-enforcement by a cooperative, unmodified process, not tamper-resistance.
