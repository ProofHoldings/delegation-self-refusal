import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeCache } from '../cache.js';
import { MAX_GRACE_FAILURES } from '../schedule.js';
import { createBreaker } from '../showcase/breaker.js';
import { createMarkedFetch, LAYER_SURFACE_PREFIX, SHOWCASE_SURFACE_HEADER } from '../showcase/marked-fetch.js';
import { CHECK_THIS_SERVER_SELF_REPORT } from '../showcase/descriptions.js';
import { isIssuerUnreachable, registerShowcase, type ShowcaseContext } from '../showcase/tools.js';
import { installProofLayer, SHOWCASE_VERSION } from '../install.js';
import { MAX_ISSUER_MESSAGE, MAX_ISSUER_REASON, refusalMessage } from '../refusal.js';
import type { ToolRegistrar } from '../registrar.js';
import { resolveOptions } from '../verdict.js';

/**
 * The two showcase tools that TALK TO THE NETWORK, driven through their REGISTERED HANDLERS.
 *
 * `install.test.ts` only ever exercises `proof_check_this_server`, and `connect.test.ts` calls
 * `fetchConnectInfo` directly rather than through the tool. That gap is not academic: it is what
 * let the circuit breaker sit inert on `proof_verify_delegation` for the whole implementation —
 * `breaker.test.ts` proved `createBreaker` opens when `fn` THROWS, and nothing proved the real
 * call site ever hands it a throwing `fn`. The verifier does not throw on an unreachable issuer;
 * it RETURNS `{valid: false, outcome: 'unconfirmed'}`, which a throw-only breaker reads as success.
 */

