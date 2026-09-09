import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { guardDelegation } from '../guard.js';
import { installProofLayer } from '../install.js';
import { SHOWCASE_TOOL_NAMES } from '../showcase/tools.js';
import { showcaseInstructionsParagraph } from '../showcase/instructions.js';
import type { McpServerLike } from '../registrar.js';

/**
 * The one suite that runs against the REAL `@modelcontextprotocol/sdk`.
 *
 * Every other test here drives a hand-written `FakeServer` whose `tool` is an instance arrow
 * property and whose `_registeredTools` is a plain object we control. That leaves two claims
 * resting on a stand-in rather than on the thing this package actually binds:
 *
 *   1. `_registeredTools` is real SDK internal state (`mcp.js`), and the rollback in `install.ts`
 *      `delete`s keys out of it. Nothing proved those keys are shaped the way we assume.
 *   2. `server.tool` on a real `McpServer` is a PROTOTYPE method, not an own property. Patching an
 *      instance property therefore shadows the prototype — which works, but is a different
 *      operation from what the fake exercises, and `guardDelegation`'s whole contract rests on it.
 *
 * The SDK is already a devDependency "for typing tests" and until now no test imported it.
 */

const OPTS = { principal: 'bitpulse.app', artifactType: 'url' as const };

function newServer(instructions?: string): McpServer {
  return new McpServer({ name: 'test-publisher-server', version: '1.0.0' }, instructions ? { instructions } : undefined);
}

/** The SDK's registered-tool map, read the same way `registrar.ts` reads it. */
function registeredNames(server: McpServer): string[] {
  return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
}

/** `Server._instructions`, read via the same `server.server` path `install.ts` writes through (SC-1). */
function readInstructions(server: McpServer): unknown {
  return (server as unknown as { server: { _instructions?: unknown } }).server._instructions;
}

function stubFetch(body: unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'delegation-self-refusal-sdk-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('against the real McpServer — the assumptions the fake cannot check', () => {
  it('reads `_registeredTools` and registers the three showcase tools under their exact names', () => {
    const server = newServer();
    installProofLayer(server as unknown as McpServerLike, { ...OPTS, token: 'tok', cacheDir: dir });

    expect(registeredNames(server)).toEqual([...SHOWCASE_TOOL_NAMES].sort());
  });

  it('appends the recognition paragraph after the publisher\'s own instructions, via a separator (SC-1)', () => {
    const server = newServer('PUBLISHER TEXT');
    installProofLayer(server as unknown as McpServerLike, { ...OPTS, token: 'tok', cacheDir: dir });

    expect(readInstructions(server)).toBe(`PUBLISHER TEXT\n\n${showcaseInstructionsParagraph(OPTS.principal)}`);
  });

  it('writes the recognition paragraph alone, with no leading separator, when the publisher set none (SC-1)', () => {
    const server = newServer();
    installProofLayer(server as unknown as McpServerLike, { ...OPTS, token: 'tok', cacheDir: dir });

    expect(readInstructions(server)).toBe(showcaseInstructionsParagraph(OPTS.principal));
  });

  it('detects tools registered before the gate, through the SDK\'s own registration', () => {
    const server = newServer();
    server.tool('publisher_tool', 'desc', {}, async () => ({ content: [] }));

    expect(() =>
      installProofLayer(server as unknown as McpServerLike, { ...OPTS, token: 'tok', cacheDir: dir }),
    ).toThrow(/must run before any/i);
  });

  it('gates a real SDK tool while the showcase keeps answering under a revoked delegation', async () => {
    const restore = stubFetch({ valid: false, reason: 'revoked', message: 'revoked' });
    try {
      const server = newServer();
      const tool = installProofLayer(server as unknown as McpServerLike, {
        ...OPTS,
        token: 'tok',
        cacheDir: dir,
      });

      let ran = false;
      tool('publisher_tool', 'desc', { value: z.string() }, async () => {
        ran = true;
        return { content: [] };
      });

      // `handler` is the SDK 1.27 field name (verified by inspecting a real registration, not
      // assumed). This package never reads it — `registrar.ts` only counts keys and the rollback
      // deletes them — so the coupling lives in this test alone.
      const registry = (server as unknown as { _registeredTools: Record<string, { handler: (...a: unknown[]) => unknown }> })
        ._registeredTools;

      const refused = (await registry.publisher_tool.handler({ value: 'x' }, {})) as { isError: boolean };
      expect(ran).toBe(false);
      expect(refused.isError).toBe(true);

      // The tool that reports the revocation must survive it — on the real server, not just the fake.
      const showcase = (await registry.proof_check_this_server.handler({}, {})) as {
        isError: boolean;
        content: Array<{ text: string }>;
      };
      expect(showcase.isError).toBe(false);
      expect(JSON.parse(showcase.content[0].text)).toMatchObject({ configured: true, valid: false, reason: 'revoked' });
    } finally {
      restore();
    }
  });

  it('rolls a failed showcase registration off the REAL registry, leaving it empty', () => {
    const server = newServer();
    const realTool = server.tool.bind(server);
    let registrations = 0;

    // Fail on the second tool — the half-registered state, which is what the rollback exists for.
    (server as unknown as { tool: unknown }).tool = (...args: unknown[]): unknown => {
      registrations++;
      if (registrations === 2) throw new Error('zod instanceof check failed');
      return (realTool as (...a: unknown[]) => unknown)(...args);
    };

    expect(() =>
      installProofLayer(server as unknown as McpServerLike, { ...OPTS, token: 'tok', cacheDir: dir }),
    ).toThrow(/zod instanceof/);

    // `delete server._registeredTools[name]` against the SDK's own store, not our object literal.
    expect(registeredNames(server)).toEqual([]);
  });

  it('refuses the two entry points combined, on a real server, in both orders', () => {
    const a = newServer();
    guardDelegation(a as unknown as McpServerLike, { ...OPTS, token: 'tok', cacheDir: dir });
    expect(() => installProofLayer(a as unknown as McpServerLike, { ...OPTS, token: 'tok', cacheDir: dir })).toThrow(
      /already carries the Proof self-refusal layer/i,
    );

    const b = newServer();
    installProofLayer(b as unknown as McpServerLike, { ...OPTS, token: 'tok', cacheDir: dir });
    expect(() => guardDelegation(b as unknown as McpServerLike, { ...OPTS, token: 'tok', cacheDir: dir })).toThrow(
      /already carries the Proof self-refusal layer/i,
    );
  });
});
