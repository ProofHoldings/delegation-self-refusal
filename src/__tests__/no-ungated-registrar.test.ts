import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as pkg from '../index.js';
import type { McpServerLike } from '../registrar.js';

/**
 * SC-2: no export of this package may hand a caller a registrar that bypasses the gate.
 *
 * The failure this guards against is silent by construction: a publisher who routes one tool
 * through an un-gated registrar nulls their own self-refusal for that tool, and from the outside
 * the installation still looks exactly like a correct one. Nothing at runtime would report it.
 *
 * The test therefore does not inspect names or read the source — it EXERCISES the surface: every
 * exported function is called with a server and options, and anything function-shaped that comes
 * back must refuse when the delegation is revoked.
 */

class FakeServer implements McpServerLike {
  _registeredTools: Record<string, unknown> = {};
  handlers: Record<string, (...args: unknown[]) => unknown> = {};

  tool = (...args: unknown[]): unknown => {
    const name = args[0] as string;
    this._registeredTools[name] = true;
    this.handlers[name] = args[args.length - 1] as (...a: unknown[]) => unknown;
    return { name };
  };

  registerTool = (...args: unknown[]): unknown => {
    const name = args[0] as string;
    this._registeredTools[name] = true;
    this.handlers[name] = args[args.length - 1] as (...a: unknown[]) => unknown;
    return { name };
  };
}