/** A structurally valid delegation JWT — enough to reach the JWKS fetch, never signature-valid. */
function fakeDelegationToken(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = b64({ alg: 'RS256', typ: 'JWT', kid: 'test-kid' });
  const payload = b64({
    iss: 'proof.holdings',
    sub: 'ph_dlg_' + 'a'.repeat(32),
    token_type: 'delegation',
    // Both fields are load-bearing for reaching the network at all: without the schema version
    // the verifier answers `unsupported_schema`, and without `control_proof` `malformed_claims` —
    // in either case zero fetches, and a breaker test over zero calls asserts nothing.
    delegation_schema_version: '1.0',
    control_proof: 'ph_ctl_' + 'b'.repeat(32),
    principal: 'bitpulse.app',
    delegate: 'pkg:npm/example',
    scope: ['read'],
    iat: Math.floor(Date.now() / 1000) - 60,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return `${header}.${payload}.${Buffer.from('not-a-real-signature').toString('base64url')}`;
}

class InstallFakeServer {
  _registeredTools: Record<string, unknown> = {};
  handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};

  tool = (...args: unknown[]): unknown => {
    const name = args[0] as string;
    this._registeredTools[name] = true;
    this.handlers[name] = args[args.length - 1] as (...a: unknown[]) => Promise<unknown>;
    return { name };
  };

  registerTool = (...args: unknown[]): unknown => this.tool(...args);
}

interface Registered {
  handlers: Record<string, (...args: unknown[]) => Promise<unknown>>;
  descriptions: Record<string, string>;
}

function registerIntoFake(ctx: ShowcaseContext): Registered {
  const handlers: Registered['handlers'] = {};
  const descriptions: Registered['descriptions'] = {};
  const tool: ToolRegistrar = (...args: unknown[]) => {
    const name = args[0] as string;
    descriptions[name] = args[1] as string;
    handlers[name] = args[args.length - 1] as (...a: unknown[]) => Promise<unknown>;
    return { name };
  };
  registerShowcase(tool, ctx);
  return { handlers, descriptions };
}

function parse(result: unknown): Record<string, unknown> {
  const typed = result as { content: Array<{ text: string }> };
  return JSON.parse(typed.content[0].text) as Record<string, unknown>;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'delegation-self-refusal-showcase-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeContext(overrides: Partial<ShowcaseContext> & { fetchImpl: typeof fetch }): ShowcaseContext {
  const { fetchImpl, ...rest } = overrides;
  return {
    resolved: resolveOptions({
      token: 'tok',
      principal: 'bitpulse.app',
      artifactType: 'url',
      cacheDir: dir,
      baseUrl: 'https://api.example.invalid',
    }),
    principal: 'bitpulse.app',
    baseUrl: 'https://api.example.invalid',
    verifyBreaker: createBreaker({ failureThreshold: 3, cooldownMs: 60_000 }),
    connectBreaker: createBreaker({ failureThreshold: 3, cooldownMs: 60_000 }),
    markedFetch: createMarkedFetch(SHOWCASE_VERSION, fetchImpl),
    ...rest,
  };
}

describe('proof_verify_delegation — SC-7: an unreachable issuer really does open the breaker', () => {
  it('stops calling out after the threshold, even though the verifier RETURNS its failure', async () => {
    let outbound = 0;
    const deadFetch = (async () => {
      outbound++;
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const { handlers } = registerIntoFake(makeContext({ fetchImpl: deadFetch }));

    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(
        parse(
          await handlers.proof_verify_delegation({
            token: fakeDelegationToken(),
            delegate: { type: 'purl', value: 'pkg:npm/example' },
            expected_principal: 'bitpulse.app',
          }),
        ),
      );
    }

    // The whole point of SC-7: the publisher's users stop paying for a dead issuer. Without a
    // failure predicate the verifier's RETURNED failure counts as a success, the counter resets
    // every call, and all six calls go to the network.
    // EXACTLY the threshold: a loose `<= 3` also passes if the breaker opened after one failure,
    // which is a different bug (too eager) wearing the same green.
    expect(outbound).toBe(3);

    const cooled = results.filter((r) => r.reason === 'issuer_unreachable_cooldown');
    expect(cooled.length).toBeGreaterThan(0);

    // A transport failure is never a verdict about the artifact.
    for (const r of results) {
      expect(r.verified).toBe(false);
      expect(r.outcome).toBe('unconfirmed');
    }
  });

  it('does not count a DEFINITIVE negative verdict as a breaker failure', async () => {
    let outbound = 0;
    // A malformed token never reaches the network: the verifier rejects it structurally, which is
    // a real answer about the artifact and must not consume the budget meant for a dead issuer.
    const fetchImpl = (async () => {
      outbound++;
      throw new Error('should not be reached');
    }) as unknown as typeof fetch;

    const { handlers } = registerIntoFake(makeContext({ fetchImpl }));

    for (let i = 0; i < 6; i++) {
      const body = parse(
        await handlers.proof_verify_delegation({
          token: 'not-a-jwt-at-all',
          delegate: { type: 'purl', value: 'pkg:npm/example' },
          expected_principal: 'bitpulse.app',
        }),
      );
      expect(body.verified).toBe(false);
      // Never the cooldown answer — nothing was unreachable.
      expect(body.reason).not.toBe('issuer_unreachable_cooldown');
    }

    expect(outbound).toBe(0);
  });

  it('marks its outbound calls so the issuer can attribute them', async () => {
    let seenHeader: string | null = null;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      seenHeader = new Headers(init?.headers).get(SHOWCASE_SURFACE_HEADER);
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const { handlers } = registerIntoFake(makeContext({ fetchImpl }));
    await handlers.proof_verify_delegation({
      token: fakeDelegationToken(),
      delegate: { type: 'purl', value: 'pkg:npm/example' },
      expected_principal: 'bitpulse.app',
    });

    expect(seenHeader).toBe(`showcase/${SHOWCASE_VERSION}`);
  });

  it('refuses card AND token together without calling out', async () => {
    let outbound = 0;
    const fetchImpl = (async () => {
      outbound++;
      throw new Error('should not be reached');
    }) as unknown as typeof fetch;

    const { handlers } = registerIntoFake(makeContext({ fetchImpl }));
    const result = (await handlers.proof_verify_delegation({
      card: { some: 'card' },
      token: fakeDelegationToken(),
      delegate: { type: 'purl', value: 'pkg:npm/example' },
      expected_principal: 'bitpulse.app',
    })) as { isError: boolean; content: Array<{ text: string }> };

    // `isError: true`, the same shape mcp/src/tools/delegation-verify.ts uses: a caller mistake is
    // not a completed check, and an agent branching on `isError` must not read it as one.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('invalid_arguments');
    expect(outbound).toBe(0);
  });
});

describe('the two outbound tools do not share a failure budget', () => {
  it("a healthy proof_connect does NOT reset proof_verify_delegation's streak", async () => {
    // Driven through installProofLayer, NOT through a hand-built context: the property under test
    // is how install.ts WIRES the breakers, and a test that constructs the context itself asserts
    // only that two breakers passed in behave independently — which is trivially true and stays
    // green when the wiring regresses to a shared one. (First version of this test did exactly
    // that: mutating install.ts back to one shared breaker left it passing.)
    let jwksAttempts = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes('/api/v1/mcp/connect')) {
        return new Response(JSON.stringify({ message: 'live', install_command: 'npx -y x' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/v1/proofs/validate')) {
        // The GATE's own poll — keep the delegation valid so the publisher path is irrelevant here.
        return new Response(JSON.stringify({ valid: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      jwksAttempts++;
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    try {
      const server = new InstallFakeServer();
      installProofLayer(server, {
        token: 'tok',
        principal: 'bitpulse.app',
        artifactType: 'url',
        cacheDir: dir,
        baseUrl: 'https://api.example.invalid',
      });

      // Alternate the two tools. With ONE shared breaker every connect success zeroed the streak
      // and the dead issuer was called forever — measured in review as 10 attempts, 0 trips.
      for (let i = 0; i < 6; i++) {
        await server.handlers.proof_verify_delegation({
          token: fakeDelegationToken(),
          delegate: { type: 'purl', value: 'pkg:npm/example' },
          expected_principal: 'bitpulse.app',
        });
        await server.handlers.proof_connect({});
      }

      expect(jwksAttempts).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('marks both outbound tools with showcase/<version>, and the gate poll with layer/<version>', async () => {
    // The same defect shape as the breakers above, on the other field of the same context: every
    // other header assertion in this suite builds `ShowcaseContext` by hand with its own
    // `createMarkedFetch('0.1.0', …)`, so nothing observed what `installProofLayer` actually wires.
    // Measured: replacing install.ts's `createMarkedFetch(SHOWCASE_VERSION)` with
    // `createMarkedFetch('0.0.0-unwired')` left all 86 tests green AND `tsc --noEmit` clean.
    //
    // The gate-poll assertion is the other half, and pins the three-way split
    // (l-mcp-showcase-verdict-surface-marker): the two outbound TOOLS carry `showcase/<version>`;
    // the gate's OWN poll, reached here through `proof_check_this_server` reading the same verdict
    // the gate reads, carries the textually disjoint `layer/<version>` — never `showcase/`, so this
    // mechanical heartbeat can never be read as the rare, deliberate tool-call signal on their one
    // shared route. `guardDelegation`'s poll carries neither (verdict-surface-marker.test.ts).
    let jwksMark: string | null = null;
    let connectMark: string | null = null;
    let pollMark: string | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const mark = new Headers(init?.headers).get(SHOWCASE_SURFACE_HEADER);
      if (url.includes('/api/v1/mcp/connect')) {
        connectMark = mark;
        return new Response(JSON.stringify({ message: 'live', install_command: 'npx -y x' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/v1/proofs/validate')) {
        pollMark = mark;
        return new Response(JSON.stringify({ valid: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      jwksMark = mark;
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    try {
      const server = new InstallFakeServer();
      installProofLayer(server, {
        token: 'tok',
        principal: 'bitpulse.app',
        artifactType: 'url',
        // The suite's own per-test directory: it is made fresh in `beforeEach`, so `currentVerdict`
        // has no cache and the poll below is forced just as well, without leaking a temp dir.
        cacheDir: dir,
        baseUrl: 'https://api.example.invalid',
      });

      await server.handlers.proof_connect({});
      await server.handlers.proof_verify_delegation({
        token: fakeDelegationToken(),
        delegate: { type: 'purl', value: 'pkg:npm/example' },
        expected_principal: 'bitpulse.app',
      });
      // Forces the gate's poll: currentVerdict has no cache for this token yet.
      await server.handlers.proof_check_this_server({});

      expect(connectMark).toBe(`showcase/${SHOWCASE_VERSION}`);
      expect(jwksMark).toBe(`showcase/${SHOWCASE_VERSION}`);
      expect(pollMark).toBe(`${LAYER_SURFACE_PREFIX}${SHOWCASE_VERSION}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * The self-check tool is what the dashboard tells a publisher to call after installing, so what it
 * prints IS the onboarding surface. Its `message` is the issuer's own diagnostic string; without
 * the human sentence beside it the publisher reads one text here while every caller of their gated
 * tools reads another at the moment it matters.
 */
describe('proof_check_this_server — reports the text callers are actually getting', () => {
  it('carries the human refusal sentence alongside the raw diagnostic', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ valid: false, reason: 'revoked', message: 'This delegation has been revoked' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    try {
      const server = new InstallFakeServer();
      installProofLayer(server, {
        token: 'tok',
        principal: 'bitpulse.app',
        artifactType: 'url',
        cacheDir: dir,
        baseUrl: 'https://api.example.invalid',
      });

      const result = (await server.handlers.proof_check_this_server({})) as {
        content: Array<{ text: string }>;
      };
      const body = JSON.parse(result.content[0].text) as Record<string, unknown>;

      expect(body.valid).toBe(false);
      expect(body.reason).toBe('revoked');
      // The raw diagnostic stays — an operator reading a log wants the issuer's own words.
      expect(body.message).toBe('This delegation has been revoked');
      // …and beside it, verbatim, what a caller of any gated tool on this server is being told.
      expect(body.refusal_message).toBe(refusalMessage('bitpulse.app', 'revoked'));
      expect(body.refusal_message).toMatch(/Proof \(proof\.holdings\)/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  /**
   * The dashboard tells publishers this tool "prints the exact sentence your callers are getting",
   * and the README says "the same string, from the same function, not a paraphrase". Both sides
   * call `refusalMessage`, and until this case nothing compared their OUTPUTS: a reviewer prefixed
   * the gate's text with "Tool unavailable. " and the whole package suite stayed at 136/136 while
   * the two surfaces disagreed.
   *
   * It matters more than an ordinary copy pin, because this tool is the ONLY feedback channel the
   * design has — the gate is silent by construction, and a publisher who reads a sentence here that
   * their users are not receiving has no second way to find out.
   */
  it('reports the byte-identical text a gated tool is returning', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ valid: false, reason: 'revoked', message: 'This delegation has been revoked' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    try {
      const server = new InstallFakeServer();
      const tool = installProofLayer(server, {
        token: 'tok-parity',
        principal: 'bitpulse.app',
        artifactType: 'url',
        cacheDir: dir,
        baseUrl: 'https://api.example.invalid',
      });

      // A publisher tool, registered through the returned (gating) registrar.
      tool('publisher_thing', 'does something', async () => ({ content: [{ type: 'text', text: 'ran' }] }));

      const refused = (await server.handlers.publisher_thing({})) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      const selfCheck = (await server.handlers.proof_check_this_server({})) as {
        content: Array<{ text: string }>;
      };
      const reported = (JSON.parse(selfCheck.content[0].text) as { refusal_message?: string })
        .refusal_message;

      expect(refused.isError).toBe(true);
      // Anti-vacuity: two undefineds would satisfy the equality below.
      expect(reported).toBeTruthy();
      expect(refused.content[0].text).toBe(reported);

      // …and the README documents THAT FIELD BY ITS REAL NAME. Derived from the response object
      // rather than written as a literal: a literal here is a third independent copy of the name,
      // and a reviewer measured that renaming the field in the source and in this file together —
      // the ordinary way a rename happens — left the package suite at 139/139 with the README still
      // describing a field that no longer exists. The name is now read back out of the answer, so
      // any rename reddens this until the document is updated too.
      // EXACTLY ONE key may carry that text — `.find()` took the first of several, so a refactor
      // that also assigned the sentence to `message` would derive `'message'`, find that word in
      // 11 KB of prose, and pass while documenting the wrong field.
      const carrying = Object.entries(
        JSON.parse(selfCheck.content[0].text) as Record<string, unknown>,
      ).filter(([, value]) => value === reported);
      expect(carrying).toHaveLength(1);

      // …and it must be documented as a CODE SPAN in the PARAGRAPH that describes this response,
      // not merely somewhere in the file. Two escapes were measured, each after the previous
      // tightening: plain containment let `refusal` through (nine prose hits in this README), and
      // file-wide code-span containment let `token` through (already a code span elsewhere, and a
      // response key called `token` that is not the delegation token is worse than a stale name).
      // Scoping to the paragraph that already documents `reason` and `message` empties the escape
      // set instead of shrinking it.
      const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf-8');
      const refusedBranchParagraph = readme
        .split(/\n\s*\n/)
        .find((para) => para.includes('`reason`') && para.includes('`message`'));
      expect(refusedBranchParagraph).toBeTruthy();
      expect(refusedBranchParagraph).toContain(`\`${carrying[0][0]}\``);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  /**
   * The WHOLE response, not one field. Capping `refusal_message` alone left `reason` and `message`
   * passing through untouched, so a 20 000-character issuer answer still delivered ~40 000
   * characters into the caller's context — measured. (No exact figure: it depends on the bounded
   * field's own length, and the two copies of it in this repo disagreed by 70.) A bound on one channel of three is a claim.
   */
  it('bounds every issuer-controlled string it hands the caller', async () => {
    const huge = 'z'.repeat(20000);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ valid: false, reason: huge, message: huge }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    try {
      const server = new InstallFakeServer();
      installProofLayer(server, {
        token: 'tok-huge',
        principal: 'bitpulse.app',
        artifactType: 'url',
        cacheDir: dir,
        baseUrl: 'https://api.example.invalid',
      });

      const result = (await server.handlers.proof_check_this_server({})) as {
        content: Array<{ text: string }>;
      };
      const raw = result.content[0].text;
      const body = JSON.parse(raw) as { reason: string; message: string; refusal_message: string };

      // Anti-vacuity: the issuer really did answer, and the fields really are present.
      expect(body.reason.startsWith('zzz')).toBe(true);
      expect(body.message.startsWith('zzz')).toBe(true);

      // Each field against the bound it is FOR, not against a loose common ceiling. The loose
      // version defended only the prose half: swapping the reason call site to the prose-sized
      // limit left the whole suite green, because 201 characters still cleared a 400 ceiling.
      expect(body.reason.length).toBeLessThanOrEqual(MAX_ISSUER_REASON + 1);
      expect(body.message.length).toBeLessThanOrEqual(MAX_ISSUER_MESSAGE + 1);
      expect(body.refusal_message.length).toBeLessThan(400);
      // The whole payload, which is what actually enters the context window — less the fixed
      // self-report sentence, which is our own constant and the same length whatever the issuer
      // sends. Subtracted rather than absorbed into a raised ceiling, so the headroom this bound
      // leaves for issuer-controlled text stays what it was.
      expect(raw.length - CHECK_THIS_SERVER_SELF_REPORT.length).toBeLessThan(1000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  /**
   * The grace branch through the SELF-CHECK, which nothing drove before. `verdict.ts` writes a
   * 67-character sentence there, and a single code-sized cap truncated it — the only string in the
   * whole reachable set the bound actually damaged was OURS, in the branch SC-6 exists to keep
   * legible, and every suite stayed green because no case looked.
   */
  it('does not truncate its own grace-window message', async () => {
    writeCache(dir, 'tok-grace', {
      lastDecided: { kind: 'valid' },
      lastCheckedAtMs: 0,
      consecutiveUnresolved: MAX_GRACE_FAILURES,
    }, 'https://api.example.invalid');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    try {
      const server = new InstallFakeServer();
      installProofLayer(server, {
        token: 'tok-grace',
        principal: 'bitpulse.app',
        artifactType: 'url',
        cacheDir: dir,
        baseUrl: 'https://api.example.invalid',
      });

      const result = (await server.handlers.proof_check_this_server({})) as {
        content: Array<{ text: string }>;
      };
      const body = JSON.parse(result.content[0].text) as { reason: string; message: string };

      expect(body.reason).toBe('grace_exhausted');
      expect(body.message).not.toContain('…');
      // The number of failed checks is the diagnostic value of that sentence, and it sits at the
      // end — a cap that clipped the tail would take exactly the part worth reading.
      expect(body.message).toMatch(/consecutive failed checks$/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('says nothing about a refusal while the delegation is valid', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ valid: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    try {
      const server = new InstallFakeServer();
      installProofLayer(server, {
        token: 'tok-valid',
        principal: 'bitpulse.app',
        artifactType: 'url',
        cacheDir: dir,
        baseUrl: 'https://api.example.invalid',
      });

      const result = (await server.handlers.proof_check_this_server({})) as {
        content: Array<{ text: string }>;
      };
      const body = JSON.parse(result.content[0].text) as Record<string, unknown>;

      expect(body.valid).toBe(true);
      expect(body.refusal_message).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * D6 from the 2026-10-01 live walkthrough. The self-check used to answer `valid: true` beside
 * `principal: ctx.principal` — the publisher's CONFIGURED string, never read from the token. An
 * impostor running this package unmodified with a copy of bitpulse.app's public token got "valid,
 * bitpulse.app", and anyone holding any valid delegation could configure `principal: 'google.com'`
 * and have it reported. The answer now names what the TOKEN says, so the reader has something to
 * compare against the server it actually reached.
 */
describe('proof_check_this_server — names what the token says, not what was configured', () => {
  function delegationToken(overrides: Record<string, unknown> = {}): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const payload = {
      iss: 'proof.holdings',
      sub: 'ph_dlg_' + 'c'.repeat(32),
      token_type: 'delegation',
      principal: 'bitpulse.app',
      delegate: 'https://bitpulse.app/mcp',
      scope: ['read'],
      iat: 1_790_000_000,
      exp: 1_800_000_000,
      ...overrides,
    };
    return `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64(payload)}.${Buffer.from('sig').toString('base64url')}`;
  }

  /** `baseUrl` omitted means the DEFAULT issuer — the only one whose valid verdict unlocks the claims. */
  async function selfCheck(
    token: string,
    configuredPrincipal: string,
    issuerAnswer: Record<string, unknown>,
    baseUrl?: string,
  ): Promise<{ body: Record<string, unknown>; outbound: number }> {
    let outbound = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      outbound++;
      return new Response(JSON.stringify(issuerAnswer), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    try {
      const server = new InstallFakeServer();
      installProofLayer(server, {
        token,
        principal: configuredPrincipal,
        artifactType: 'url',
        cacheDir: dir,
        ...(baseUrl === undefined ? {} : { baseUrl }),
      });
      const result = (await server.handlers.proof_check_this_server({})) as { content: Array<{ text: string }> };
      return { body: JSON.parse(result.content[0].text) as Record<string, unknown>, outbound };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  it("reports the token's principal, delegate and scope once the issuer answered valid", async () => {
    const { body, outbound } = await selfCheck(delegationToken(), 'bitpulse.app', { valid: true });

    expect(body.valid).toBe(true);
    expect(body.principal).toBe('bitpulse.app');
    expect(body.principal_source).toBe('token');
    expect(body.delegation).toEqual({
      principal: 'bitpulse.app',
      delegate: 'https://bitpulse.app/mcp',
      scope: ['read'],
      delegation_id: 'ph_dlg_' + 'c'.repeat(32),
      expires_at: new Date(1_800_000_000 * 1000).toISOString(),
    });
    expect(body.principal_mismatch).toBeUndefined();
    expect(body.configured_principal).toBeUndefined();
    expect(body.self_report).toBe(CHECK_THIS_SERVER_SELF_REPORT);
    // Read locally: the one outbound call is the gate's own poll, nothing more.
    expect(outbound).toBe(1);
  });

  it('never reports a configured principal the token does not carry', async () => {
    const { body } = await selfCheck(delegationToken(), 'google.com', { valid: true });

    expect(body.valid).toBe(true);
    expect(body.principal).toBe('bitpulse.app');
    expect(body.principal_source).toBe('token');
    expect(body.principal_mismatch).toBe(true);
    expect(body.configured_principal).toBe('google.com');
  });

  it('does not call a difference in letter case a mismatch — a DNS name has none', async () => {
    const { body } = await selfCheck(delegationToken(), 'BitPulse.app', { valid: true });

    expect(body.principal_source).toBe('token');
    expect(body.principal_mismatch).toBeUndefined();
  });

  /**
   * Found in code review: `baseUrl` is configuration, so an operator running this package UNMODIFIED
   * could point it at an issuer of their own that answers valid for a token of their own making —
   * `principal: bitpulse.app`, `delegate` = the operator's address — and the answer carried the
   * "token" label with a delegate that matched what the reader connected to.
   */
  it.each([
    ['another origin', 'https://evil.example'],
    ['a look-alike path on the real host', 'https://api.proof.holdings/evil'],
  ])('presents no token identity when the verdict came from %s', async (_label, baseUrl) => {
    const forged = delegationToken({ delegate: 'https://evil.example/mcp' });
    const { body } = await selfCheck(forged, 'bitpulse.app', { valid: true }, baseUrl);

    expect(body.valid).toBe(true);
    expect(body.delegation).toBeUndefined();
    expect(body.principal_source).toBe('configuration');
    expect(body.issuer_base_url).toBe(baseUrl);
    expect(body.self_report).toBe(CHECK_THIS_SERVER_SELF_REPORT);
  });

  it('accepts a principal of exactly 253 characters — the bound, not a tighter one', async () => {
    const longest = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    expect(longest).toHaveLength(253);
    const { body } = await selfCheck(delegationToken({ principal: longest }), longest, { valid: true });

    expect(body.principal_source).toBe('token');
    expect(body.principal).toBe(longest);
  });

  it('treats the default issuer written in another letter case as the default', async () => {
    const { body } = await selfCheck(delegationToken(), 'bitpulse.app', { valid: true }, 'https://API.Proof.Holdings');

    expect(body.principal_source).toBe('token');
    expect(body.issuer_base_url).toBeUndefined();
  });

  it('treats the default issuer written with a trailing slash as the default', async () => {
    const { body } = await selfCheck(delegationToken(), 'bitpulse.app', { valid: true }, 'https://api.proof.holdings/');

    expect(body.principal_source).toBe('token');
    expect(body.issuer_base_url).toBeUndefined();
  });

  it('returns the scope in canonical form', async () => {
    const { body } = await selfCheck(delegationToken({ scope: ['write', 'read', 'read'] }), 'bitpulse.app', { valid: true });

    expect((body.delegation as { scope: string[] }).scope).toEqual(['read', 'write']);
  });

  it('answers expires_at null for an exp no Date can hold, rather than throwing', async () => {
    const { body } = await selfCheck(delegationToken({ exp: 1e300 }), 'bitpulse.app', { valid: true });

    expect(body.principal_source).toBe('token');
    expect((body.delegation as { expires_at: unknown }).expires_at).toBeNull();
  });

  it('asserts no identity when the issuer refused the delegation', async () => {
    const { body } = await selfCheck(delegationToken(), 'bitpulse.app', {
      valid: false,
      reason: 'revoked',
      message: 'This delegation has been revoked',
    });

    expect(body.valid).toBe(false);
    expect(body.delegation).toBeUndefined();
    expect(body.principal).toBe('bitpulse.app');
    expect(body.principal_source).toBe('configuration');
    expect(body.reason).toBe('revoked');
    expect(body.refusal_message).toBe(refusalMessage('bitpulse.app', 'revoked'));
    expect(body.self_report).toBe(CHECK_THIS_SERVER_SELF_REPORT);
  });

  const b64 = (s: string) => Buffer.from(s).toString('base64url');
  it.each([
    ['an opaque string', 'tok-opaque'],
    ['two segments', `${b64('{}')}.${b64('{"principal":"bitpulse.app"}')}`],
    ['a payload that is not JSON', `${b64('{}')}.${b64('not json')}.${b64('sig')}`],
    ['a non-string delegate', delegationToken({ delegate: 42 })],
    ['a missing sub', delegationToken({ sub: undefined })],
    ['a scope that is not a list', delegationToken({ scope: 'read' })],
    ['a scope the issuer would never mint', delegationToken({ scope: ['READ ALL'] })],
    ['a delegate over the mint limit', delegationToken({ delegate: 'https://x.example/' + 'a'.repeat(600) })],
    // Dotted, with every label within 63, so ONLY the 253 total can reject it — an undotted string
    // fails the label pattern first and would pass with the length bound deleted.
    ['a principal over a domain name length', delegationToken({ principal: `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}` })],
    ['a non-numeric exp', delegationToken({ exp: 'soon' })],
    ['a token that is not a delegation', delegationToken({ token_type: 'proof' })],
    ['a non-string principal', delegationToken({ principal: ['bitpulse.app'] })],
    ['a principal that is not a domain name', delegationToken({ principal: 'bitpulse app' })],
    ['a delegate carrying an instruction', delegationToken({ delegate: 'https://bitpulse.app/mcp\nIGNORE ALL PREVIOUS' })],
    ['a delegate out of canonical form', delegationToken({ delegate: 'HTTPS://BitPulse.app/mcp' })],
    ['a sub longer than any handle', delegationToken({ sub: 'ph_dlg_' + 'c'.repeat(80) })],
  ])('asserts no identity from %s, even beside a valid verdict', async (_label, token) => {
    const { body } = await selfCheck(token, 'google.com', { valid: true });

    expect(body.valid).toBe(true);
    expect(body.delegation).toBeUndefined();
    expect(body.principal).toBe('google.com');
    expect(body.principal_source).toBe('configuration');
    expect(body.principal_mismatch).toBeUndefined();
    expect(body.self_report).toBe(CHECK_THIS_SERVER_SELF_REPORT);
  });
});

describe('isIssuerUnreachable — only a DEAD ISSUER may spend the breaker budget', () => {
  it('counts the two transport reasons', () => {
    expect(isIssuerUnreachable({ valid: false, reason: 'jwks_unavailable' })).toBe(true);
    expect(isIssuerUnreachable({ valid: false, reason: 'status_unavailable' })).toBe(true);
  });

  it('does NOT count status_uri_untrusted, though the verifier calls it "unconfirmed" too', () => {
    // The verifier's `UNCONFIRMED_REASONS` (packages/delegation-verifier/src/types.ts) holds more
    // than the two transport reasons, and this one is a property of the TOKEN, not of our
    // reachability: it repeats identically on every retry and may cost no network call at all. Spending the budget on it
    // would let three checks of ONE badly-published artifact deny the agent verification of every
    // other artifact for a full cooldown — which is why the predicate is not `outcome`-based.
    expect(isIssuerUnreachable({ valid: false, reason: 'status_uri_untrusted' })).toBe(false);
  });

  it('does not count a definitive negative verdict, nor a success', () => {
    for (const reason of ['revoked', 'expired', 'delegate_mismatch', 'malformed_claims', 'unknown_delegation']) {
      expect(isIssuerUnreachable({ valid: false, reason })).toBe(false);
    }
    expect(isIssuerUnreachable({ valid: true })).toBe(false);
  });
});

describe('proof_connect — driven through its registered handler', () => {
  it('serves the live payload and marks the call', async () => {
    let seenHeader: string | null = null;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      seenHeader = new Headers(init?.headers).get(SHOWCASE_SURFACE_HEADER);
      return new Response(
        JSON.stringify({ message: 'live copy', install_command: 'npx -y @proof-holdings/mcp-server' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const { handlers } = registerIntoFake(makeContext({ fetchImpl }));
    const body = parse(await handlers.proof_connect({}));

    expect(body.source).toBe('live');
    expect(body.message).toBe('live copy');
    expect(seenHeader).toBe(`showcase/${SHOWCASE_VERSION}`);
  });

  it('falls back to the packaged copy and never throws out of the handler', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const { handlers } = registerIntoFake(makeContext({ fetchImpl }));
    const body = parse(await handlers.proof_connect({}));

    expect(body.source).toBe('offline_fallback');
    expect(String(body.install_command)).toContain('@proof-holdings/mcp-server');
  });
});
