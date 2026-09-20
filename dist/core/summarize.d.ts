/**
 * Summarization, with a local LLM when one is reachable and a purely
 * algorithmic fallback when it is not.
 *
 * The fallback is not a token gesture. A summarizer that throws when LM Studio
 * happens to have no model loaded would take the whole context store down with
 * it, and losing access to stored context is a worse failure than getting a
 * cruder summary of it. Extractive output is always available, always instant,
 * and never hallucinates — it can only pick sentences that were really there.
 */
import type { LlmClient } from './llm.js';
import type { TokenCounter } from './tokens.js';
export type SummaryMethod = 'llm' | 'extractive';
export interface SummaryResult {
    text: string;
    method: SummaryMethod;
    /** Set when the LLM was tried and failed, so callers can surface why. */
    fallbackReason?: string;
    /** How many map-reduce passes ran. 1 means the text fitted in one call. */
    passes: number;
}
export interface SummarizeOptions {
    /** Rough size of the summary to aim for. */
    targetTokens: number;
    /** What the summary is for; steers the prompt. */
    instruction?: string;
}
export declare class Summarizer {
    private readonly llm;
    private readonly counter;
    constructor(llm: LlmClient, counter: TokenCounter);
    summarize(text: string, options: SummarizeOptions): Promise<SummaryResult>;
    private llmSummarize;
    private callModel;
    /**
     * Extractive summarization by TF-ISF sentence scoring.
     *
     * Each sentence scores as the summed rarity of the words it contains, so a
     * sentence full of terms that recur across the text but not in every single
     * sentence — the topical words — outranks both boilerplate and one-off
     * asides. Length-normalized, or long sentences would win automatically.
     * Selected sentences are re-emitted in their original order so the result
     * still reads as a narrative.
     */
    private extractive;
}
/**
 * Split into sentences without a full NLP model.
 *
 * The lookbehind guards against the common abbreviations that would otherwise
 * fragment every summary ("e.g.", "Dr.", "vs.") and against decimal points.
 */
export declare function splitSentences(text: string): string[];
