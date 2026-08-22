# mcp-context-window

An MCP server that gives a local model an **external context buffer**: durable
session memory it can write notes into, and large documents it can page through
without ever loading them whole.

Built on the [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)
against the `2026-07-28` protocol revision. Runs over stdio (LM Studio, Claude
Desktop, anything that spawns a local process) or Streamable HTTP.

---

## Read this first: what an MCP server can and cannot do

**No MCP server can see or modify your context window.** MCP is strictly
request/response — the host calls a tool, the tool answers. The server never
sees the conversation, cannot intercept messages before they reach the model,
and cannot trim anything. LM Studio does its own truncation internally and does
not consult any server about it.

So this is not an automatic sliding window, and anything advertising itself as
one is misleading you. What it *is*: a store the model deliberately pages
against, keeping the bulk of the material outside the window and pulling back
only what it needs. That is genuinely powerful with an 8k-token local model —
but it works because the model calls it, not because it intercepts anything.

The practical consequence: **the model has to cooperate**. Tool descriptions
here are written to be prescriptive, and `context_guide` returns the intended
workflow. If your model ignores them, say so in your system prompt.

One related note: MCP **Sampling** — the mechanism letting a server ask the
client's LLM to generate text — was deprecated in the 2026-07-28 spec, with the
official advice to "integrate directly with LLM provider APIs instead". So this
server calls an OpenAI-compatible endpoint itself. That is also what keeps it
harness-agnostic: the same code works against LM Studio, Ollama, llama.cpp, or
vLLM.

---

## The two halves

### Sessions — working memory across a long task

| Tool | Purpose |
|---|---|
| `context_open` | Start or resume a named session; shows what is already stored |
| `context_append` | Record a fact, decision, or dead end. Pin what must never be lost |
| `context_recall` | Pull back the most relevant entries, packed into a token budget |
| `context_compact` | Fold old entries into a summary to free budget |
| `context_status` | How full the session is, and whether to compact |
| `context_update` | Pin, unpin, or delete one entry |
| `context_list_sessions` | Find a session id from earlier work |

### Documents — material too large to read at once

| Tool | Purpose |
|---|---|
| `doc_ingest` | Load text or a file; chunked and stored, almost nothing enters context |
| `doc_outline` | Structure map: chunk indices, headings, sizes, optional summaries |
| `doc_search` | Find the relevant chunks by keyword and return them verbatim |
| `doc_window` | Read chunk ranges in order; the cursor advances by itself |
| `doc_summarize` | Summarize a range, or the whole thing |
| `doc_list` / `doc_forget` | Manage what is stored |

Plus `context_guide`, which explains the workflow to the model.

---

## Quick start

```bash
npm install
npm run build
npm test
```

```bash
node dist/index.js --ingest-root D:/Projects
```

Or explore it interactively:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

---

## LM Studio

Edit `~/.lmstudio/mcp.json` (on Windows, `C:\Users\<you>\.lmstudio\mcp.json`)
via **Program → Install → Edit mcp.json**, then reload LM Studio.

```json
{
  "mcpServers": {
    "context": {
      "command": "node",
      "args": [
        "D:/Repos/MCPTools/Context-SlidingWindow/mcp-context-sliding/dist/index.js",
        "--ingest-root", "D:/Projects",
        "--budget", "4000"
      ]
    }
  }
}
```

Set `--budget` to roughly half your model's context length. It is the target
this server packs recalls into, not a limit LM Studio enforces.

`--ingest-root` is what lets `doc_ingest` read files. Leave it out and the
server accepts inline text only — which is the safe default, since a server
that opens arbitrary paths on a model's say-so is a liability.

### Docker

```bash
docker build -t mcp-context-window:latest .
```

```json
{
  "mcpServers": {
    "context": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm", "--init",
        "-v", "mcp-context-data:/data",
        "-v", "D:/Projects:/ingest:ro",
        "-e", "CTX_INGEST_ROOTS=/ingest",
        "--add-host", "host.docker.internal:host-gateway",
        "mcp-context-window:latest", "--stdio"
      ]
    }
  }
}
```

Two things that bite here: `-i` is mandatory or the JSON-RPC handshake never
happens, and the named volume is mandatory or **every restart silently discards
all stored sessions**. From inside a container `localhost` is the container, so
the LLM base URL defaults to `host.docker.internal`.

---

## How a session actually goes

