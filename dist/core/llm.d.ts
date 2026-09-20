/**
 * Minimal OpenAI-compatible chat client.
 *
 * Why the server calls an LLM itself rather than asking the host: MCP's
 * Sampling feature — where a server asks the client's model to generate — was
 * deprecated in the 2026-07-28 spec, and the migration guidance is explicitly
 * to "integrate directly with LLM provider APIs instead". Calling a plain
 * OpenAI-compatible endpoint also keeps this harness-agnostic: the same code
 * works against LM Studio, Ollama, llama.cpp's server, vLLM, or OpenAI itself.
 */
import type { LlmConfig } from '../config.js';
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
export interface ChatResult {
    text: string;
    promptTokens?: number;
    completionTokens?: number;
}
/** Thrown when the endpoint is unreachable, erroring, or disabled. */
export declare class LlmUnavailableError extends Error {
    constructor(message: string);
}
export declare class LlmClient {
    private readonly config;
    /** Remembered so we stop hammering a dead endpoint on every single call. */
    private lastFailureAt;
    private static readonly FAILURE_COOLDOWN_MS;
    constructor(config: LlmConfig);
    get enabled(): boolean;
    get describe(): string;
    /**
     * True when a call is worth attempting. After a failure we back off briefly:
     * a summarization request that has to wait for a TCP timeout on every chunk
     * of a 200-chunk document turns a 2-second fallback into a 10-minute hang.
     */
    private shouldAttempt;
    private headers;
    /** List models, as a cheap reachability probe. Returns null if unreachable. */
    probe(): Promise<string[] | null>;
    chat(messages: ChatMessage[], options?: {
        maxTokens?: number;
        temperature?: number;
        allowEmpty?: boolean;
    }): Promise<ChatResult>;
    /**
     * Ask the endpoint how many prompt tokens a piece of text consumes, by
     * generating a single token and reading `usage.prompt_tokens`.
     *
     * The count includes the chat template's own wrapper tokens, so this figure
     * is only meaningful as one half of a two-point measurement — see
     * `TokenCounter.calibrate`, which subtracts the overhead out.
     */
    promptTokensFor(text: string): Promise<number | null>;
}
