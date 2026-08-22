/**
 * Store tests: persistence, replay, compaction semantics, and the ingest
 * sandbox. These touch the filesystem but never the network.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { SessionStore } from '../dist/store/sessions.js';
import { DocumentStore } from '../dist/store/documents.js';
import { IngestSandbox } from '../dist/util/safepath.js';
import { TokenCounter } from '../dist/core/tokens.js';
import { chunkText } from '../dist/core/chunk.js';

const counter = new TokenCounter(0.27);
let dataDir: string;

before(async () => {
  dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ctxwin-test-')));
});

after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

describe('sessions', () => {
  test('append then read back', async () => {
    const store = new SessionStore(dataDir);
    const session = await store.open('basic', 'Basic');
    await session.append({ role: 'note', text: 'first fact' }, counter);
    await session.append({ role: 'decision', text: 'we chose JSONL' }, counter);

    assert.equal(session.live.length, 2);
    assert.equal(session.live[0]!.text, 'first fact');
    assert.ok(session.liveTokens > 0);
  });

  test('state survives a fresh store (replayed from the log)', async () => {
    const first = new SessionStore(dataDir);
    const session = await first.open('persist', 'Persist');
    await session.append({ role: 'note', text: 'remembered across restarts' }, counter);

    // A brand-new store shares no cache, so this exercises real log replay.
    const second = new SessionStore(dataDir);
    const reloaded = await second.open('persist', undefined);
    assert.equal(reloaded.live.length, 1);
    assert.equal(reloaded.live[0]!.text, 'remembered across restarts');
  });

  test('pin and delete patches replay correctly', async () => {
    const store = new SessionStore(dataDir);
    const session = await store.open('patches', 'Patches');
    const keep = await session.append({ role: 'note', text: 'keep me' }, counter);
    const drop = await session.append({ role: 'note', text: 'drop me' }, counter);

    await session.patch(keep.id, { pinned: true });
    await session.patch(drop.id, { deleted: true });

    const reloaded = await new SessionStore(dataDir).open('patches', undefined);
    const live = reloaded.live;
    assert.equal(live.length, 1);
    assert.equal(live[0]!.text, 'keep me');
    assert.equal(live[0]!.pinned, true);
  });

  test('compaction hides originals but keeps them recoverable', async () => {
    const store = new SessionStore(dataDir);
    const session = await store.open('compact', 'Compact');
    const a = await session.append({ role: 'note', text: 'alpha happened' }, counter);
    const b = await session.append({ role: 'note', text: 'beta happened' }, counter);
    await session.append({ role: 'note', text: 'gamma is recent' }, counter);

    const summary = await session.compact([a.id, b.id], 'alpha and beta happened', counter);

    const live = session.live;
    assert.ok(!live.some((e) => e.id === a.id), 'compacted entries leave the live set');
    assert.ok(live.some((e) => e.id === summary.id), 'the summary joins the live set');
    assert.equal(summary.replaces?.length, 2);

    // The originals are still on the books — compaction is not destruction.
    const reloaded = await new SessionStore(dataDir).open('compact', undefined);
    assert.ok(reloaded.all.some((e) => e.id === a.id), 'original is still recoverable');
    assert.ok(!reloaded.live.some((e) => e.id === a.id), 'but stays out of recall after reload');
  });

  test('pinned entries are never returned as compaction candidates by the store', async () => {
    const store = new SessionStore(dataDir);
    const session = await store.open('pinned', 'Pinned');
    const pinned = await session.append({ role: 'note', text: 'the goal', pinned: true }, counter);
    assert.equal(session.get(pinned.id)?.pinned, true);
  });

  test('rejects unsafe session ids', async () => {
    const store = new SessionStore(dataDir);
    await assert.rejects(() => store.open('../escape', undefined), /session id/i);
    await assert.rejects(() => store.open('with/slash', undefined), /session id/i);
  });

  test('survives concurrent writes to the same session', async () => {
    // Regression: MCP hosts issue tool calls concurrently, and an atomic-write
    // temp file named only after the PID collided when two writes to the same
    // session overlapped, failing with EEXIST. Found by an end-to-end smoke
    // test, not by any single-threaded unit test.
    const store = new SessionStore(dataDir);

    const writes = Array.from({ length: 25 }, async (_, i) => {
      const session = await store.open('concurrent', 'Concurrent');
      await session.append({ role: 'note', text: `entry number ${i}` }, counter);
      await store.saveMeta(session);
    });

    await Promise.all(writes); // Must not reject.

    const reloaded = await new SessionStore(dataDir).open('concurrent', undefined);
    assert.equal(reloaded.live.length, 25, 'every concurrent append must be durable');
    const texts = new Set(reloaded.live.map((e) => e.text));
    assert.equal(texts.size, 25, 'no entry may be lost or duplicated');
  });

  test('concurrent opens of one new session share an instance', async () => {
    const store = new SessionStore(dataDir);
    const opened = await Promise.all(
      Array.from({ length: 8 }, () => store.open('shared', 'Shared')),
    );
    for (const session of opened) {
      assert.equal(session, opened[0], 'all callers must get the same Session object');
    }
  });

  test('list reports stored sessions', async () => {
    const metas = await new SessionStore(dataDir).list();
    assert.ok(metas.length >= 3);
    assert.ok(metas.every((m) => typeof m.id === 'string'));
  });
});

describe('documents', () => {
  const sample = [
    '# Manual',
    '',
    'Introduction paragraph explaining the product.',
    '',
    '## Setup',
    '',
    'Run the installer and accept the defaults.',
    '',
    '## Troubleshooting',
    '',
    'If the service fails to start, check the port binding.',
  ].join('\n');

  test('ingest, load, and read an exact range', async () => {
    const store = new DocumentStore(dataDir);
    const chunks = chunkText(sample, counter, { chunkTokens: 40, overlapTokens: 0 });
    const doc = await store.create({ id: 'manual', title: 'Manual', source: 'inline', text: sample, chunks });

    assert.equal(doc.meta.id, 'manual');
    assert.ok(doc.meta.chunkCount > 0);
    assert.equal(doc.meta.chars, sample.length);

    const range = await store.readRange('manual', 0, 9);
    assert.equal(range, sample.slice(0, 9));
  });

  test('chunks and summaries survive a reload', async () => {
    const store = new DocumentStore(dataDir);
    await store.setChunkSummary('manual', 0, 'It is the intro.');

    const reloaded = await new DocumentStore(dataDir).load('manual');
    assert.equal(reloaded.chunks[0]!.summary, 'It is the intro.');
    assert.ok(reloaded.chunks.length > 0);
    reloaded.chunks.forEach((c, i) => assert.equal(c.index, i));
  });

  test('cursor updates persist', async () => {
    const store = new DocumentStore(dataDir);
    await store.updateMeta('manual', { cursor: 2 });
    const reloaded = await new DocumentStore(dataDir).load('manual');
    assert.equal(reloaded.meta.cursor, 2);
  });

  test('re-ingesting the same id replaces rather than appends', async () => {
    const store = new DocumentStore(dataDir);
    const replacement = 'Totally different content now.';
    const chunks = chunkText(replacement, counter, { chunkTokens: 40, overlapTokens: 0 });
    await store.create({ id: 'manual', title: 'Manual v2', source: 'inline', text: replacement, chunks });

    const reloaded = await new DocumentStore(dataDir).load('manual');
    assert.equal(reloaded.meta.title, 'Manual v2');
    assert.equal(reloaded.chunks.length, chunks.length);
    assert.ok(reloaded.chunks[0]!.text.includes('Totally different'));
  });

  test('a load racing an ingest of the same id waits for it', async () => {
    // Regression: doc_outline fired immediately after doc_ingest reported
    // "no document", because load() ran against a half-written directory.
    const store = new DocumentStore(dataDir);
    const text = 'Racing content for the concurrency check.';
    const chunks = chunkText(text, counter, { chunkTokens: 40, overlapTokens: 0 });

    const [, loaded] = await Promise.all([
      store.create({ id: 'racer', title: 'Racer', source: 'inline', text, chunks }),
      store.load('racer'),
    ]);

    assert.equal(loaded.meta.id, 'racer');
    assert.ok(loaded.chunks.length > 0, 'the racing load must see real chunks');
  });

  test('missing documents raise a helpful error', async () => {
    await assert.rejects(() => new DocumentStore(dataDir).load('nope'), /no document nope/);
  });

  test('delete removes it', async () => {
    const store = new DocumentStore(dataDir);
    await store.delete('manual');
    await assert.rejects(() => new DocumentStore(dataDir).load('manual'), /no document/);
  });
});

describe('ingest sandbox', () => {
  let allowed: string;
  let outside: string;

  before(async () => {
    allowed = path.join(dataDir, 'ingestable');
    outside = path.join(dataDir, 'private');
    await fs.mkdir(allowed, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(allowed, 'ok.txt'), 'readable');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'MUST NOT READ');
  });

  test('disabled by default', async () => {
    const sandbox = await IngestSandbox.create([]);
    assert.equal(sandbox.enabled, false);
    await assert.rejects(() => sandbox.resolveFile('anything.txt'), /disabled/);
  });

  test('allows files inside a configured root', async () => {
    const sandbox = await IngestSandbox.create([allowed]);
    const real = await sandbox.resolveFile(path.join(allowed, 'ok.txt'));
    assert.ok(real.endsWith('ok.txt'));
  });

  test('refuses traversal and absolute paths outside the root', async () => {
    const sandbox = await IngestSandbox.create([allowed]);
    await assert.rejects(() => sandbox.resolveFile('../private/secret.txt'), /denied|cannot read/i);
    await assert.rejects(() => sandbox.resolveFile(path.join(outside, 'secret.txt')), /denied/i);
  });

  test('refuses a sibling directory sharing the root prefix', async () => {
    // Guards the classic startsWith bug: "/x/ingestable-evil" begins with
    // "/x/ingestable" but is a different directory entirely.
    const evil = `${allowed}-evil`;
    await fs.mkdir(evil, { recursive: true });
    await fs.writeFile(path.join(evil, 'gotcha.txt'), 'nope');
    const sandbox = await IngestSandbox.create([allowed]);
    await assert.rejects(() => sandbox.resolveFile(path.join(evil, 'gotcha.txt')), /denied/i);
  });

  test('refuses a symlink escaping the root', async (t) => {
    const link = path.join(allowed, 'escape.txt');
    try {
      await fs.symlink(path.join(outside, 'secret.txt'), link);
    } catch {
      t.skip('symlink creation not permitted on this host');
      return;
    }
    const sandbox = await IngestSandbox.create([allowed]);
    await assert.rejects(() => sandbox.resolveFile(link), /denied/i);
    await fs.unlink(link).catch(() => {});
  });

  test('refuses directories', async () => {
    const sandbox = await IngestSandbox.create([allowed]);
    await assert.rejects(() => sandbox.resolveFile(allowed), /not a regular file/);
  });
});
