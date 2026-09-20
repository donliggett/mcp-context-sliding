/**
 * Structure-aware chunking.
 *
 * Naive fixed-size chunking cuts through the middle of sentences, code blocks
 * and tables, and the resulting fragments summarize and retrieve badly. This
 * splits on the document's own structure first — headings, paragraphs, fenced
 * code — and only falls back to a hard character cut for a single block that
 * is genuinely larger than a whole chunk.
 *
 * Each chunk also carries the heading trail it sits under, which is what makes
 * `doc_outline` readable and gives retrieval results somewhere to anchor.
 */
import type { TokenCounter } from './tokens.js';
export interface Chunk {
    index: number;
    text: string;
    tokens: number;
    startChar: number;
    endChar: number;
    /** Heading breadcrumb, e.g. "Install > Windows". Empty for unstructured text. */
    heading: string;
}
export interface ChunkOptions {
    chunkTokens: number;
    overlapTokens: number;
}
export declare function chunkText(text: string, counter: TokenCounter, options: ChunkOptions): Chunk[];
