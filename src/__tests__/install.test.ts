import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { guardDelegation } from '../guard.js';
import { installProofLayer } from '../install.js';
import { showcaseInstructionsParagraph } from '../showcase/instructions.js';
import type { McpServerLike } from '../registrar.js';

class FakeServer implements McpServerLike {
  _registeredTools: Record<string, unknown> = {};
  handlers: Record<string, (...args: unknown[]) => unknown> = {};

  tool = (...args: unknown[]): unknown => {
    const name = args[0] as string;
    const handler = args[args.length - 1] as (...a: unknown[]) => unknown;
    this._registeredTools[name] = true;
    this.handlers[name] = handler;
    return { name };
  };

  registerTool = (...args: unknown[]): unknown => {
    const name = args[0] as string;
    const handler = args[args.length - 1] as (...a: unknown[]) => unknown;
    this._registeredTools[name] = true;
    this.handlers[name] = handler;
    return { name };
  };
}

function stubFetch(body: unknown, status = 200): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function parse(result: unknown): Record<string, unknown> {
  const typed = result as { content: Array<{ text: string }> };
  return JSON.parse(typed.content[0].text) as Record<string, unknown>;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'delegation-self-refusal-install-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('installProofLayer — SC-1: the showcase survives what the gate refuses', () => {
  it("refuses the publisher's own tool but still answers proof_check_this_server when revoked", async () => {
    const restore = stubFetch({ valid: false, reason: 'revoked', message: 'This delegation has been revoked' });
    try {
      const server = new FakeServer();
      const tool = installProofLayer(server, {
        token: 'tok',
        principal: 'bitpulse.app',
        artifactType: 'url',
        cacheDir: dir,
      });

      let ran = false;
      tool('publisher_own_tool', 'desc', async () => {
        ran = true;
        return { content: [] };
      });

      const refused = (await server.handlers.publisher_own_tool()) as { isError: boolean };
      expect(ran).toBe(false);
      expect(refused.isError).toBe(true);

      // The whole point: the tool that REPORTS the revocation must not be killed by it.
      const showcase = (await server.handlers.proof_check_this_server({})) as { isError: boolean };
      expect(showcase.isError).toBe(false);
      const body = parse(showcase);
      expect(body.configured).toBe(true);
      expect(body.valid).toBe(false);
      expect(body.reason).toBe('revoked');
    } finally {
      restore();
    }
  });

  it('gates a tool registered through server.registerTool as well, while the showcase still answers', async () => {
    const restore = stubFetch({ valid: false, reason: 'suspended', message: 'suspended' });
    try {
      const server = new FakeServer();
      installProofLayer(server, { token: 'tok', principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir });

      let ran = false;
      server.registerTool('publisher_own_tool', { description: 'd' }, async () => {
        ran = true;
        return { content: [] };
      });

      const refused = (await server.handlers.publisher_own_tool()) as { isError: boolean };
      expect(ran).toBe(false);
      expect(refused.isError).toBe(true);

      const showcase = (await server.handlers.proof_check_this_server({})) as { isError: boolean };
      expect(showcase.isError).toBe(false);
    } finally {
      restore();
    }
  });

  // SC-4, not SC-1: this asserts the SET of registered names only. The ORDER (showcase registered
  // through the un-gated registrar, before the patch) is what the two tests above prove — verified
  // by mutating install.ts to register through the gated registrar, which reddens those two and
  // leaves this one green.
  it('registers exactly the three showcase tools and nothing else', async () => {
    const restore = stubFetch({ valid: false, reason: 'revoked', message: 'revoked' });
    try {
      const server = new FakeServer();
      installProofLayer(server, { token: 'tok', principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir });

      expect(Object.keys(server._registeredTools).sort()).toEqual([
        'proof_check_this_server',
        'proof_connect',
        'proof_verify_delegation',
      ]);
    } finally {
      restore();
    }
  });
});

