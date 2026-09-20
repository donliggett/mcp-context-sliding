/**
 * Configuration, parsed once at startup from CLI args + environment.
 * Precedence: CLI flag > environment variable > default.
 */
import * as path from 'node:path';
import * as os from 'node:os';
const DEFAULTS = {
    llmBaseUrl: 'http://localhost:1234/v1',
    llmTimeoutMs: 120_000,
    defaultBudget: 4000,
    chunkTokens: 800,
    chunkOverlap: 80,
    maxIngestChars: 20_000_000,
    httpHost: '127.0.0.1',
    httpPort: 3001,
};
export class ConfigError extends Error {
}
/**
 * Where state lives when the operator does not say.
 *
 * Deliberately NOT the working directory: MCP servers are spawned by the host
 * with an unpredictable cwd, so a relative default would scatter stores around
 * the filesystem depending on how the client happened to launch us.
 */
export function defaultDataDir(env) {
    if (process.platform === 'win32') {
        const base = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
        return path.join(base, 'mcp-context-window');
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'mcp-context-window');
    }
    const base = env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
    return path.join(base, 'mcp-context-window');
}
function parseIntOr(value, fallback, label) {
    if (value === undefined || value === '')
        return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
        throw new ConfigError(`${label} must be a positive number, got ${JSON.stringify(value)}`);
    }
    return Math.round(n);
}
function parseFloatOr(value, fallback, label) {
    if (value === undefined || value === '')
        return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
        throw new ConfigError(`${label} must be a positive number, got ${JSON.stringify(value)}`);
    }
    return n;
}
function parseBool(value, fallback) {
    if (value === undefined || value === '')
        return fallback;
    const v = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v))
        return true;
    if (['0', 'false', 'no', 'off'].includes(v))
        return false;
    throw new ConfigError(`expected a boolean, got ${JSON.stringify(value)}`);
}
function expandHome(p) {
    if (p === '~')
        return os.homedir();
    if (p.startsWith('~/') || p.startsWith('~\\'))
        return path.join(os.homedir(), p.slice(2));
    return p;
}
export const HELP_TEXT = `
mcp-context-window — an external context buffer for local models

USAGE
  mcp-context-window [options]

STORAGE
  --data-dir <dir>          Where sessions and documents are stored
                            (default: platform data dir)
  --ingest-root <dir>       Allow doc_ingest to read files under <dir>.
                            Repeatable. Omitted entirely means inline text
                            only, which is the default.

SUMMARIZATION
  --llm-base-url <url>      OpenAI-compatible endpoint
                            (default ${DEFAULTS.llmBaseUrl})
  --llm-model <id>          Model id; omit to use whatever is loaded
  --llm-api-key <key>       Sent as a bearer token if set
  --llm-timeout <ms>        Per-request timeout (default ${DEFAULTS.llmTimeoutMs})
  --no-llm                  Never call out; always summarize extractively

BUDGETS
  --budget <n>              Default recall/window token budget (default ${DEFAULTS.defaultBudget})
  --chunk-tokens <n>        Target document chunk size (default ${DEFAULTS.chunkTokens})
  --chunk-overlap <n>       Overlap between chunks (default ${DEFAULTS.chunkOverlap})
  --token-ratio <n>         Cold-start tokens-per-character guess (default 0.27)

TRANSPORT
  --stdio                   Serve over stdio (default; use this for LM Studio)
  --http                    Serve over Streamable HTTP
  --host <addr>             HTTP bind address (default ${DEFAULTS.httpHost})
  --port <n>                HTTP port (default ${DEFAULTS.httpPort})

DIAGNOSTICS
  --audit / --no-audit      JSON log line per call on stderr (default on)
  -h, --help                Show this help

ENVIRONMENT
  CTX_DATA_DIR, CTX_INGEST_ROOTS (comma-separated),
  CTX_LLM_BASE_URL, CTX_LLM_MODEL, CTX_LLM_API_KEY,
  CTX_LLM_TIMEOUT_MS, CTX_LLM_ENABLED, CTX_BUDGET, CTX_CHUNK_TOKENS,
  CTX_CHUNK_OVERLAP, CTX_TOKEN_RATIO, CTX_TRANSPORT, CTX_HTTP_HOST,
  CTX_HTTP_PORT, CTX_AUDIT
`.trimStart();
export function loadConfig(argv, env) {
    let dataDir;
    let llmBaseUrl;
    let llmModel;
    let llmApiKey;
    let llmTimeout;
    let llmEnabled;
    let budget;
    let chunkTokens;
    let chunkOverlap;
    let tokenRatio;
    let transport;
    let host;
    let port;
    let audit;
    const ingestRoots = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const take = (name) => {
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) {
                throw new ConfigError(`${name} requires a value`);
            }
            i++;
            return next;
        };
        switch (arg) {
            case '--help':
            case '-h':
                break;
            case '--data-dir':
                dataDir = take(arg);
                break;
            case '--ingest-root':
                ingestRoots.push(expandHome(take(arg)));
                break;
            case '--llm-base-url':
                llmBaseUrl = take(arg);
                break;
            case '--llm-model':
                llmModel = take(arg);
                break;
            case '--llm-api-key':
                llmApiKey = take(arg);
                break;
            case '--llm-timeout':
                llmTimeout = parseIntOr(take(arg), 0, arg);
                break;
            case '--no-llm':
                llmEnabled = false;
                break;
            case '--llm':
                llmEnabled = true;
                break;
            case '--budget':
                budget = parseIntOr(take(arg), 0, arg);
                break;
            case '--chunk-tokens':
                chunkTokens = parseIntOr(take(arg), 0, arg);
                break;
            case '--chunk-overlap':
                chunkOverlap = parseIntOr(take(arg), 0, arg);
                break;
            case '--token-ratio':
                tokenRatio = parseFloatOr(take(arg), 0, arg);
                break;
            case '--stdio':
                transport = 'stdio';
                break;
            case '--http':
                transport = 'http';
                break;
            case '--host':
                host = take(arg);
                break;
            case '--port':
                port = parseIntOr(take(arg), 0, arg);
                break;
            case '--audit':
                audit = true;
                break;
            case '--no-audit':
                audit = false;
                break;
            default:
                if (arg.startsWith('--'))
                    throw new ConfigError(`unknown flag ${arg}`);
                throw new ConfigError(`unexpected argument ${JSON.stringify(arg)}`);
        }
    }
    const resolvedChunkTokens = chunkTokens ?? parseIntOr(env.CTX_CHUNK_TOKENS, DEFAULTS.chunkTokens, 'CTX_CHUNK_TOKENS');
    const resolvedOverlap = chunkOverlap ?? parseIntOr(env.CTX_CHUNK_OVERLAP, DEFAULTS.chunkOverlap, 'CTX_CHUNK_OVERLAP');
    if (resolvedOverlap >= resolvedChunkTokens) {
        throw new ConfigError(`chunk overlap (${resolvedOverlap}) must be smaller than chunk size (${resolvedChunkTokens}); ` +
            'otherwise chunking cannot make forward progress');
    }
    const baseUrl = (llmBaseUrl ?? env.CTX_LLM_BASE_URL ?? DEFAULTS.llmBaseUrl).replace(/\/+$/, '');
    try {
        new URL(baseUrl);
    }
    catch {
        throw new ConfigError(`--llm-base-url is not a valid URL: ${JSON.stringify(baseUrl)}`);
    }
    return {
        dataDir: path.resolve(expandHome(dataDir ?? env.CTX_DATA_DIR ?? defaultDataDir(env))),
        ingestRoots: (ingestRoots.length > 0
            ? ingestRoots
            : (env.CTX_INGEST_ROOTS ?? '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
                .map(expandHome)).map((p) => path.resolve(p)),
        llm: {
            enabled: llmEnabled ?? parseBool(env.CTX_LLM_ENABLED, true),
            baseUrl,
            model: llmModel ?? env.CTX_LLM_MODEL ?? '',
            apiKey: llmApiKey ?? env.CTX_LLM_API_KEY ?? '',
            timeoutMs: llmTimeout ?? parseIntOr(env.CTX_LLM_TIMEOUT_MS, DEFAULTS.llmTimeoutMs, 'CTX_LLM_TIMEOUT_MS'),
        },
        defaultBudget: budget ?? parseIntOr(env.CTX_BUDGET, DEFAULTS.defaultBudget, 'CTX_BUDGET'),
        chunkTokens: resolvedChunkTokens,
        chunkOverlap: resolvedOverlap,
        maxIngestChars: DEFAULTS.maxIngestChars,
        tokenRatio: tokenRatio ?? parseFloatOr(env.CTX_TOKEN_RATIO, 0.27, 'CTX_TOKEN_RATIO'),
        audit: audit ?? parseBool(env.CTX_AUDIT, true),
        transport: transport ?? (env.CTX_TRANSPORT === 'http' ? 'http' : 'stdio'),
        httpHost: host ?? env.CTX_HTTP_HOST ?? DEFAULTS.httpHost,
        httpPort: port ?? parseIntOr(env.CTX_HTTP_PORT, DEFAULTS.httpPort, 'CTX_HTTP_PORT'),
    };
}
//# sourceMappingURL=config.js.map