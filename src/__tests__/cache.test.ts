import * as fs from 'node:fs';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDiskStore,
  defaultCacheDir,
  parseRecordsFile,
  RECORD_VERSION,
  replacementCacheKey,
  verdictCacheKey,
  type FsLike,
} from '../cache.js';
import type { TokenRecords } from '../core.js';

const TOKEN = 'header.payload.signature';
const DECIDED: TokenRecords = { gate: { verdict: { kind: 'valid' }, checked_at: 1_000 }, info: { unresolved_since: null } };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'self-refusal-cache-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('record format v2', () => {
  it('writes the contract record under the verdict key and reads it back', () => {
    const store = createDiskStore({ dir });
    store.writeRecords(TOKEN, DECIDED);
    const file = join(dir, `${verdictCacheKey(TOKEN)}.json`);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ record_version: 2, ...DECIDED });
    expect(store.readRecords(TOKEN)).toEqual(DECIDED);
  });

  it('keys a custom issuer apart from the default one', () => {
    createDiskStore({ dir, baseUrl: 'https://issuer.example' }).writeRecords(TOKEN, DECIDED);
    expect(readdirSync(dir)).toEqual([`${verdictCacheKey(TOKEN, 'https://issuer.example')}.json`]);
    expect(createDiskStore({ dir }).readRecords(TOKEN).gate).toBeNull();
  });

  it('writes the replacement record keyed by the configured token', () => {
    const store = createDiskStore({ dir });
    store.writeReplacement(TOKEN, 'replacement.token.sig');
    const file = join(dir, `${replacementCacheKey(TOKEN)}.json`);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ record_version: 2, token: 'replacement.token.sig' });
    expect(store.readReplacement(TOKEN)).toBe('replacement.token.sig');
  });

  it.each([
    ['not JSON', 'nope'],
    ['another record_version', JSON.stringify({ record_version: 1, ...DECIDED })],
    ['no record_version (a 0.x file)', JSON.stringify({ lastDecided: { kind: 'valid' }, lastCheckedAtMs: 1 })],
    ['an unknown verdict kind', JSON.stringify({ record_version: 2, gate: { verdict: { kind: 'maybe' }, checked_at: 1 }, info: { unresolved_since: null } })],
    ['a non-numeric checked_at', JSON.stringify({ record_version: 2, gate: { verdict: { kind: 'valid' }, checked_at: '1' }, info: { unresolved_since: null } })],
    ['a negative pull count', JSON.stringify({ record_version: 2, gate: { verdict: { kind: 'refused', code: 'key_revoked' }, checked_at: 1, key_rotation: { pulls: -1, next_pull_at: 1 } }, info: { unresolved_since: null } })],
    ['no info record', JSON.stringify({ record_version: 2, gate: null })],
  ])('reads %s as absent', (_label, text) => {
    expect(parseRecordsFile(text)).toBeNull();
    writeFileSync(join(dir, `${verdictCacheKey(TOKEN)}.json`), text);
    expect(createDiskStore({ dir }).readRecords(TOKEN)).toEqual({ gate: null, info: { unresolved_since: null } });
  });

  it('reads a replacement file of another record_version as absent', () => {
    writeFileSync(join(dir, `${replacementCacheKey(TOKEN)}.json`), JSON.stringify({ token: 'x.y.z' }));
    expect(createDiskStore({ dir }).readReplacement(TOKEN)).toBeNull();
    expect(RECORD_VERSION).toBe(2);
  });
});

describe('atomic writes', () => {
  it('leaves no temporary file and writes mode 0600', () => {
    const store = createDiskStore({ dir });
    store.writeRecords(TOKEN, DECIDED);
    store.writeReplacement(TOKEN, 'r.t.s');
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    if (process.platform !== 'win32') {
      for (const name of readdirSync(dir)) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    }
  });

  it('writes through a temporary file and a rename', () => {
    const calls: string[] = [];
    const spy: FsLike = {
      ...fs,
      writeFileSync: ((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        calls.push(`write ${String(path).endsWith('.tmp') ? 'tmp' : 'target'}`);
        return (fs.writeFileSync as (...args: unknown[]) => void)(path, ...rest);
      }) as FsLike['writeFileSync'],
      renameSync: ((from: fs.PathLike, to: fs.PathLike) => {
        calls.push('rename');
        return fs.renameSync(from, to);
      }) as FsLike['renameSync'],
    };
    createDiskStore({ dir, fs: spy }).writeRecords(TOKEN, DECIDED);
    expect(calls).toEqual(['write tmp', 'rename']);
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])('falls back to copy then unlink when the rename is refused with %s', (code) => {
    const refusing: FsLike = {
      ...fs,
      renameSync: (() => {
        throw Object.assign(new Error('refused'), { code });
      }) as FsLike['renameSync'],
    };
    const store = createDiskStore({ dir, fs: refusing, warn: () => expect.fail('no fallback to memory expected') });
    store.writeRecords(TOKEN, DECIDED);
    expect(createDiskStore({ dir }).readRecords(TOKEN)).toEqual(DECIDED);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('an unwritable cache directory', () => {
  it('serves from memory and writes exactly one stderr line, nothing on stdout', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write');
    const log = vi.spyOn(console, 'log');
    const unwritable: FsLike = {
      ...fs,
      mkdirSync: (() => {
        throw Object.assign(new Error('read-only'), { code: 'EROFS' });
      }) as FsLike['mkdirSync'],
    };
    const store = createDiskStore({ dir: join(dir, 'ro'), fs: unwritable });
    store.writeRecords(TOKEN, DECIDED);
    store.writeRecords('other.token.sig', DECIDED);
    store.writeReplacement(TOKEN, 'r.t.s');

    expect(store.readRecords(TOKEN)).toEqual(DECIDED);
    expect(store.readReplacement(TOKEN)).toBe('r.t.s');
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0][0])).toMatch(/not writable \(EROFS\); keeping verdicts in memory\n$/);
    expect(stdout).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('falls back on a real read-only directory', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const readOnly = join(dir, 'locked');
    fs.mkdirSync(readOnly);
    chmodSync(readOnly, 0o500);
    const lines: string[] = [];
    const store = createDiskStore({ dir: readOnly, warn: (line) => lines.push(line) });
    store.writeRecords(TOKEN, DECIDED);
    expect(store.readRecords(TOKEN)).toEqual(DECIDED);
    expect(lines).toHaveLength(1);
    chmodSync(readOnly, 0o700);
  });
});

describe('defaultCacheDir', () => {
  it('uses PROOF_CACHE_DIR when it is set', () => {
    vi.stubEnv('PROOF_CACHE_DIR', '/tmp/proof-cache-test');
    expect(defaultCacheDir()).toBe('/tmp/proof-cache-test');
  });

  it('falls back to the home directory when it is unset or empty', () => {
    vi.stubEnv('PROOF_CACHE_DIR', '');
    expect(defaultCacheDir()).toMatch(/\.proof-holdings[\\/]delegation-self-refusal$/);
  });
});