describe('installProofLayer — SC-3: the showcase shares the gate\'s verdict, it does not poll', () => {
  it('answers proof_check_this_server without a SECOND network call after the gate already polled', async () => {
    let fetchCalls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ valid: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    try {
      const server = new FakeServer();
      const tool = installProofLayer(server, {
        token: 'tok',
        principal: 'bitpulse.app',
        artifactType: 'url',
        cacheDir: dir,
      });
      tool('publisher_own_tool', 'desc', async () => ({ content: [{ type: 'text', text: 'ran' }] }));

      // The gate polls once here and writes the verdict to the shared cache.
      await server.handlers.publisher_own_tool();
      expect(fetchCalls).toBe(1);

      // The showcase must READ that verdict. A poll of its own would land outside the jittered
      // grace schedule in schedule.ts (the SEC-DLG-02 fix) and, across a fleet, re-create the
      // thundering herd the jitter exists to prevent.
      const showcase = (await server.handlers.proof_check_this_server({})) as { isError: boolean };
      const body = JSON.parse((showcase as unknown as { content: Array<{ text: string }> }).content[0].text) as {
        valid: boolean;
      };

      expect(body.valid).toBe(true);
      expect(fetchCalls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('installProofLayer — SC-13: a repeat install has its own error', () => {
  it('throws an "already installed" error, not the "registered before the gate" one', () => {
    const server = new FakeServer();
    installProofLayer(server, { token: 'tok', principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir });

    expect(() =>
      installProofLayer(server, { token: 'tok', principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir }),
    ).toThrow(/already carries the Proof self-refusal layer/i);

    expect(() =>
      installProofLayer(server, { token: 'tok', principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir }),
    ).not.toThrow(/must run before any/i);
  });

  it("keeps the pre-existing wording when it is the PUBLISHER's tools that were registered first", () => {
    const server = new FakeServer();
    server.tool('send_email', 'desc', async () => ({ content: [] }));

    expect(() =>
      installProofLayer(server, { token: 'tok', principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir }),
    ).toThrow(/must run before any/i);
  });

  it('names the entry point the publisher actually called, not the other one', () => {
    // A publisher reading a startup crash must be sent to the function they invoked. The message
    // used to be hard-coded to `guardDelegation` regardless of the caller — same class of
    // ambiguity SC-13 removes at the other precondition, just at this one.
    const server = new FakeServer();
    server.tool('send_email', 'desc', async () => ({ content: [] }));

    expect(() =>
      installProofLayer(server, { token: 'tok', principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir }),
    ).toThrow(/installProofLayer must run before any/);

    expect(() =>
      installProofLayer(server, { token: 'tok', principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir }),
    ).not.toThrow(/guardDelegation/);
  });
});

// "EITHER order" is what this block used to be called, and two cases INSIDE it — the no-token
// repeats at the bottom — contradicted the title. The carve-out is deliberate (round 5: a benign
// no-op must not crash a publisher's startup), so a title asserting an unconditional throw invites
// the next reader to "restore" that crash. Named for what the code does: everything refuses except
// a no-token `guardDelegation` landing on a server already in the `optout` state.
describe('the two entry points refuse to be combined — except a no-token guardDelegation after an opt-out', () => {
  it('guardDelegation then installProofLayer throws instead of gating the showcase', async () => {
    const restore = stubFetch({ valid: false, reason: 'revoked', message: 'revoked' });
    try {
      const server = new FakeServer();
      guardDelegation(server, { token: 'tok', principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir });

      // Before this guard existed the call SUCCEEDED and registered the showcase through the gate,
      // because guardDelegation registers nothing — so the "nothing registered yet" precondition
      // passed while `server.tool` was already the gating wrapper. The result was silent until the
      // delegation was revoked, at which point `proof_check_this_server` answered the gate's
      // refusal instead of reporting the revocation: verbatim the failure this entry point exists
      // to prevent.
      expect(() =>
        installProofLayer(server, { token: 'tok', principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir }),
      ).toThrow(/already carries the Proof self-refusal layer/i);

      expect(Object.keys(server._registeredTools)).toEqual([]);
    } finally {
      restore();
    }
  });

  it('installProofLayer then guardDelegation throws too', () => {
    const server = new FakeServer();
    installProofLayer(server, { token: 'tok', principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir });

    expect(() =>
      guardDelegation(server, { token: 'tok', principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir }),
    ).toThrow(/already carries the Proof self-refusal layer/i);
  });

  it('guardDelegation WITHOUT a token then installProofLayer throws — the registrar is already out', async () => {
    const restore = stubFetch({ valid: false, reason: 'revoked', message: 'revoked' });
    try {
      const server = new FakeServer();
      // The ordinary bootstrap shape: no token in env yet, so the publisher takes the opt-out and
      // keeps the registrar it returned.
      const staleRegistrar = guardDelegation(server, { principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir });

      // The message names the state the server is ACTUALLY in — a raw registrar handed out, NOT an
      // installed layer. Claiming a layer here sent the reader looking for one that is not there.
      expect(() =>
        installProofLayer(server, { token: 'tok', principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir }),
      ).toThrow(/already handed out this server's RAW registrar/i);

      // And the point of refusing: that stale registrar is the RAW one. Had the install gone
      // through, tools registered with it would have run with no gate at all under a revoked
      // delegation — measured in code review as `{ ran: true, isError: undefined }`.
      let ran = false;
      staleRegistrar('publisher_tool', 'desc', async () => {
        ran = true;
        return { content: [{ type: 'text', text: 'ran' }] };
      });
      await server.handlers.publisher_tool();
      expect(ran).toBe(true);
      expect(Object.keys(server._registeredTools)).toEqual(['publisher_tool']);
    } finally {
      restore();
    }
  });

  it('a REPEAT no-token guardDelegation is idempotent, not a crash', () => {
    // Marking the opt-out closed a real hole, but routing this benign pair into the same throw was
    // a regression the fix introduced: the server carries no layer, gates nothing, and the second
    // call would hand back the identical raw registrar. A startup crash asserting an installation
    // that does not exist is worse than the no-op it replaced.
    const server = new FakeServer();
    const first = guardDelegation(server, { principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir });

    let second: unknown;
    expect(() => {
      second = guardDelegation(server, { principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir });
    }).not.toThrow();

    expect(typeof second).toBe('function');
    expect(Object.keys(server._registeredTools)).toEqual([]);
    void first;
  });

  it('but a TOKEN-carrying guardDelegation after the opt-out still refuses', () => {
    // The escape hazard is unchanged: the raw registrar is already out, so installing a gate now
    // would leave it ungated.
    const server = new FakeServer();
    guardDelegation(server, { principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir });

    expect(() =>
      guardDelegation(server, { token: 'tok', principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir }),
    ).toThrow(/already handed out this server's RAW registrar/i);
  });

  it('installProofLayer WITHOUT a token then guardDelegation WITH one refuses — naming the RIGHT state', () => {
    // The mirror of the case round 3 found broken. `markInstalled` sits above the no-token return
    // in install.ts, so the refusal holds by construction — and now by assertion, since it rests on
    // the position of that one line.
    const server = new FakeServer();
    installProofLayer(server, { principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir });

    // And the message must describe what this server IS: a raw registrar was handed out, no gate
    // was installed. It used to claim an installed layer — the exact defect the kind split exists
    // to remove, which had survived on this entry point.
    expect(() =>
      guardDelegation(server, { token: 'tok', principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir }),
    ).toThrow(/already handed out this server's RAW registrar/i);

    expect(() =>
      guardDelegation(server, { token: 'tok', principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir }),
    ).not.toThrow(/already carries the Proof self-refusal layer/i);
  });

  it('a no-token installProofLayer leaves the OPT-OUT state, so a no-token guardDelegation after it is idempotent', () => {
    const server = new FakeServer();
    installProofLayer(server, { principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir });

    expect(() =>
      guardDelegation(server, { principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir }),
    ).not.toThrow();

    // What each assertion actually buys, stated precisely because the previous comment here got it
    // wrong: `not.toThrow()` is what reddens on a kind mutation (`optout` → `gated`), and the
    // composition check proves the showcase really installed (SC-14). NEITHER distinguishes the
    // opt-out state from an ABSENT marker — deleting `markInstalled` on the no-token path leaves
    // both green. That distinction is made by the token-carrying case ABOVE (`installProofLayer`
    // without a token, then `guardDelegation` WITH one), which is refused with the RAW-registrar
    // wording. The case immediately below carries no token and pins a different property.
    expect(Object.keys(server._registeredTools).sort()).toEqual([
      'proof_check_this_server',
      'proof_connect',
      'proof_verify_delegation',
    ]);
  });

  it('but repeating the no-token installProofLayer itself REFUSES — it would re-register the showcase', () => {
    // The one cell of the marker matrix that had no test, and the previous title of the case above
    // asserted the opposite of the truth: `installProofLayer` is NOT idempotent even without a
    // token, because a second call re-registers three tools. The opt-out's idempotence belongs to
    // `guardDelegation`, which registers nothing.
    const server = new FakeServer();
    installProofLayer(server, { principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir });

    expect(() =>
      installProofLayer(server, { principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir }),
    ).toThrow(/already handed out this server's RAW registrar/i);

    // And nothing was registered twice by the refused call.
    expect(Object.keys(server._registeredTools).sort()).toEqual([
      'proof_check_this_server',
      'proof_connect',
      'proof_verify_delegation',
    ]);
  });

  it('an UNRECOGNISED marker value still counts as installed, never as absent', () => {
    // `Symbol.for` is process-global, so the marker is shared with any other copy of this package
    // in the same dependency tree — and the direction that matters is FORWARD: a NEWER copy may
    // write a kind this version has never heard of. A strict `'gated' | 'optout'` check would read
    // such a server as untouched and install a second layer over a gate that is already there.
    // (`true` is used here as the stand-in unknown value; a reviewer disproved the original
    // justification, which claimed an older copy had literally written it.)
    const server = new FakeServer();
    (server as unknown as Record<symbol, unknown>)[Symbol.for('proof-holdings.delegation-self-refusal.installed')] = true;

    expect(() =>
      installProofLayer(server, { token: 'tok', principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir }),
    ).toThrow(/already carries the Proof self-refusal layer/i);

    expect(() =>
      guardDelegation(server, { token: 'tok', principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir }),
    ).toThrow(/already carries the Proof self-refusal layer/i);

    // And it must not be mistaken for the opt-out state, whose repeat is deliberately idempotent.
    expect(() =>
      guardDelegation(server, { principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir }),
    ).toThrow(/already carries the Proof self-refusal layer/i);
  });

  it('a no-token guardDelegation on an installed server still refuses', () => {
    // The opt-out path returns early, so the check has to run BEFORE it — otherwise the one
    // combination that silently does nothing is the one that looks most like a mistake.
    const server = new FakeServer();
    installProofLayer(server, { token: 'tok', principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir });

    expect(() => guardDelegation(server, { principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir })).toThrow(
      /already carries the Proof self-refusal layer/i,
    );
  });
});

describe('installProofLayer — a failed showcase registration leaves NO trace', () => {
  it('rolls back partially registered tools and stays retryable', () => {
    // `.server._instructions` (SC-4): the write must sit strictly AFTER the try/catch this test
    // reddens — a throw here must never reach it, so a publisher who catches and continues is not
    // left with instructions naming tools that no longer exist.
    const server = Object.assign(new FakeServer(), { server: { _instructions: undefined as string | undefined } });
    // Capture the REAL implementation before swapping it: routing through `server.tool` after the
    // swap would re-enter the failing wrapper and blow up on the FIRST tool — which is a total
    // failure, not the half-registered state this test exists for. (The first version of this test
    // did exactly that, and a mutation removing the rollback left it green.)
    const realTool = server.tool;
    let registrations = 0;
    const failingTool = (...args: unknown[]): unknown => {
      registrations++;
      // Fail on the SECOND tool: the hazard is a half-registered showcase, not a total failure.
      // This is the shape a duplicate `zod` instance takes inside the SDK's schema conversion —
      // the exact case SC-17 exists to prevent.
      if (registrations === 2) throw new Error('zod instanceof check failed');
      return realTool(...args);
    };
    server.tool = failingTool as typeof server.tool;

    expect(() =>
      installProofLayer(server, { token: 'tok', principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir }),
    ).toThrow(/zod instanceof/);

    // Nothing of ours may remain: a publisher who wraps our call in try/catch would otherwise run
    // with zero self-refusal while carrying Proof-named tools that imply otherwise.
    expect(Object.keys(server._registeredTools)).toEqual([]);
    expect(server.server._instructions).toBeUndefined();

    // Retry on the SERVER THAT FAILED — a fresh one would pass no matter what the rollback did,
    // and it is the failed server's state (empty `_registeredTools`, marker never set) that this
    // claim is about. Exercising a clean object instead is an assertion that cannot fail.
    server.tool = realTool;
    expect(() =>
      installProofLayer(server, { token: 'tok', principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir }),
    ).not.toThrow();
    expect(Object.keys(server._registeredTools).sort()).toEqual([
      'proof_check_this_server',
      'proof_connect',
      'proof_verify_delegation',
    ]);
    // And the successful retry DOES write it — the assertion above proves absence during failure,
    // not that the write is broken outright.
    expect(server.server._instructions).toBe(showcaseInstructionsParagraph('bitpulse.app'));
  });
});

describe('installProofLayer — SC-14: no token means showcase without a gate', () => {
  it("registers the showcase, does not gate the publisher's tool, and makes zero network calls", async () => {
    const original = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error('no network call may happen with no token configured');
    }) as unknown as typeof fetch;

    try {
      const server = Object.assign(new FakeServer(), { server: { _instructions: undefined as string | undefined } });
      const tool = installProofLayer(server, { principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir });

      tool('publisher_own_tool', 'desc', async () => ({ content: [{ type: 'text', text: 'ran' }] }));
      const result = await server.handlers.publisher_own_tool();
      expect(result).toEqual({ content: [{ type: 'text', text: 'ran' }] });

      const showcase = (await server.handlers.proof_check_this_server({})) as { isError: boolean };
      const body = parse(showcase);
      expect(body.configured).toBe(false);
      // The absence of a delegation must never be dressed up as a positive verdict.
      expect(body.valid).not.toBe(true);
      expect(fetchCalls).toBe(0);

      // SC-5: the showcase registers on this path too, so the text that explains it must too.
      expect(server.server._instructions).toBe(showcaseInstructionsParagraph('bitpulse.app'));
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('installProofLayer — SC-2/SC-3: the instructions write degrades, never throws', () => {
  /** `.server._instructions` with only a getter — assignment throws (no setter), read returns undefined. */
  function serverWithThrowingInstructions(): FakeServer & { server: { _instructions?: string } } {
    return Object.assign(new FakeServer(), {
      server: {
        get _instructions(): string | undefined {
          return undefined;
        },
      },
    }) as FakeServer & { server: { _instructions?: string } };
  }

  it('a write that throws does not abort the install, across several FRESH servers in a row, and the returned registrar still gates', async () => {
    const restore = stubFetch({ valid: false, reason: 'revoked', message: 'revoked' });
    try {
      for (let i = 0; i < 3; i++) {
        const server = serverWithThrowingInstructions();
        const tool = installProofLayer(server, {
          token: 'tok',
          principal: 'bitpulse.app',
          artifactType: 'url',
          cacheDir: dir,
        });

        let ran = false;
        tool('publisher_own_tool', 'desc', async () => {
          ran = true;
          return { content: [] };
        });
        const refused = (await server.handlers.publisher_own_tool()) as { isError: boolean };
        expect(ran).toBe(false);
        expect(refused.isError).toBe(true);
      }
    } finally {
      restore();
    }
  });

  it('a server with no `.server` field at all installs without throwing (field-absent degradation)', () => {
    const server = new FakeServer();
    expect(() =>
      installProofLayer(server, { token: 'tok', principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir }),
    ).not.toThrow();
  });
});

describe('installProofLayer — SC-12: install never touches disk', () => {
  it('a nonexistent cacheDir stays nonexistent across several fresh installs', () => {
    const ghostDir = join(tmpdir(), `ghost-${Math.random().toString(36).slice(2)}`, 'nested');
    expect(existsSync(ghostDir)).toBe(false);

    for (let i = 0; i < 3; i++) {
      const server = new FakeServer();
      installProofLayer(server, {
        token: 'tok',
        principal: 'bitpulse.app',
        artifactType: 'url',
        cacheDir: ghostDir,
      });
      // The install itself must not touch disk — no tool was called, so any write here would be
      // the install path, not the gate's own poll-on-first-call (which SC-12 explicitly permits).
      expect(existsSync(ghostDir)).toBe(false);
      expect(existsSync(dirname(ghostDir))).toBe(false);
    }
  });

  it('guardDelegation likewise leaves a nonexistent cacheDir untouched', () => {
    const ghostDir = join(tmpdir(), `ghost-${Math.random().toString(36).slice(2)}`, 'nested');

    for (let i = 0; i < 3; i++) {
      const server = new FakeServer();
      guardDelegation(server, {
        token: 'tok',
        principal: 'bitpulse.app',
        artifactType: 'url',
        cacheDir: ghostDir,
      });
      expect(existsSync(ghostDir)).toBe(false);
      expect(existsSync(dirname(ghostDir))).toBe(false);
    }
  });
});

describe('installProofLayer — the caller\'s baseUrl reaches the showcase, not just the gate', () => {
  /**
   * The dashboard prints `baseUrl` into the snippet a publisher pastes (h-fix-mcp-refusal-roads
   * SC-8) precisely so a delegation minted on staging is not polled on production. Two DIFFERENT
   * reads carry that value: `resolveOptions` for the gate, and this file's own `const baseUrl` for
   * the showcase context. The second was covered only by a text pin in the issuer's drift suite,
   * and a code review showed the obvious mutation walks past it — replace the shorthand `baseUrl,`
   * in the `registerShowcase` call with `baseUrl: DEFAULT_BASE_URL` and it still compiles, still
   * matches the pinned expression, and nothing here or there notices. The consequence lands on
   * exactly the staging publisher this whole surface exists for: `proof_connect` fetches
   * production's connect document and `proof_verify_delegation` anchors trust on production's
   * issuer, so a real staging delegation reads as unverifiable.
   */
  it('proof_connect fetches the issuer the caller named', async () => {
    const probe = 'https://issuer.probe.invalid';
    const requested: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      requested.push(String(input));
      return new Response(JSON.stringify({ message: 'ok', install_command: 'npm i x' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    try {
      const server = new FakeServer();
      installProofLayer(server, { principal: 'example.test', artifactType: 'url', baseUrl: probe });
      await server.handlers.proof_connect({});

      // Anti-vacuity: a showcase that made no request at all would satisfy "never asked production".
      expect(requested.length).toBeGreaterThan(0);
      expect(requested.every((url) => url.startsWith(probe))).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});
