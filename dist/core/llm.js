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
/** Thrown when the endpoint is unreachable, erroring, or disabled. */
export class LlmUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LlmUnavailableError';
    }
}
export class LlmClient {
    config;
    /** Remembered so we stop hammering a dead endpoint on every single call. */
    lastFailureAt = 0;
    static FAILURE_COOLDOWN_MS = 15_000;
    constructor(config) {
        this.config = config;
    }
    get enabled() {
        return this.config.enabled;
    }
    get describe() {
        return `${this.config.baseUrl}${this.config.model ? ` (${this.config.model})` : ' (loaded model)'}`;
    }
    /**
     * True when a call is worth attempting. After a failure we back off briefly:
     * a summarization request that has to wait for a TCP timeout on every chunk
     * of a 200-chunk document turns a 2-second fallback into a 10-minute hang.
     */
    shouldAttempt() {
        if (!this.config.enabled)
            return false;
        return Date.now() - this.lastFailureAt > LlmClient.FAILURE_COOLDOWN_MS;
    }
    headers() {
        const headers = { 'content-type': 'application/json' };
        if (this.config.apiKey)
            headers.authorization = `Bearer ${this.config.apiKey}`;
        return headers;
    }
    /** List models, as a cheap reachability probe. Returns null if unreachable. */
    async probe() {
        if (!this.config.enabled)
            return null;
        try {
            const res = await fetch(`${this.config.baseUrl}/models`, {
                headers: this.headers(),
                signal: AbortSignal.timeout(Math.min(this.config.timeoutMs, 10_000)),
            });
            if (!res.ok)
                return null;
            const body = (await res.json());
            return (body.data ?? []).map((m) => m.id ?? '').filter(Boolean);
        }
        catch {
            return null;
        }
    }
    async chat(messages, options = {}) {
        if (!this.config.enabled) {
            throw new LlmUnavailableError('LLM summarization is disabled (--no-llm)');
        }
        if (!this.shouldAttempt()) {
            throw new LlmUnavailableError('endpoint recently failed; in cooldown');
        }
        const body = {
            messages,
            // LM Studio accepts an empty/absent model and uses whichever is loaded.
            ...(this.config.model ? { model: this.config.model } : {}),
            temperature: options.temperature ?? 0.2,
            stream: false,
        };
        if (options.maxTokens !== undefined)
            body.max_tokens = options.maxTokens;
        let res;
        try {
            res = await fetch(`${this.config.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(this.config.timeoutMs),
            });
        }
        catch (err) {
            this.lastFailureAt = Date.now();
            const reason = err instanceof Error ? err.message : String(err);
            throw new LlmUnavailableError(`cannot reach ${this.config.baseUrl}: ${reason}`);
        }
        if (!res.ok) {
            this.lastFailureAt = Date.now();
            const detail = await res.text().catch(() => '');
            throw new LlmUnavailableError(`endpoint returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
        }
        let parsed;
        try {
            parsed = (await res.json());
        }
        catch {
            this.lastFailureAt = Date.now();
            throw new LlmUnavailableError('endpoint returned a non-JSON response');
        }
        if (parsed.error) {
            this.lastFailureAt = Date.now();
            const message = typeof parsed.error === 'string' ? parsed.error : parsed.error.message;
            throw new LlmUnavailableError(`endpoint error: ${message ?? 'unknown'}`);
        }
        const text = parsed.choices?.[0]?.message?.content ?? '';
        // Token-counting calls cap generation at one token, which can legitimately
        // come back as whitespace — so emptiness is only an error for real work.
        if (!text.trim() && !options.allowEmpty) {
            throw new LlmUnavailableError('endpoint returned empty content');
        }
        const result = { text: text.trim() };
        if (parsed.usage?.prompt_tokens !== undefined)
            result.promptTokens = parsed.usage.prompt_tokens;
        if (parsed.usage?.completion_tokens !== undefined) {
            result.completionTokens = parsed.usage.completion_tokens;
        }
        return result;
    }
    /**
     * Ask the endpoint how many prompt tokens a piece of text consumes, by
     * generating a single token and reading `usage.prompt_tokens`.
     *
     * The count includes the chat template's own wrapper tokens, so this figure
     * is only meaningful as one half of a two-point measurement — see
     * `TokenCounter.calibrate`, which subtracts the overhead out.
     */
    async promptTokensFor(text) {
        try {
            const result = await this.chat([{ role: 'user', content: text }], {
                maxTokens: 1,
                temperature: 0,
                allowEmpty: true,
            });
            return result.promptTokens ?? null;
        }
        catch {
            return null;
        }
    }
}
//# sourceMappingURL=llm.js.map