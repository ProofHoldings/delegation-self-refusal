import { createHash, randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_BASE_URL } from './constants.js';
import { emptyRecords, type GateRecord, type TokenRecords } from './core.js';

/** On-disk records (`docs/mcp-delegation-gate-contract.md` § 13). */

export const RECORD_VERSION = 2;
export const VERDICT_LABEL = 'mcp-gate/v2';
export const REPLACEMENT_LABEL = 'mcp-gate/v2/replacement';

export type FsLike = Pick<
  typeof nodeFs,
  'mkdirSync' | 'readFileSync' | 'writeFileSync' | 'renameSync' | 'copyFileSync' | 'unlinkSync' | 'rmSync'
>;

export interface RecordStore {
  readRecords(token: string): TokenRecords;
  writeRecords(token: string, records: TokenRecords): void;
  deleteRecords(token: string): void;
  readReplacement(configuredToken: string): string | null;
  writeReplacement(configuredToken: string, token: string): void;
}

export function defaultCacheDir(): string {
  const fromEnv = process.env.PROOF_CACHE_DIR;
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), '.proof-holdings', 'delegation-self-refusal');
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').toLowerCase();
}

function keyed(label: string, token: string, baseUrl?: string): string {
  const base = baseUrl === undefined ? DEFAULT_BASE_URL : normalizeBaseUrl(baseUrl);
  const input = base === DEFAULT_BASE_URL ? `${label}\n${token}` : `${label}\n${token}\n${base}`;
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function verdictCacheKey(token: string, baseUrl?: string): string {
  return keyed(VERDICT_LABEL, token, baseUrl);
}

export function replacementCacheKey(configuredToken: string, baseUrl?: string): string {
  return keyed(REPLACEMENT_LABEL, configuredToken, baseUrl);
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function parseGate(value: unknown): GateRecord | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const verdict = record.verdict as Record<string, unknown> | null | undefined;
  if (!verdict || typeof verdict !== 'object' || !isFiniteNumber(record.checked_at)) return undefined;
  let parsedVerdict: GateRecord['verdict'];
  if (verdict.kind === 'valid') parsedVerdict = { kind: 'valid' };
  else if (verdict.kind === 'refused' && typeof verdict.code === 'string') {
    parsedVerdict = { kind: 'refused', code: verdict.code };
  } else return undefined;
  const gate: GateRecord = { verdict: parsedVerdict, checked_at: record.checked_at };
  if (record.key_rotation !== undefined) {
    const episode = record.key_rotation as Record<string, unknown> | null;
    if (
      !episode ||
      typeof episode !== 'object' ||
      !Number.isInteger(episode.pulls) ||
      (episode.pulls as number) < 0 ||
      !isFiniteNumber(episode.next_pull_at)
    ) {
      return undefined;
    }
    gate.key_rotation = { pulls: episode.pulls as number, next_pull_at: episode.next_pull_at };
  }
  return gate;
}

/** A file that does not parse, or carries another `record_version`, is absent. */
export function parseRecordsFile(text: string): TokenRecords | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const file = parsed as Record<string, unknown>;
  if (file.record_version !== RECORD_VERSION) return null;
  const gate = parseGate(file.gate);
  if (gate === undefined) return null;
  const info = file.info as Record<string, unknown> | null;
  if (!info || typeof info !== 'object') return null;
  const since = info.unresolved_since;
  if (since !== null && !isFiniteNumber(since)) return null;
  return { gate, info: { unresolved_since: since } };
}

export function parseReplacementFile(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown> | null;
    if (!parsed || parsed.record_version !== RECORD_VERSION) return null;
    return typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : null;
  } catch {
    return null;
  }
}

function cloneRecords(records: TokenRecords): TokenRecords {
  return JSON.parse(JSON.stringify(records)) as TokenRecords;
}

export function createMemoryStore(): RecordStore {
  const records = new Map<string, TokenRecords>();
  const replacements = new Map<string, string>();
  return {
    readRecords: (token) => cloneRecords(records.get(token) ?? emptyRecords()),
    writeRecords: (token, value) => void records.set(token, cloneRecords(value)),
    deleteRecords: (token) => void records.delete(token),
    readReplacement: (configured) => replacements.get(configured) ?? null,
    writeReplacement: (configured, token) => void replacements.set(configured, token),
  };
}

const RENAME_FALLBACK_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

export interface DiskStoreOptions {
  dir: string;
  baseUrl?: string;
  fs?: FsLike;
  warn?: (line: string) => void;
}

/**
 * Atomic writes (temporary file then rename, mode 0600, last writer wins); a rename refused the way
 * Windows refuses one over an open target falls back to copy-then-unlink. The first write that fails
 * switches the store to memory and writes one line to stderr.
 */
export function createDiskStore(options: DiskStoreOptions): RecordStore {
  const fs = options.fs ?? nodeFs;
  const warn = options.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const memory = createMemoryStore();
  let inMemory = false;
  const memoryTokens = new Set<string>();
  const memoryReplacements = new Set<string>();

  const pathOf = (key: string) => join(options.dir, `${key}.json`);

  const fallBack = (error: unknown) => {
    if (inMemory) return;
    inMemory = true;
    const reason = (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.name : 'error');
    warn(`delegation-self-refusal: cache directory ${options.dir} is not writable (${reason}); keeping verdicts in memory`);
  };

  const writeAtomic = (key: string, body: string) => {
    fs.mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    const target = pathOf(key);
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      fs.renameSync(temporary, target);
    } catch (error) {
      if (!RENAME_FALLBACK_CODES.has((error as NodeJS.ErrnoException).code ?? '')) {
        fs.rmSync(temporary, { force: true });
        throw error;
      }
      try {
        fs.copyFileSync(temporary, target);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    }
  };

  const readText = (key: string): string | null => {
    try {
      return fs.readFileSync(pathOf(key), 'utf8') as string;
    } catch {
      return null;
    }
  };

  return {
    readRecords(token) {
      if (inMemory && memoryTokens.has(token)) return memory.readRecords(token);
      const text = readText(verdictCacheKey(token, options.baseUrl));
      return (text === null ? null : parseRecordsFile(text)) ?? emptyRecords();
    },
    writeRecords(token, records) {
      if (!inMemory) {
        try {
          writeAtomic(
            verdictCacheKey(token, options.baseUrl),
            JSON.stringify({ record_version: RECORD_VERSION, gate: records.gate, info: records.info }),
          );
          return;
        } catch (error) {
          fallBack(error);
        }
      }
      memoryTokens.add(token);
      memory.writeRecords(token, records);
    },
    deleteRecords(token) {
      if (inMemory) {
        memoryTokens.add(token);
        memory.deleteRecords(token);
      }
      try {
        fs.rmSync(pathOf(verdictCacheKey(token, options.baseUrl)), { force: true });
      } catch {
        return;
      }
    },
    readReplacement(configured) {
      if (inMemory && memoryReplacements.has(configured)) return memory.readReplacement(configured);
      const text = readText(replacementCacheKey(configured, options.baseUrl));
      return text === null ? null : parseReplacementFile(text);
    },
    writeReplacement(configured, token) {
      if (!inMemory) {
        try {
          writeAtomic(
            replacementCacheKey(configured, options.baseUrl),
            JSON.stringify({ record_version: RECORD_VERSION, token }),
          );
          return;
        } catch (error) {
          fallBack(error);
        }
      }
      memoryReplacements.add(configured);
      memory.writeReplacement(configured, token);
    },
  };
}
