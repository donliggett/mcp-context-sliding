/**
 * Token counting.
 *
 * Everything this server does — packing a recall result, sizing a chunk,
 * deciding when to compact — is a budget decision, so the count has to be
 * roughly right and must never be *under*. Undercounting overflows the model's
 * window and silently truncates the very context we were hired to protect.
 * Every heuristic here therefore leans high.
 *
 * There is no universal tokenizer: Llama, Qwen, Mistral and GPT all split text
 * differently, and bundling one BPE table would be both large and wrong for
 * whatever model the user actually loaded. Instead we estimate cheaply, then
 * calibrate the estimate against the real model when it is reachable.
 */
import type { LlmClient } from './llm.js';
export interface Calibration {
    /** Tokens per character for non-CJK text. */
    ratio: number;
    /** Model the ratio was measured against, if known. */
    model: string;
    /** When it was measured (ISO). */
    measuredAt: string;
    /** How it was obtained. */
    source: 'default' | 'configured' | 'measured';
}
export declare class TokenCounter {
    private calibration;
    private calibrating;
    constructor(initialRatio: number, source?: Calibration['source']);
    get current(): Calibration;
    load(calibration: Calibration): void;
    /**
     * Estimate the token count of a string.
     *
     * Two independent estimates are taken and the larger wins:
     *   - characters x ratio, which tracks dense text like code and minified JSON
     *     where words are long and whitespace is scarce;
     *   - words x 1.35, which tracks ordinary prose, where BPE lands a bit above
     *     one token per word once punctuation and word-pieces are counted.
     *
     * Taking the max rather than an average is the deliberate conservative
     * choice: whichever kind of text this is, we would rather reserve too much
     * budget than too little.
     */
    estimate(text: string): number;
    /** Estimate for a list of strings, including a small per-item separator cost. */
    estimateAll(texts: string[], separatorTokens?: number): number;
    /**
     * Measure the real tokens-per-character ratio of the loaded model.
     *
     * A single measurement is useless because `usage.prompt_tokens` includes the
     * chat template's own wrapper — the `<|im_start|>user` scaffolding — which is
     * a fixed cost unrelated to our text. Sending two samples of very different
     * lengths and taking the SLOPE between them cancels that constant out:
     *
     *     ratio = (tokens_long - tokens_short) / (chars_long - chars_short)
     *
     * The result is the marginal token cost per character for this exact model,
     * which is what budget arithmetic actually needs.
     *
     * Failure is not an error: an unreachable endpoint just leaves the default
     * ratio in place, and everything keeps working on estimates.
     */
    calibrate(llm: LlmClient): Promise<boolean>;
    /** Trim text so its estimated token count fits a budget. Cuts on a boundary. */
    truncateToBudget(text: string, budgetTokens: number): {
        text: string;
        truncated: boolean;
    };
}
