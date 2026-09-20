/**
 * Session storage: the working-memory ledger a model writes notes into.
 *
 * A session is a flat, ordered list of entries. Compaction replaces a run of
 * old entries with one summary entry — the originals are marked superseded but
 * are never physically removed, so a compaction that turns out to have dropped
 * something important can still be recovered from the log.
 */
import * as path from 'node:path';
import { appendRecord, appendRecords, assertSafeId, listDirs, newId, readJson, readRecords, removeDir, withLock, writeJson, } from './jsonl.js';
import { NotFoundError } from '../util/errors.js';
export const ENTRY_ROLES = [
    'note',
    'user',
    'assistant',
    'system',
    'decision',
    'summary',
];
export class Session {
    meta;
    file;
    entriesById = new Map();
    nextSeq = 1;
    constructor(meta, file, entries) {
        this.meta = meta;
        this.file = file;
        for (const entry of entries) {
            this.entriesById.set(entry.id, entry);
            this.nextSeq = Math.max(this.nextSeq, entry.seq + 1);
        }
    }
    /** Entries visible to recall: not deleted, not folded into a summary. */
    get live() {
        return [...this.entriesById.values()]
            .filter((e) => !e.deleted && !e.superseded)
            .sort((a, b) => a.seq - b.seq);
    }
    /** Everything still on the books, including superseded originals. */
    get all() {
        return [...this.entriesById.values()].filter((e) => !e.deleted).sort((a, b) => a.seq - b.seq);
    }
    get(id) {
        const entry = this.entriesById.get(id);
        return entry && !entry.deleted ? entry : undefined;
    }
    get liveTokens() {
        return this.live.reduce((sum, e) => sum + e.tokens, 0);
    }
    async append(input, counter) {
        const entry = {
            id: newId('e'),
            seq: this.nextSeq++,
            createdAt: Date.now(),
            role: input.role,
            text: input.text,
            tokens: counter.estimate(input.text),
            tags: input.tags ?? [],
            pinned: input.pinned ?? false,
            deleted: false,
            superseded: false,
        };
        this.entriesById.set(entry.id, entry);
        await appendRecord(this.file, { kind: 'entry', ...entry });
        this.meta.updatedAt = entry.createdAt;
        return entry;
    }
    async patch(id, changes) {
        const entry = this.entriesById.get(id);
        if (!entry)
            throw new NotFoundError(`no entry ${id} in session ${this.meta.id}`);
        if (changes.pinned !== undefined)
            entry.pinned = changes.pinned;
        if (changes.deleted !== undefined)
            entry.deleted = changes.deleted;
        if (changes.superseded !== undefined)
            entry.superseded = changes.superseded;
        await appendRecord(this.file, { kind: 'patch', id, ...changes });
        this.meta.updatedAt = Date.now();
        return entry;
    }
    /**
     * Fold a set of entries into one summary entry.
     *
     * The summary is written and the originals marked superseded in a single
     * batched append, so a crash cannot leave the store in a state where the
     * originals are hidden but the summary that replaced them does not exist.
     */
    async compact(replacedIds, summaryText, counter, tags = []) {
        const summary = {
            id: newId('s'),
            seq: this.nextSeq++,
            createdAt: Date.now(),
            role: 'summary',
            text: summaryText,
            tokens: counter.estimate(summaryText),
            tags: ['compaction', ...tags],
            pinned: false,
            deleted: false,
            superseded: false,
            replaces: replacedIds,
        };
        const records = [{ kind: 'entry', ...summary }];
        for (const id of replacedIds) {
            records.push({ kind: 'patch', id, superseded: true });
        }
        await appendRecords(this.file, records);
        this.entriesById.set(summary.id, summary);
        for (const id of replacedIds) {
            const entry = this.entriesById.get(id);
            if (entry)
                entry.superseded = true;
        }
        this.meta.updatedAt = summary.createdAt;
        return summary;
    }
}
export class SessionStore {
    root;
    cache = new Map();
    constructor(dataDir) {
        this.root = path.join(dataDir, 'sessions');
    }
    dirFor(id) {
        return path.join(this.root, id);
    }
    /**
     * Open or resume a session.
     *
     * Serialized per id: concurrent tool calls naming the same new session would
     * otherwise each replay the log and build a separate Session object, and
     * whichever lost the race would silently write into an orphaned instance.
     */
    async open(id, title) {
        const sessionId = id ?? newId('sess');
        assertSafeId(sessionId, 'session id');
        return withLock(`session:${sessionId}`, () => this.openLocked(sessionId, title));
    }
    async openLocked(sessionId, title) {
        const cached = this.cache.get(sessionId);
        if (cached) {
            if (title && title !== cached.meta.title) {
                cached.meta.title = title;
                await writeJson(path.join(this.dirFor(sessionId), 'meta.json'), cached.meta);
            }
            return cached;
        }
        const dir = this.dirFor(sessionId);
        const metaFile = path.join(dir, 'meta.json');
        const logFile = path.join(dir, 'entries.jsonl');
        const existing = await readJson(metaFile);
        const meta = existing ?? {
            id: sessionId,
            title: title ?? sessionId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        if (title)
            meta.title = title;
        const { records } = await readRecords(logFile);
        const byId = new Map();
        for (const record of records) {
            if (record.kind === 'entry') {
                const { kind, ...entry } = record;
                void kind;
                byId.set(entry.id, entry);
            }
            else {
                const target = byId.get(record.id);
                if (!target)
                    continue;
                if (record.pinned !== undefined)
                    target.pinned = record.pinned;
                if (record.deleted !== undefined)
                    target.deleted = record.deleted;
                if (record.superseded !== undefined)
                    target.superseded = record.superseded;
            }
        }
        await writeJson(metaFile, meta);
        const session = new Session(meta, logFile, [...byId.values()]);
        this.cache.set(sessionId, session);
        return session;
    }
    async list() {
        const ids = await listDirs(this.root);
        const metas = [];
        for (const id of ids) {
            const meta = await readJson(path.join(this.dirFor(id), 'meta.json'));
            if (meta)
                metas.push(meta);
        }
        return metas.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    async delete(id) {
        assertSafeId(id, 'session id');
        this.cache.delete(id);
        await removeDir(this.dirFor(id));
    }
    /** Persist meta for a session held in cache. */
    async saveMeta(session) {
        await writeJson(path.join(this.dirFor(session.meta.id), 'meta.json'), session.meta);
    }
}
//# sourceMappingURL=sessions.js.map