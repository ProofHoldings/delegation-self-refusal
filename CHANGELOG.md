# Changelog

## 0.5.0

### Added

- Renewal pickup (`docs/mcp-delegation-gate-contract.md` § 6a). From 14 days before the token's
  `exp`, a tool call served on a fresh `valid` verdict also starts one background pull of the
  delegation's current token from `GET /api/v1/proofs/delegation-token/{handle}`. A renewed token —
  same handle, `jti`, principal and delegate, a later `exp`, signed by the issuer — replaces the
  configured one with no redeploy. A token past its `exp` makes one blocking pull before refusing
  `expired`. Until the owner renews, the pull answers the same token, and the next is made an hour
  later at the earliest.
- A persisted replacement is used after a restart when it passes the key-rotation checks or the
  renewal checks.
- A renewal pull that reached nobody (a timeout, a network error, a non-2xx answer, or a key set
  that could not be fetched or read) is retried after 30 seconds (`backoff_cached_ms`); only an answer from Proof waits
  the hour. Past the token's `exp` every call is still refused `expired` until a pull succeeds.

### Upgrade before renewing

- A gate older than 0.5.0 keeps presenting the token it was deployed with, which verifies until its
  own `exp`. But if a signing key is revoked after the delegation was renewed, that gate's
  key-rotation pickup refuses the re-signed token (its `exp` is later than the old one's) and every
  tool call is refused `reissue_unavailable` until the server is redeployed. Upgrade the gate before
  renewing.

## 0.4.0

### Changed

- The status tool's `proof_holdings.about`, a `const` of its output schema, says what the status
  covers: "Proof Holdings issued the delegation this server presents. The status above, from
  proof.holdings, says whether that delegation is in force; it says nothing about the quality or
  safety of the server." 0.3.0 said that Proof Holdings verifies a domain owner authorized the
  server, which nothing checks. A consumer validating the status output against the 0.3.0 schema
  rejects the new text.
- A tool whose own answer fails its `outputSchema` (the SDK's `MCP error -32602: Output validation
  error…`) is answered `internal_error` instead of `invalid_arguments`, with the SDK's text after
  that prefix as the message, bounded and with the token redacted, so the agent is not told to
  change arguments that were fine. Every other `-32602` text is still `invalid_arguments`.

## 0.3.0

Implements `docs/mcp-delegation-gate-contract.md`, shared with the Python and Go gates.

### Breaking

- One entry point: `installProofHoldings(server, { token, pollIntervalMs, cacheDir, baseUrl })`
  replaces `guardDelegation` and `installProofLayer`. The principal, delegate and expiry are read
  from the token; `principal` and `artifactType` are gone. Tools may be registered before or after
  it, and a second install throws.
- The gate wraps the SDK's `tools/call` handler instead of patching `server.tool` /
  `server.registerTool`, so it refuses before the SDK validates arguments. With a token, install
  throws if the SDK does not expose that handler where the package expects it.
- One tool, `proof_holdings_status` (read-only, with an output schema), replaces
  `proof_check_this_server`, `proof_verify_delegation` and `proof_connect`; one instructions line
  replaces the recognition paragraph.
- Refusals are the JSON envelope `{"error","message","retryable"}`; the SDK's input-validation
  errors become `invalid_arguments` in the same envelope, with the token redacted.
- Open on unreachable: an unresolved poll never changes a decided verdict, and with no verdict the
  tools run after the cold cycle (`never_validated`). `grace_exhausted` and `unresolved_at_startup`
  are gone.
- Stale-while-revalidate on a 300 000 ms interval (floor 60 000), un-jittered; blocking attempts
  time out at 4 s, a background refresh at 10 s; single-flight per process (servers built per
  request or per session share it); backoffs in memory. A `pollIntervalMs` that is not a finite
  number throws.
- Cache format v2 under new keys (0.x files are not read), written atomically, with a memory
  fallback when the directory cannot be written.
- The key-revocation pull schedule is un-jittered.
- Exports: `installProofHoldings`, `GATE_VERSION`, `STATUS_TOOL_NAME`, `clearTombstones`, and the
  types `InstallProofHoldingsOptions`, `McpServerLike`. Everything else is removed.
- Requires `@proof-holdings/delegation-verifier` `^0.2.0` (delegation schema 2.0). The key-rotation
  pull verifies a replacement token with it, so a schema 1.x replacement is rejected.

## 0.2.0

### Added

- **Re-issue pickup after a signing-key revocation.** When `POST /proofs/validate` answers
  `key_revoked`, the gate refetches the issuer's JWKS, pulls the re-signed delegation by handle from
  `GET /api/v1/proofs/delegation-token/:handle`, and accepts it only if it verifies under a key that
  is not revoked, is signed by a different key than the revoked one, and carries the same handle,
  delegate, principal and `jti`, an `iat` between the old token's and now (5 s clock tolerance),
  and an `exp` no later than the old token's. An accepted token replaces the configured one, is
  persisted in `cacheDir` and re-adopted after a restart; the old token's cached verdict is evicted
  under both cache-key forms and a fresh verdict is fetched. Pulls run inside gated calls — the first immediately, then
  after 30 s, 2 min, 8 min and 10 min (jittered downward), five per episode, persisted across
  restarts. README § Key revocation.
- `pollDelegationStatus` returns a distinct `{ kind: 'key_revoked', message }` result.
- Two refusal reasons with their own wording: `key_revoked` (pickup in progress — retry in a few
  minutes) and `reissue_unavailable` (the five pulls were spent — contact the publisher).
- Signing-key tombstones applied during the pickup are persisted in `cacheDir` and survive restarts
  until `revoked_at + 365 days`. `clearTombstones({ cacheDir, baseUrl })` drops them.
- Exports: `clearTombstones`, `MAX_KEY_REVOKED_PULLS`, types `KeyRevokedResult`,
  `KeyRevokedEpisode`. `ResolvedOptions` gains `configuredToken`; `token` is the active token.

### Changed

- Requires `@proof-holdings/delegation-verifier` `^0.1.1` (multi-key JWKS, `refreshJwks`,
  `KeySetStore`).