function stubRevoked(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ valid: false, reason: 'revoked', message: 'revoked' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'delegation-self-refusal-surface-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('public surface — SC-2: no un-gated registrar escapes', () => {
  it('every registrar reachable from the package index refuses a revoked delegation', async () => {
    const restore = stubRevoked();
    // The walk calls EVERY exported function with (server, opts) — including ones whose real
    // signature is something else entirely (`currentVerdict(ResolvedOptions)`), which then log a
    // cache-write failure. That noise is expected here and says nothing about the assertion.
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const opts = { token: 'tok', principal: 'bitpulse.app', artifactType: 'url' as const, cacheDir: dir };
      const exported = Object.entries(pkg).filter(([, value]) => typeof value === 'function');

      // Sanity: if the index ever stops exporting the entry points, this test would pass
      // vacuously. Pin that at least the two known ones are in the walk.
      const names = exported.map(([name]) => name);
      expect(names).toContain('guardDelegation');
      expect(names).toContain('installProofLayer');

      let registrarsExercised = 0;

      for (const [name, fn] of exported) {
        const server = new FakeServer();
        const toolBeforeCall = server.tool;
        const registerToolBeforeCall = server.registerTool;

        let returned: unknown;
        try {
          returned = (fn as (s: McpServerLike, o: unknown) => unknown)(server, opts);
          // ASYNC factories are judged too. The earlier version awaited the promise only to settle
          // it and then inspected the Promise object itself — `Object.values(promise)` is `[]`, so
          // an `async` export handing back an un-gated registrar walked straight through. A
          // reviewer proved that by injecting one.
          if (returned instanceof Promise) {
            returned = await returned.catch(() => undefined);
          }
        } catch {
          // Not an installer (or refused to install) — it handed nothing back, so nothing can leak.
          continue;
        }

        // Collect function-shaped returns up to TWO levels deep: `{ tool: x }` was already covered,
        // `{ a: { tool: x } }` was not.
        const collect = (value: unknown, depth: number): unknown[] => {
          if (typeof value === 'function') {
            // A FUNCTION'S OWN PROPERTIES are walked too. A gating wrapper carrying the original as
            // `wrapped.raw = originalTool` was invisible while the sibling case already probed that
            // exact hiding place on the SERVER — proved by a reviewer, whose injection left all 79
            // tests green. Attaching metadata to a registrar is ordinary JS, so this is the shape a
            // leak would most plausibly take.
            const own = depth === 0 ? [] : Object.values(value).flatMap((inner) => collect(inner, depth - 1));
            return [value, ...own];
          }
          if (depth === 0 || value === null || typeof value !== 'object') return [];
          return Object.values(value as Record<string, unknown>).flatMap((inner) => collect(inner, depth - 1));
        };
        const candidates = collect(returned, 2);

        // A candidate identical to what we passed IN is only harmless while the server is
        // untouched: handing back `server.tool` before any patch gives the caller what they already
        // hold. Once this package has patched or registered, the ORIGINAL is exactly the dangerous
        // thing to hand out — the caller's `server.tool` gates and this one does not. So the skip
        // requires BOTH conditions, which is what keeps `resolveOptions`' echo suppressed without
        // creating a hiding place.
        const serverUntouched =
          server.tool === toolBeforeCall &&
          server.registerTool === registerToolBeforeCall &&
          Object.keys(server._registeredTools).length === 0;
        const echoes = new Set<unknown>([toolBeforeCall, registerToolBeforeCall]);
        const produced = candidates.filter(
          (candidate) => !(serverUntouched && echoes.has(candidate)),
        );

        for (const registrar of produced) {
          registrarsExercised++;
          const probeName = `probe_tool_${registrarsExercised}`;
          try {
            (registrar as (...a: unknown[]) => unknown)(probeName, 'desc', async () => ({
              content: [{ type: 'text', text: 'HANDLER RAN — the gate was bypassed' }],
              isError: false,
            }));
          } catch {
            registrarsExercised--;
            continue;
          }

          const handler = server.handlers[probeName];
          if (typeof handler !== 'function') {
            registrarsExercised--;
            continue;
          }

          const result = (await handler()) as { isError: boolean; content: Array<{ text: string }> };
          expect(result.isError, `export "${name}" exposed a registrar that does NOT gate`).toBe(true);
          expect(result.content[0].text).not.toContain('HANDLER RAN');
        }
      }

      expect(registrarsExercised).toBeGreaterThanOrEqual(2);
    } finally {
      console.error = originalConsoleError;
      restore();
    }
  });

  it('installProofLayer does not stash the un-gated registrar anywhere reachable on the server', async () => {
    const restore = stubRevoked();
    try {
      const server = new FakeServer();
      pkg.installProofLayer(server, { token: 'tok', principal: 'bitpulse.app', artifactType: 'url', cacheDir: dir });

      // EVERY own key, string and symbol — not two hard-coded names. STATED BOUND: own keys only,
      // so a stash placed on the PROTOTYPE (where a real McpServer keeps its methods) is outside
      // this probe. Nothing does that today; recorded so the gap is a known one rather than an
      // assumed absence. The title of this case says
      // "anywhere reachable on the server", and probing only `tool`/`registerTool` would leave
      // `server.__proofOriginalTool = originalTool` green while the claim stayed written.
      const keys = Reflect.ownKeys(server).filter((key) => {
        const value = (server as unknown as Record<string | symbol, unknown>)[key];
        // `handlers` / `_registeredTools` are the fake's own bookkeeping, not the server surface.
        return typeof value === 'function' && key !== 'constructor';
      });

      // Anti-vacuity: the two patched entry points must be among what we exercise.
      expect(keys).toContain('tool');
      expect(keys).toContain('registerTool');

      let probes = 0;
      for (const key of keys) {
        const candidate = (server as unknown as Record<string | symbol, unknown>)[key];
        const probeName = `probe_${String(key)}`;
        try {
          (candidate as (...a: unknown[]) => unknown)(probeName, 'desc', async () => ({
            content: [{ type: 'text', text: 'HANDLER RAN' }],
            isError: false,
          }));
        } catch {
          // Not a registrar — a function on the server that takes something else entirely.
          continue;
        }
        const handler = server.handlers[probeName];
        if (typeof handler !== 'function') continue;

        probes++;
        const result = (await handler()) as { isError: boolean };
        expect(result.isError, `server.${String(key)} does NOT gate after installProofLayer`).toBe(true);
      }

      expect(probes).toBeGreaterThanOrEqual(2);
    } finally {
      restore();
    }
  });
});
