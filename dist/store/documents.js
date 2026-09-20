/**
 * Document storage: large sources, chunked once at ingest and then paged.
 *
 * The full text is kept alongside the chunks. Chunks carry character offsets
 * into it, so an exact range can always be re-read verbatim even after the
 * summaries drift — the summary is a convenience, the source is the truth.
 */
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { appendRecord, appendRecords, assertSafeId, ensureDir, listDirs, newId, readJson, readRecords, removeDir, withLock, writeJson, } from './jsonl.js';
import { NotFoundError } from '../util/errors.js';
export class DocumentStore {
    root;
    cache = new Map();
    constructor(dataDir) {
        this.root = path.join(dataDir, 'documents');
    }
    dirFor(id) {
        return path.join(this.root, id);
    }
    async create(input) {
        const id = input.id ?? newId('doc');
        assertSafeId(id, 'document id');
        return withLock(`doc:${id}`, () => this.createLocked(id, input));
    }
    async createLocked(id, input) {
        const dir = this.dirFor(id);
        await ensureDir(dir);
        // Replacing an existing document must not merge into its old chunk log.
        await fs.rm(path.join(dir, 'chunks.jsonl'), { force: true });
        await fs.writeFile(path.join(dir, 'source.txt'), input.text, 'utf8');
        await appendRecords(path.join(dir, 'chunks.jsonl'), input.chunks.map((c) => ({ kind: 'chunk', ...c })));
        const meta = {
            id,
            title: input.title,
            source: input.source,
            createdAt: Date.now(),
            chars: input.text.length,
            chunkCount: input.chunks.length,
            totalTokens: input.chunks.reduce((sum, c) => sum + c.tokens, 0),
            cursor: 0,
        };
        await writeJson(path.join(dir, 'meta.json'), meta);
        const loaded = { meta, chunks: input.chunks.map((c) => ({ ...c })) };
        this.cache.set(id, loaded);
        return loaded;
    }
    async load(id) {
        assertSafeId(id, 'document id');
        const cached = this.cache.get(id);
        if (cached)
            return cached;
        // Shares the key with create(), so a load issued while an ingest of the
        // same id is still in flight waits for it rather than reporting "no such
        // document" against a half-written directory.
        return withLock(`doc:${id}`, () => this.loadLocked(id));
    }
    async loadLocked(id) {
        const cached = this.cache.get(id);
        if (cached)
            return cached;
        const dir = this.dirFor(id);
        const meta = await readJson(path.join(dir, 'meta.json'));
        if (!meta)
            throw new NotFoundError(`no document ${id} — call doc_list to see what exists`);
        const { records } = await readRecords(path.join(dir, 'chunks.jsonl'));
        const chunks = [];
        for (const record of records) {
            if (record.kind === 'chunk') {
                const { kind, ...chunk } = record;
                void kind;
                chunks[chunk.index] = chunk;
            }
            else {
                const target = chunks[record.index];
                if (target)
                    target.summary = record.summary;
            }
        }
        const loaded = { meta, chunks: chunks.filter(Boolean) };
        this.cache.set(id, loaded);
        return loaded;
    }
    /** Re-read an exact character range from the original source. */
    async readRange(id, startChar, endChar) {
        const text = await fs.readFile(path.join(this.dirFor(id), 'source.txt'), 'utf8');
        return text.slice(Math.max(0, startChar), Math.max(0, endChar));
    }
    async setChunkSummary(id, index, summary) {
        const doc = await this.load(id);
        const chunk = doc.chunks[index];
        if (!chunk)
            throw new NotFoundError(`document ${id} has no chunk ${index}`);
        chunk.summary = summary;
        await appendRecord(path.join(this.dirFor(id), 'chunks.jsonl'), {
            kind: 'summary',
            index,
            summary,
        });
    }
    async updateMeta(id, changes) {
        const doc = await this.load(id);
        Object.assign(doc.meta, changes);
        await writeJson(path.join(this.dirFor(id), 'meta.json'), doc.meta);
        return doc.meta;
    }
    async list() {
        const ids = await listDirs(this.root);
        const metas = [];
        for (const id of ids) {
            const meta = await readJson(path.join(this.dirFor(id), 'meta.json'));
            if (meta)
                metas.push(meta);
        }
        return metas.sort((a, b) => b.createdAt - a.createdAt);
    }
    async delete(id) {
        assertSafeId(id, 'document id');
        this.cache.delete(id);
        await removeDir(this.dirFor(id));
    }
}
//# sourceMappingURL=documents.js.map