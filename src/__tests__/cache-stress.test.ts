import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Two processes write one verdict record the way a gate and a status tool do — a decided verdict,
 * then a mix of decided writes and unresolved read-apply-write updates — while a third reads it.
 * Last writer wins (contract § 13); what must never happen is a torn record or a decided verdict
 * read back as none once both writers have decided one.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));
const MODULES = ['cache', 'constants', 'core'];
const TOKEN = 'stress.token.sig';
const ITERATIONS = 300;

let work: string;
let lib: string;

const WRITER = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDiskStore } from './cache.js';
import { applyPoll } from './core.js';
const [dir, role, iterations] = process.argv.slice(2);
const store = createDiskStore({ dir, warn: () => {} });
const decided = role === 'gate' ? { kind: 'valid' } : { kind: 'refused', code: 'revoked' };
for (let i = 0; i < Number(iterations); i += 1) {
  const result = i % 3 === 0 ? decided : { kind: 'unresolved', reason: 'timeout' };
  store.writeRecords(${JSON.stringify(TOKEN)}, applyPoll(store.readRecords(${JSON.stringify(TOKEN)}), result, Date.now() + i));
  if (i === 0) writeFileSync(join(dir, 'ready-' + role), '');
}
writeFileSync(join(dir, 'done-' + role), '');
`;

const READER = `
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRecordsFile, verdictCacheKey } from './cache.js';
const [dir] = process.argv.slice(2);
const file = join(dir, verdictCacheKey(${JSON.stringify(TOKEN)}) + '.json');
let reads = 0, torn = 0, lost = 0;
const done = () => existsSync(join(dir, 'done-gate')) && existsSync(join(dir, 'done-status'));
const bothDecided = () => existsSync(join(dir, 'ready-gate')) && existsSync(join(dir, 'ready-status'));
const deadline = Date.now() + 55_000;
while (!done() && Date.now() < deadline) {
  const decidedBefore = bothDecided();
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  reads += 1;
  const records = parseRecordsFile(text);
  if (records === null) torn += 1;
  else if (decidedBefore && records.gate === null) lost += 1;
}
process.stdout.write(JSON.stringify({ reads, torn, lost }));
`;

function run(script: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(lib, script), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${script} exited ${code}: ${err}`))));
  });
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'self-refusal-stress-'));
  lib = join(work, 'lib');
  mkdirSync(lib);
  writeFileSync(join(lib, 'package.json'), '{"type":"module"}');
  for (const name of MODULES) {
    const source = readFileSync(join(SRC, `${name}.ts`), 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    writeFileSync(join(lib, `${name}.js`), outputText);
  }
  writeFileSync(join(lib, 'writer.mjs'), WRITER);
  writeFileSync(join(lib, 'reader.mjs'), READER);
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('two processes writing one record', () => {
  it('never shows a torn record, and never loses a decided verdict once both have decided one', async () => {
    const dir = join(work, 'cache');
    mkdirSync(dir);
    const reader = run('reader.mjs', [dir]);
    await Promise.all([
      run('writer.mjs', [dir, 'gate', String(ITERATIONS)]),
      run('writer.mjs', [dir, 'status', String(ITERATIONS)]),
    ]);
    const { reads, torn, lost } = JSON.parse(await reader) as { reads: number; torn: number; lost: number };

    expect(reads).toBeGreaterThan(0);
    expect({ torn, lost }).toEqual({ torn: 0, lost: 0 });
    const final = JSON.parse(readFileSync(join(dir, (await import('../cache.js')).verdictCacheKey(TOKEN) + '.json'), 'utf8'));
    expect(final.record_version).toBe(2);
    expect(final.gate).not.toBeNull();
  }, 60_000);
});
