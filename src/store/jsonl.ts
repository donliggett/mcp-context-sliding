/**
 * Append-only JSONL persistence.
 *
 * Every mutation is a new line rather than a rewrite of the file. That buys
 * three things worth more than the disk space: a crash mid-write can corrupt at
 * most the final line (which is skipped on load, not fatal), the history of how
 * the context evolved stays inspectable with `tail`, and appends never race
 * with a concurrent read the way a read-modify-write cycle does.
 *
 * State is reconstructed by replaying the log — the last record wins.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { errnoCode, InvalidError } from '../util/errors.js';

/**
 * Serialize async work per key.
 *
 * MCP hosts issue tool calls concurrently — several appends and a metadata
 * write can all be in flight against the same session at once. Without this,
 * two writers race and the loser fails outright. Operations on different
 * sessions still run in parallel; only same-key work queues.
 */
const chains = new Map<string, Promise<unknown>>();

export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  // `then(fn, fn)` so a failed predecessor does not block its successors —
  // one bad write must not wedge the queue for that key forever.
  const result = previous.then(fn, fn);

  const tail = result.then(
    () => {},
    () => {},
  );
  chains.set(key, tail);
  void tail.then(() => {
    // Only the current tail may clear the entry, or a later waiter is dropped.
    if (chains.get(key) === tail) chains.delete(key);
  });

  return result;
}

/** Ids appear in file paths, so they are restricted to a safe alphabet. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertSafeId(id: string, label: string): void {
  if (!SAFE_ID.test(id)) {
    throw new InvalidError(
      `${label} must be 1-64 characters of letters, digits, dot, dash or underscore (got ${JSON.stringify(id)})`,
    );
  }
  if (id === '.' || id === '..') {
    throw new InvalidError(`${label} is reserved`);
  }
}

/** Generate a short, sortable, collision-resistant id. */
export function newId(prefix: string): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}${stamp}${rand}`;
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** Append one record as a single line. */
export async function appendRecord(file: string, record: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  await fs.appendFile(file, JSON.stringify(record) + '\n', 'utf8');
}

/** Append several records in one write, so a batch cannot tear mid-way. */
export async function appendRecords(file: string, records: unknown[]): Promise<void> {
  if (records.length === 0) return;
  await ensureDir(path.dirname(file));
  await fs.appendFile(file, records.map((r) => JSON.stringify(r) + '\n').join(''), 'utf8');
}

/**
 * Read every well-formed record from a log.
 *
 * A malformed final line is dropped silently: that is the signature of a
 * process killed mid-append, and refusing to load an entire session because
 * of one torn trailing line would be the wrong trade. Malformed lines
 * elsewhere are also skipped, but counted, so callers can warn.
 */
export async function readRecords<T>(file: string): Promise<{ records: T[]; skipped: number }> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { records: [], skipped: 0 };
    throw err;
  }

  const records: T[] = [];
  let skipped = 0;

  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      skipped++;
    }
  }

  return { records, skipped };
}

let tempCounter = 0;

/**
 * Write a small JSON document atomically (temp file, fsync, rename).
 *
 * Serialized per destination, because two concurrent writes to the same path
 * would otherwise race on the temp file. The temp name is also made unique per
 * call — the PID alone is not enough when one process writes twice at once, and
 * a leftover temp from a crashed run would make every later write fail `wx`.
 */
export async function writeJson(file: string, value: unknown): Promise<void> {
  return withLock(`writeJson:${file}`, async () => {
    await ensureDir(path.dirname(file));
    const temp = `${file}.${process.pid}.${tempCounter++}.${Math.random().toString(36).slice(2, 8)}.tmp`;

    const handle = await fs.open(temp, 'wx');
    try {
      await handle.writeFile(JSON.stringify(value, null, 2), 'utf8');
      await handle.sync();
    } catch (err) {
      await handle.close().catch(() => {});
      await fs.unlink(temp).catch(() => {});
      throw err;
    }
    await handle.close();

    try {
      await fs.rename(temp, file);
    } catch (err) {
      await fs.unlink(temp).catch(() => {});
      throw err;
    }
  });
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return null;
    return null;
  }
}

export async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return [];
    throw err;
  }
}

export async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}