```
context_open        session_id "refactor-auth"
context_append      "Goal: replace session cookies with JWT" (pinned)
context_append      "auth/middleware.ts:42 assumes a cookie is present"
context_append      "Decision: keep cookie support behind a flag for one release"
...
context_status      → 3200/4000 tokens — approaching budget
context_compact     → folds 14 old entries into one 380-token summary
context_recall      "cookie flag decision" → returns the pinned goal + the decision
```

And a document:

```
doc_ingest      file_path "D:/logs/build-failure.log"  → doc_kx91, 240 chunks
doc_search      "OutOfMemory"                          → 3 chunks, 1400 tokens
doc_window      from 118 to 121                        → the surrounding context
```

The log never entered the model's context. Three targeted reads did.

---

## Configuration

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--data-dir <dir>` | `CTX_DATA_DIR` | platform data dir | Where state lives |
| `--ingest-root <dir>` | `CTX_INGEST_ROOTS` | *(none)* | Allow `doc_ingest` to read files here. Repeatable. |
| `--llm-base-url <url>` | `CTX_LLM_BASE_URL` | `http://localhost:1234/v1` | OpenAI-compatible endpoint |
| `--llm-model <id>` | `CTX_LLM_MODEL` | *(loaded model)* | Leave empty to use whatever is loaded |
| `--llm-timeout <ms>` | `CTX_LLM_TIMEOUT_MS` | `120000` | Local models can be slow |
| `--no-llm` | `CTX_LLM_ENABLED=false` | enabled | Extractive summaries only |
| `--budget <n>` | `CTX_BUDGET` | `4000` | Default recall/window budget |
| `--chunk-tokens <n>` | `CTX_CHUNK_TOKENS` | `800` | Target chunk size |
| `--chunk-overlap <n>` | `CTX_CHUNK_OVERLAP` | `80` | Overlap between chunks |
| `--token-ratio <n>` | `CTX_TOKEN_RATIO` | `0.27` | Cold-start tokens-per-character guess |
| `--stdio` / `--http` | `CTX_TRANSPORT` | `stdio` | Transport |
| `--host` / `--port` | `CTX_HTTP_HOST` / `CTX_HTTP_PORT` | `127.0.0.1` / `3001` | HTTP bind |
| `--audit` / `--no-audit` | `CTX_AUDIT` | on | JSON log per call on stderr |

---

## Design notes

**Token counting is calibrated against your actual model.** There is no
universal tokenizer — Llama, Qwen and GPT all split differently — and bundling
one would be large and wrong for whatever you loaded. Instead the server
estimates cheaply, then measures the truth: it sends two samples of different
lengths to your endpoint with `max_tokens: 1` and takes the *slope* of the
reported `usage.prompt_tokens` between them. The slope cancels out the chat
template's fixed overhead and yields the real marginal cost per character. The
result is cached, so only the very first run is uncalibrated, and it runs in the
background so startup never blocks on a model that may not be loaded yet.

Estimates deliberately lean high. Undercounting overflows the window and
truncates the very context this server exists to protect.

**Summarization degrades instead of failing.** If your endpoint is unreachable
or no model is loaded, it falls back to extractive summarization — TF-ISF
sentence scoring — which is instant, deterministic, and structurally incapable
of hallucinating, since it can only select sentences that were really there.
Losing access to your stored context is a worse outcome than a cruder summary
of it. After a failure the client backs off briefly, so a 200-chunk document
does not wait out 200 separate TCP timeouts.

**Storage is append-only JSONL.** A crash can corrupt at most the final line,
which is skipped on load rather than being fatal. `tail` the file to watch
memory accumulate. Compaction marks originals superseded rather than deleting
them, so a compaction that dropped something important is still recoverable
from the log.

**Chunking follows document structure**, not fixed offsets — headings,
paragraphs, and fenced code blocks stay intact, and each chunk carries the
heading trail it sits under. Only a block genuinely larger than a whole chunk
gets hard-split.

**Retrieval is BM25 plus recency**, with no embedding model. That needs nothing
loaded, costs no VRAM alongside your main model, and is deterministic — which
matters when the entire point is predictability about what the model sees.
Identifiers are indexed whole and split, so `getUserName` is findable as "user
name".

## Limits

- The model must actually call these tools. Nothing is automatic.
- Keyword search misses paraphrases that an embedding model would catch.
- Token counts are estimates until the first calibration succeeds.
- Neither transport authenticates; HTTP binds to loopback for that reason.
- `doc_ingest` reads UTF-8 text. It is not a PDF or DOCX extractor.

## License

MIT
