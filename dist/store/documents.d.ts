/**
 * Document storage: large sources, chunked once at ingest and then paged.
 *
 * The full text is kept alongside the chunks. Chunks carry character offsets
 * into it, so an exact range can always be re-read verbatim even after the
 * summaries drift — the summary is a convenience, the source is the truth.
 */
import type { Chunk } from '../core/chunk.js';
export interface DocChunk extends Chunk {
    /** Filled in lazily by doc_outline / doc_summarize. */
    summary?: string;
}
export interface DocMeta {
    id: string;
    title: string;
    /** Where it came from: a file path, a URL, or "inline". */
    source: string;
    createdAt: number;
    chars: number;
    chunkCount: number;
    totalTokens: number;
    /** Whole-document summary, once one has been produced. */
    summary?: string;
    /** Reading cursor for doc_window's "next" mode. */
    cursor: number;
}
export interface LoadedDocument {
    meta: DocMeta;
    chunks: DocChunk[];
}
export declare class DocumentStore {
    private readonly root;
    private readonly cache;
    constructor(dataDir: string);
    private dirFor;
    create(input: {
        id?: string;
        title: string;
        source: string;
        text: string;
        chunks: Chunk[];
    }): Promise<LoadedDocument>;
    private createLocked;
    load(id: string): Promise<LoadedDocument>;
    private loadLocked;
    /** Re-read an exact character range from the original source. */
    readRange(id: string, startChar: number, endChar: number): Promise<string>;
    setChunkSummary(id: string, index: number, summary: string): Promise<void>;
    updateMeta(id: string, changes: Partial<Pick<DocMeta, 'summary' | 'cursor' | 'title'>>): Promise<DocMeta>;
    list(): Promise<DocMeta[]>;
    delete(id: string): Promise<void>;
}
