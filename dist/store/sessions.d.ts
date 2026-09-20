/**
 * Session storage: the working-memory ledger a model writes notes into.
 *
 * A session is a flat, ordered list of entries. Compaction replaces a run of
 * old entries with one summary entry — the originals are marked superseded but
 * are never physically removed, so a compaction that turns out to have dropped
 * something important can still be recovered from the log.
 */
import type { TokenCounter } from '../core/tokens.js';
export type EntryRole = 'note' | 'user' | 'assistant' | 'system' | 'decision' | 'summary';
export declare const ENTRY_ROLES: EntryRole[];
export interface Entry {
    id: string;
    seq: number;
    createdAt: number;
    role: EntryRole;
    text: string;
    tokens: number;
    tags: string[];
    pinned: boolean;
    /** Explicitly deleted by the model or user. */
    deleted: boolean;
    /** Replaced by a compaction summary; hidden from recall but kept on disk. */
    superseded: boolean;
    /** For summary entries: the entry ids folded into this one. */
    replaces?: string[];
}
export interface SessionMeta {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
}
export declare class Session {
    readonly meta: SessionMeta;
    private readonly file;
    private readonly entriesById;
    private nextSeq;
    constructor(meta: SessionMeta, file: string, entries: Entry[]);
    /** Entries visible to recall: not deleted, not folded into a summary. */
    get live(): Entry[];
    /** Everything still on the books, including superseded originals. */
    get all(): Entry[];
    get(id: string): Entry | undefined;
    get liveTokens(): number;
    append(input: {
        role: EntryRole;
        text: string;
        tags?: string[];
        pinned?: boolean;
    }, counter: TokenCounter): Promise<Entry>;
    patch(id: string, changes: {
        pinned?: boolean;
        deleted?: boolean;
        superseded?: boolean;
    }): Promise<Entry>;
    /**
     * Fold a set of entries into one summary entry.
     *
     * The summary is written and the originals marked superseded in a single
     * batched append, so a crash cannot leave the store in a state where the
     * originals are hidden but the summary that replaced them does not exist.
     */
    compact(replacedIds: string[], summaryText: string, counter: TokenCounter, tags?: string[]): Promise<Entry>;
}
export declare class SessionStore {
    private readonly root;
    private readonly cache;
    constructor(dataDir: string);
    private dirFor;
    /**
     * Open or resume a session.
     *
     * Serialized per id: concurrent tool calls naming the same new session would
     * otherwise each replay the log and build a separate Session object, and
     * whichever lost the race would silently write into an orphaned instance.
     */
    open(id: string | undefined, title: string | undefined): Promise<Session>;
    private openLocked;
    list(): Promise<SessionMeta[]>;
    delete(id: string): Promise<void>;
    /** Persist meta for a session held in cache. */
    saveMeta(session: Session): Promise<void>;
}
