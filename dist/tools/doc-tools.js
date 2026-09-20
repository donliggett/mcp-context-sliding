/**
 * Document tools — the paging half of the server.
 *
 * The pattern these are designed around: ingest once, read the outline, then
 * pull only the windows you actually need. A 400 KB log becomes a 300-token
 * outline plus a handful of targeted reads, instead of an instant overflow.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as z from 'zod/v4';
import { defineTool } from './define.js';
import { chunkText } from '../core/chunk.js';
import { Bm25Index, packToBudget } from '../core/retrieval.js';
import { pluralize, relativeTime } from '../util/format.js';
import { InvalidError, LimitError } from '../util/errors.js';
const docIdArg = z.string().min(1).describe('Document id returned by doc_ingest');
export function registerDocumentTools(server, ctx) {
    defineTool(server, ctx, {
        name: 'doc_ingest',
        description: 'Load a large text into the store and split it into addressable chunks. Use this ' +
            'INSTEAD OF reading a big file into your context: the content stays on disk and you ' +
            'page through it with doc_outline, doc_search and doc_window. Accepts inline text, or ' +
            'a file path if the server was started with an ingest root. Returns a document id.',
        schema: z.object({
            text: z.string().optional().describe('The content, passed inline'),
            file_path: z
                .string()
                .optional()
                .describe('Read from this file instead. Requires --ingest-root to be configured.'),
            title: z.string().optional().describe('Label for the document'),
            doc_id: z
                .string()
                .optional()
                .describe('Reuse a specific id, replacing any document already stored under it'),
        }),
        async handler(args, { documents, counter, config, ingest }) {
            if (!args.text && !args.file_path) {
                throw new InvalidError('provide either text or file_path');
            }
            if (args.text && args.file_path) {
                throw new InvalidError('provide text or file_path, not both');
            }
            let content;
            let source;
            let title;
            if (args.file_path) {
                const real = await ingest.resolveFile(args.file_path);
                const stats = await fs.stat(real);
                if (stats.size > config.maxIngestChars) {
                    throw new LimitError(`${args.file_path} is ${stats.size} bytes, over the ${config.maxIngestChars} ingest limit`);
                }
                content = await fs.readFile(real, 'utf8');
                source = real;
                title = args.title ?? path.basename(real);
            }
            else {
                content = args.text;
                source = 'inline';
                title = args.title ?? 'inline document';
            }
            if (content.trim().length === 0)
                throw new InvalidError('content is empty');
            if (content.length > config.maxIngestChars) {
                throw new LimitError(`content is ${content.length} characters, over the ingest limit`);
            }
            const chunks = chunkText(content, counter, {
                chunkTokens: config.chunkTokens,
                overlapTokens: config.chunkOverlap,
            });
            const doc = await documents.create({
                ...(args.doc_id ? { id: args.doc_id } : {}),
                title,
                source,
                text: content,
                chunks,
            });
            return {
                body: `Ingested "${doc.meta.title}" as ${doc.meta.id}\n` +
                    `  ${doc.meta.chars.toLocaleString()} characters, ~${doc.meta.totalTokens.toLocaleString()} tokens\n` +
                    `  ${pluralize(doc.meta.chunkCount, 'chunk')} of about ${config.chunkTokens} tokens each\n\n` +
                    `Next: doc_outline to see its structure, or doc_search to jump straight to a topic. ` +
                    `Do not try to read it all at once.`,
                audit: { doc: doc.meta.id, chunks: doc.meta.chunkCount, tokens: doc.meta.totalTokens },
            };
        },
    });
    defineTool(server, ctx, {
        name: 'doc_outline',
        description: 'Show the structure of an ingested document: every chunk with its index, heading and ' +
            'size. Call this right after doc_ingest to decide what is worth reading. Set ' +
            'summarize to also generate a one-line summary per chunk — more useful, but it runs ' +
            'the summarizer once per chunk, so it is slow on large documents.',
        schema: z.object({
            doc_id: docIdArg,
            summarize: z
                .boolean()
                .optional()
                .describe('Generate and cache a short summary for each chunk'),
            max_chunks: z
                .number()
                .int()
                .min(1)
                .max(500)
                .optional()
                .describe('Only outline the first N chunks'),
        }),
        async handler(args, { documents, summarizer }) {
            const doc = await documents.load(args.doc_id);
            const chunks = args.max_chunks ? doc.chunks.slice(0, args.max_chunks) : doc.chunks;
            if (args.summarize) {
                for (const chunk of chunks) {
                    if (chunk.summary)
                        continue; // Cached from a previous call.
                    const result = await summarizer.summarize(chunk.text, {
                        targetTokens: 40,
                        instruction: 'In one sentence, state what this section is about.',
                    });
                    await documents.setChunkSummary(doc.meta.id, chunk.index, result.text);
                    chunk.summary = result.text;
                }
            }
            const lines = chunks.map((chunk) => {
                const heading = chunk.heading || '(no heading)';
                const summary = chunk.summary ? `\n      ${chunk.summary}` : '';
                return `  [${chunk.index}] ${heading} — ${chunk.tokens} tokens${summary}`;
            });
            return {
                body: `${doc.meta.title} (${doc.meta.id}) — ${pluralize(doc.meta.chunkCount, 'chunk')}, ` +
                    `~${doc.meta.totalTokens.toLocaleString()} tokens total\n\n` +
                    lines.join('\n') +
                    (args.max_chunks && doc.chunks.length > args.max_chunks
                        ? `\n\n  … ${doc.chunks.length - args.max_chunks} more chunks`
                        : '') +
                    `\n\nRead specific chunks with doc_window, or find relevant ones with doc_search.`,
                audit: { doc: doc.meta.id, summarized: args.summarize === true },
            };
        },
    });
    defineTool(server, ctx, {
        name: 'doc_window',
        description: 'Read a range of chunks verbatim. This is the sliding window: ask for chunks 0-2, ' +
            'then 3-5, and so on, keeping each read inside your budget. Omit from/to to continue ' +
            'from where the last window left off — the read cursor is stored server-side, so ' +
            'sequential paging works without you tracking position.',
        schema: z.object({
            doc_id: docIdArg,
            from: z.number().int().min(0).optional().describe('First chunk index (inclusive)'),
            to: z.number().int().min(0).optional().describe('Last chunk index (inclusive)'),
            budget_tokens: z
                .number()
                .int()
                .min(50)
                .max(100000)
                .optional()
                .describe('Stop before exceeding this many tokens'),
            reset: z.boolean().optional().describe('Move the cursor back to the start'),
        }),
        async handler(args, { documents, config }) {
            const doc = await documents.load(args.doc_id);
            if (doc.chunks.length === 0)
                throw new InvalidError(`document ${doc.meta.id} has no chunks`);
            if (args.reset) {
                await documents.updateMeta(doc.meta.id, { cursor: 0 });
                if (args.from === undefined && args.to === undefined) {
                    return { body: `Cursor for ${doc.meta.id} reset to chunk 0.`, audit: { doc: doc.meta.id } };
                }
            }
            const budget = args.budget_tokens ?? config.defaultBudget;
            const start = args.from ?? (args.reset ? 0 : doc.meta.cursor);
            if (start >= doc.chunks.length) {
                return {
                    body: `End of document: ${doc.meta.id} has ${pluralize(doc.chunks.length, 'chunk')} ` +
                        `and the cursor is at ${start}. Pass reset: true to start over.`,
                    audit: { doc: doc.meta.id, exhausted: true },
                };
            }
            const hardEnd = args.to !== undefined ? Math.min(args.to, doc.chunks.length - 1) : doc.chunks.length - 1;
            const taken = [];
            let used = 0;
            for (let i = start; i <= hardEnd; i++) {
                const chunk = doc.chunks[i];
                // Always take at least one chunk, even if it alone busts the budget —
                // otherwise an oversized chunk would stall paging forever.
                if (taken.length > 0 && used + chunk.tokens > budget)
                    break;
                taken.push(chunk);
                used += chunk.tokens;
            }
            const nextCursor = taken[taken.length - 1].index + 1;
            await documents.updateMeta(doc.meta.id, { cursor: nextCursor });
            const remaining = doc.chunks.length - nextCursor;
            const header = `${doc.meta.title} — chunks ${taken[0].index}-${taken[taken.length - 1].index} ` +
                `of 0-${doc.chunks.length - 1} (${used} tokens)` +
                (remaining > 0
                    ? `\n${pluralize(remaining, 'chunk')} remaining; call doc_window again to continue.`
                    : '\nThis is the end of the document.');
            const body = taken
                .map((c) => `\n--- [${c.index}]${c.heading ? ` ${c.heading}` : ''} ---\n${c.text}`)
                .join('\n');
            return {
                body: header + '\n' + body,
                audit: { doc: doc.meta.id, chunks: taken.length, tokens: used, cursor: nextCursor },
            };
        },
    });
    defineTool(server, ctx, {
        name: 'doc_search',
        description: 'Find the chunks of a document most relevant to a query and return them verbatim, ' +
            'packed into a token budget. Prefer this over paging when you know what you are ' +
            'looking for — it is the difference between reading a manual and using its index. ' +
            'Omit doc_id to search across every ingested document.',
        schema: z.object({
            doc_id: z.string().optional().describe('Restrict to one document; omit to search all'),
            query: z.string().min(1).describe('What you are looking for'),
            budget_tokens: z
                .number()
                .int()
                .min(50)
                .max(100000)
                .optional()
                .describe('Maximum tokens of chunk text to return'),
            limit: z.number().int().min(1).max(50).optional().describe('Maximum chunks to return'),
        }),
        async handler(args, { documents, config }) {
            const metas = args.doc_id ? [(await documents.load(args.doc_id)).meta] : await documents.list();
            if (metas.length === 0) {
                return { body: 'No documents ingested yet. Use doc_ingest first.' };
            }
            const candidates = [];
            for (const meta of metas) {
                const doc = await documents.load(meta.id);
                for (const chunk of doc.chunks) {
                    candidates.push({
                        id: `${meta.id}#${chunk.index}`,
                        // Headings are part of the searchable text so a query matching a
                        // section title finds the section even when the body words differ.
                        text: `${chunk.heading}\n${chunk.text}`,
                        createdAt: meta.createdAt,
                        tokens: chunk.tokens,
                        docId: meta.id,
                        docTitle: meta.title,
                        chunk,
                    });
                }
            }
            const index = new Bm25Index(candidates);
            // Recency is meaningless when ranking chunks of a static document.
            const scored = index.search(args.query, { recencyWeight: 0 }).filter((s) => s.score > 0);
            const limited = scored.slice(0, args.limit ?? 10);
            const packed = packToBudget(limited, args.budget_tokens ?? config.defaultBudget);
            if (packed.selected.length === 0) {
                return {
                    body: `No chunks matched "${args.query}" across ${pluralize(metas.length, 'document')}. ` +
                        `Try different wording, or doc_outline to see what is actually in there.`,
                    audit: { matched: 0 },
                };
            }
            const body = packed.selected
                .map((s) => {
                const hit = s.item;
                return (`\n--- ${hit.docTitle} [${hit.chunk.index}]` +
                    `${hit.chunk.heading ? ` ${hit.chunk.heading}` : ''} · score ${s.score.toFixed(2)} ---\n` +
                    hit.chunk.text);
            })
                .join('\n');
            return {
                body: `${packed.selected.length} matching ${packed.selected.length === 1 ? 'chunk' : 'chunks'} ` +
                    `for "${args.query}" (${packed.usedTokens} tokens` +
                    (scored.length > packed.selected.length
                        ? `, ${scored.length - packed.selected.length} more matched but did not fit`
                        : '') +
                    ')\n' +
                    body,
                audit: { matched: packed.selected.length, tokens: packed.usedTokens },
            };
        },
    });
    defineTool(server, ctx, {
        name: 'doc_summarize',
        description: 'Summarize a whole document or a range of its chunks. Use this to get the gist of ' +
            'something too large to read, before deciding which parts to pull verbatim. The ' +
            'whole-document summary is cached, so asking again is free.',
        schema: z.object({
            doc_id: docIdArg,
            from: z.number().int().min(0).optional().describe('First chunk index (inclusive)'),
            to: z.number().int().min(0).optional().describe('Last chunk index (inclusive)'),
            target_tokens: z
                .number()
                .int()
                .min(50)
                .max(8000)
                .optional()
                .describe('Rough length of the summary (default 500)'),
            refresh: z.boolean().optional().describe('Ignore the cached whole-document summary'),
        }),
        async handler(args, { documents, summarizer }) {
            const doc = await documents.load(args.doc_id);
            const targetTokens = args.target_tokens ?? 500;
            const whole = args.from === undefined && args.to === undefined;
            if (whole && doc.meta.summary && !args.refresh) {
                return {
                    body: `${doc.meta.title} (cached summary)\n\n${doc.meta.summary}`,
                    audit: { doc: doc.meta.id, cached: true },
                };
            }
            const from = args.from ?? 0;
            const to = args.to ?? doc.chunks.length - 1;
            if (from > to)
                throw new InvalidError('from must not be greater than to');
            const selected = doc.chunks.filter((c) => c.index >= from && c.index <= to);
            if (selected.length === 0)
                throw new InvalidError(`no chunks in range ${from}-${to}`);
            const result = await summarizer.summarize(selected.map((c) => c.text).join('\n\n'), {
                targetTokens,
                instruction: 'Summarize this document faithfully. Keep specific facts, names, numbers, ' +
                    'identifiers and conclusions. Do not speculate about content not shown.',
            });
            if (whole)
                await documents.updateMeta(doc.meta.id, { summary: result.text });
            const note = result.method === 'extractive'
                ? `\n\n(Summarized extractively${result.fallbackReason ? ` — LLM unavailable: ${result.fallbackReason}` : ''}. ` +
                    'Sentences are quoted from the source rather than rewritten.)'
                : result.passes > 1
                    ? `\n\n(Summarized in ${result.passes} passes over ${pluralize(selected.length, 'chunk')}.)`
                    : '';
            return {
                body: `${doc.meta.title} — chunks ${from}-${to} of 0-${doc.chunks.length - 1}\n\n` +
                    result.text +
                    note,
                audit: { doc: doc.meta.id, method: result.method, passes: result.passes },
            };
        },
    });
    defineTool(server, ctx, {
        name: 'doc_list',
        description: 'List ingested documents with their ids, sizes and read positions.',
        schema: z.object({}),
        async handler(_args, { documents }) {
            const metas = await documents.list();
            if (metas.length === 0)
                return { body: 'No documents ingested yet.' };
            const now = Date.now();
            return {
                body: [
                    `${pluralize(metas.length, 'document')}:`,
                    ...metas.map((m) => `  ${m.id}  ${m.title}\n` +
                        `    ${pluralize(m.chunkCount, 'chunk')}, ~${m.totalTokens.toLocaleString()} tokens, ` +
                        `cursor at ${m.cursor}, ingested ${relativeTime(m.createdAt, now)}` +
                        (m.summary ? ' · has summary' : '')),
                ].join('\n'),
                audit: { documents: metas.length },
            };
        },
    });
    defineTool(server, ctx, {
        name: 'doc_forget',
        description: 'Permanently delete an ingested document and everything derived from it. Use when a ' +
            'document is stale or was ingested by mistake.',
        schema: z.object({ doc_id: docIdArg }),
        async handler(args, { documents }) {
            const doc = await documents.load(args.doc_id);
            const title = doc.meta.title;
            await documents.delete(args.doc_id);
            return { body: `Deleted ${args.doc_id} ("${title}").`, audit: { doc: args.doc_id } };
        },
    });
}
//# sourceMappingURL=doc-tools.js.map