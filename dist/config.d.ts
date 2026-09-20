/**
 * Configuration, parsed once at startup from CLI args + environment.
 * Precedence: CLI flag > environment variable > default.
 */
export type Transport = 'stdio' | 'http';
export interface LlmConfig {
    /** Whether to attempt LLM-backed summarization at all. */
    enabled: boolean;
    /** OpenAI-compatible base URL, e.g. http://localhost:1234/v1 */
    baseUrl: string;
    /**
     * Model id. Empty string means "whatever the server has loaded" — LM Studio
     * accepts this and uses the currently-loaded model, which is what you want
     * when the user swaps models without restarting anything.
     */
    model: string;
    /** Most local servers ignore this, but OpenAI-compatible proxies may not. */
    apiKey: string;
    /** Per-request timeout. Local models on CPU can be slow; be generous. */
    timeoutMs: number;
}
export interface Config {
    dataDir: string;
    /**
     * Directories `doc_ingest` may read files from. Empty means file ingestion
     * is disabled and only inline text is accepted — the safe default, since a
     * server that reads arbitrary paths on a model's say-so is a liability.
     */
    ingestRoots: string[];
    llm: LlmConfig;
    /** Default token budget a recall/window call packs into. */
    defaultBudget: number;
    /** Target size of a document chunk, in tokens. */
    chunkTokens: number;
    /** Token overlap between adjacent chunks, so sentences are not orphaned. */
    chunkOverlap: number;
    /** Hard cap on a single ingested document, in characters. */
    maxIngestChars: number;
    /**
     * Tokens-per-character calibration. Refined at runtime against the real
     * model's reported usage; this is only the cold-start guess.
     */
    tokenRatio: number;
    audit: boolean;
    transport: Transport;
    httpHost: string;
    httpPort: number;
}
export declare class ConfigError extends Error {
}
/**
 * Where state lives when the operator does not say.
 *
 * Deliberately NOT the working directory: MCP servers are spawned by the host
 * with an unpredictable cwd, so a relative default would scatter stores around
 * the filesystem depending on how the client happened to launch us.
 */
export declare function defaultDataDir(env: NodeJS.ProcessEnv): string;
export declare const HELP_TEXT: string;
export declare function loadConfig(argv: string[], env: NodeJS.ProcessEnv): Config;
