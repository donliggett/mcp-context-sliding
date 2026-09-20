/**
 * Session tools — the working-memory half of the server.
 *
 * The tool descriptions carry more weight here than in most servers. A host
 * cannot be given standing instructions (MCP has no mechanism for it, and the
 * v2 `McpServer` exposes no `instructions` field), so the descriptions are the
 * only place to teach the model when to reach for these. They are written to
 * be prescriptive rather than merely descriptive.
 */
import * as z from 'zod/v4';
import { defineTool } from './define.js';
import { Bm25Index, packToBudget } from '../core/retrieval.js';
import { budgetBar, pluralize, relativeTime } from '../util/format.js';
import { InvalidError, NotFoundError } from '../util/errors.js';
import { ENTRY_ROLES } from '../store/sessions.js';
const sessionIdArg = z
    .string()
    .min(1)
    .describe('Session identifier. Reuse the same string across a task to accumulate memory.');
function renderEntry(entry, now) {
    const flags = [entry.id];
    if (entry.pinned)
        flags.push('pinned');
    flags.push(entry.role);
    flags.push(relativeTime(entry.createdAt, now));
    if (entry.tags.length > 0)
        flags.push(`#${entry.tags.join(' #')}`);
    return `[${flags.join(' · ')}]\n${entry.text}`;
}
export function registerSessionTools(server, ctx) {
    defineTool(server, ctx, {
        name: 'context_open',
        description: 'Start or resume a named memory session. Call this ONCE at the beginning of any task ' +
            'that will run long enough to risk losing earlier details, then reuse the same ' +
            'session_id for every later call. Returns what is already stored, so resuming a ' +
            'session after a restart tells you what you previously knew.',
        schema: z.object({
            session_id: z
                .string()
                .min(1)
                .optional()
                .describe('Reuse an existing id to resume, or omit to have one generated'),
            title: z.string().optional().describe('Human-readable label for this session'),
        }),
        async handler(args, { sessions, config }) {
            const session = await sessions.open(args.session_id, args.title);
            await sessions.saveMeta(session);
            const live = session.live;
            const now = Date.now();
            const lines = [
                `session_id: ${session.meta.id}`,
                `title:      ${session.meta.title}`,
                `entries:    ${live.length} live (${session.all.length} total including compacted)`,
                `tokens:     ${budgetBar(session.liveTokens, config.defaultBudget)}`,
            ];
            if (live.length > 0) {
                const recent = live.slice(-5);
                lines.push('', `Most recent ${pluralize(recent.length, 'entry', 'entries')}:`);
                for (const entry of recent) {
                    const preview = entry.text.length > 160 ? `${entry.text.slice(0, 160)}…` : entry.text;
                    lines.push(`  [${entry.id} · ${entry.role} · ${relativeTime(entry.createdAt, now)}] ${preview}`);
                }
            }
            else {
                lines.push('', 'Empty session. Use context_append to record findings as you work.');
            }
            return { body: lines.join('\n'), audit: { session: session.meta.id, entries: live.length } };
        },
    });
    defineTool(server, ctx, {
        name: 'context_append',
        description: 'Record something worth remembering into the session. Use this as you go — after ' +
            'discovering a fact, making a decision, or hitting a dead end — rather than trying to ' +
            'hold it all in your reply. Keep each entry self-contained: it may be read back much ' +
            'later without the surrounding conversation. Set pinned for facts that must never be ' +
            'dropped during compaction, such as the goal or a hard constraint.',
        schema: z.object({
            session_id: sessionIdArg,
            text: z.string().min(1).describe('The content to remember, written to stand alone'),
            role: z
                .enum(ENTRY_ROLES)
                .optional()
                .describe('note (default), decision, user, assistant, system'),
            tags: z.array(z.string()).max(10).optional().describe('Short labels to group entries'),
            pinned: z
                .boolean()
                .optional()
                .describe('Always survives compaction and is always included in recall'),
        }),
        async handler(args, { sessions, counter, config }) {
            const session = await sessions.open(args.session_id, undefined);
            const entry = await session.append({
                role: (args.role ?? 'note'),
                text: args.text,
                tags: args.tags ?? [],
                pinned: args.pinned ?? false,
            }, counter);
            await sessions.saveMeta(session);
            const liveTokens = session.liveTokens;
            const pressure = liveTokens / config.defaultBudget;
            const advice = pressure > 1
                ? '\n\nThis session now exceeds one budget window. Call context_compact to fold older entries into a summary.'
                : pressure > 0.75
                    ? '\n\nApproaching the budget. Consider context_compact soon.'
                    : '';
            return {
                body: `Stored ${entry.id} (${entry.tokens} tokens${entry.pinned ? ', pinned' : ''}).\n` +
                    `Session now: ${budgetBar(liveTokens, config.defaultBudget)}${advice}`,
                audit: { session: session.meta.id, entry: entry.id, tokens: entry.tokens },
            };
        },
    });
    defineTool(server, ctx, {
        name: 'context_recall',
        description: 'Retrieve the most relevant stored entries for a query, packed to fit a token budget. ' +
            'This is the main way to get memory back into your working context: ask for what you ' +
            'need rather than reading the whole session. Pinned entries are always included. ' +
            'Omit the query to get the most recent entries instead.',
        schema: z.object({
            session_id: sessionIdArg,
            query: z
                .string()
                .optional()
                .describe('What you are looking for. Omit for most-recent ordering.'),
            budget_tokens: z
                .number()
                .int()
                .min(50)
                .max(100000)
                .optional()
                .describe('Maximum tokens of entries to return'),
            limit: z.number().int().min(1).max(200).optional().describe('Maximum number of entries'),
        }),
        async handler(args, { sessions, config }) {
            const session = await sessions.open(args.session_id, undefined);
            const live = session.live;
            if (live.length === 0) {
                return { body: `Session ${session.meta.id} is empty.`, audit: { session: session.meta.id } };
            }
            const budget = args.budget_tokens ?? config.defaultBudget;
            const retrievables = live.map((entry) => ({
                id: entry.id,
                text: entry.text,
                createdAt: entry.createdAt,
                pinned: entry.pinned,
                tokens: entry.tokens,
                entry,
            }));
            const index = new Bm25Index(retrievables);
            const scored = index.search(args.query ?? '');
            const limited = args.limit ? scored.slice(0, args.limit) : scored;
            const packed = packToBudget(limited, budget);
            if (packed.selected.length === 0) {
                return {
                    body: `No entries matched${args.query ? ` "${args.query}"` : ''} within ${budget} tokens. ` +
                        `The session holds ${pluralize(live.length, 'entry', 'entries')}.`,
                    audit: { session: session.meta.id, matched: 0 },
                };
            }
            // Chronological output: the model reasons better over memory that reads
            // in the order things happened, even though selection was by relevance.
            const ordered = [...packed.selected].sort((a, b) => a.item.entry.seq - b.item.entry.seq);
            const now = Date.now();
            const header = `${packed.selected.length} of ${live.length} entries` +
                `${args.query ? ` matching "${args.query}"` : ' (most recent)'}` +
                ` — ${packed.usedTokens}/${budget} tokens` +
                (packed.omitted > 0 ? `, ${packed.omitted} more did not fit` : '');
            return {
                body: `${header}\n\n${ordered.map((s) => renderEntry(s.item.entry, now)).join('\n\n')}`,
                audit: {
                    session: session.meta.id,
                    matched: packed.selected.length,
                    tokens: packed.usedTokens,
                },
            };
        },
    });
    defineTool(server, ctx, {
        name: 'context_compact',
        description: 'Fold older entries into a single summary to free budget, keeping the most recent ' +
            'entries verbatim. Call this when context_status or context_append warns that the ' +
            'session is over budget. Pinned entries are never compacted. The originals are kept ' +
            'on disk and can be recovered, so this is safe to run. Use dry_run first to see what ' +
            'would happen.',
        schema: z.object({
            session_id: sessionIdArg,
            keep_recent: z
                .number()
                .int()
                .min(0)
                .max(500)
                .optional()
                .describe('How many of the newest entries to leave untouched (default 10)'),
            target_tokens: z
                .number()
                .int()
                .min(50)
                .max(20000)
                .optional()
                .describe('Rough size of the summary produced (default 400)'),
            dry_run: z.boolean().optional().describe('Report what would be compacted without doing it'),
        }),
        async handler(args, { sessions, summarizer, counter }) {
            const session = await sessions.open(args.session_id, undefined);
            const keepRecent = args.keep_recent ?? 10;
            const targetTokens = args.target_tokens ?? 400;
            const live = session.live;
            const candidates = live
                .slice(0, Math.max(0, live.length - keepRecent))
                .filter((e) => !e.pinned && e.role !== 'summary');
            if (candidates.length < 2) {
                return {
                    body: `Nothing to compact: ${pluralize(candidates.length, 'entry', 'entries')} eligible ` +
                        `(keeping the newest ${keepRecent}, skipping pinned and existing summaries).`,
                    audit: { session: session.meta.id, compacted: 0 },
                };
            }
            const reclaimable = candidates.reduce((sum, e) => sum + e.tokens, 0);
            if (args.dry_run) {
                return {
                    body: `Dry run — would fold ${pluralize(candidates.length, 'entry', 'entries')} ` +
                        `(${reclaimable} tokens) into one summary of about ${targetTokens} tokens, ` +
                        `saving roughly ${Math.max(0, reclaimable - targetTokens)} tokens.\n\n` +
                        `Entries: ${candidates.map((e) => e.id).join(', ')}`,
                    audit: { session: session.meta.id, dryRun: true, candidates: candidates.length },
                };
            }
            const material = candidates
                .map((e) => `[${e.role}${e.tags.length ? ` #${e.tags.join(' #')}` : ''}] ${e.text}`)
                .join('\n\n');
            const summary = await summarizer.summarize(material, {
                targetTokens,
                instruction: 'These are working notes from an ongoing task. Produce a condensed record that ' +
                    'preserves every decision, concrete fact, identifier, file path and unresolved ' +
                    'question. Written for your future self to resume from.',
            });
            const entry = await session.compact(candidates.map((e) => e.id), summary.text, counter);
            await sessions.saveMeta(session);
            const note = summary.method === 'extractive' && summary.fallbackReason
                ? `\n\nNote: summarized extractively — the LLM endpoint was unavailable (${summary.fallbackReason}).`
                : summary.method === 'extractive'
                    ? '\n\nNote: summarized extractively (no LLM configured).'
                    : '';
            return {
                body: `Compacted ${pluralize(candidates.length, 'entry', 'entries')} (${reclaimable} tokens) ` +
                    `into ${entry.id} (${entry.tokens} tokens). Freed ${Math.max(0, reclaimable - entry.tokens)} tokens.\n` +
                    `Session now holds ${session.liveTokens} tokens across ${pluralize(session.live.length, 'entry', 'entries')}.` +
                    note +
                    `\n\n--- summary ---\n${entry.text}`,
                audit: {
                    session: session.meta.id,
                    compacted: candidates.length,
                    method: summary.method,
                    freed: reclaimable - entry.tokens,
                },
            };
        },
    });
    defineTool(server, ctx, {
        name: 'context_status',
        description: 'Report how full a session is, what is pinned, and whether compaction is advisable. ' +
            'Cheap to call — use it to decide whether you need to compact before adding more.',
        schema: z.object({ session_id: sessionIdArg }),
        async handler(args, { sessions, config, llm, counter }) {
            const session = await sessions.open(args.session_id, undefined);
            const live = session.live;
            const pinned = live.filter((e) => e.pinned);
            const summaries = live.filter((e) => e.role === 'summary');
            const tokens = session.liveTokens;
            const calibration = counter.current;
            const lines = [
                `session:      ${session.meta.id} (${session.meta.title})`,
                `entries:      ${live.length} live, ${session.all.length - live.length} compacted away`,
                `pinned:       ${pinned.length}`,
                `summaries:    ${summaries.length}`,
                `budget:       ${budgetBar(tokens, config.defaultBudget)}`,
                `token counts: ${calibration.source}${calibration.source === 'measured' ? ` against the loaded model` : ''} (${calibration.ratio.toFixed(3)} tokens/char)`,
                `summarizer:   ${llm.enabled ? llm.describe : 'disabled (extractive only)'}`,
            ];
            if (tokens > config.defaultBudget) {
                lines.push('', 'Over budget — call context_compact.');
            }
            else if (tokens > config.defaultBudget * 0.75) {
                lines.push('', 'Approaching budget — compaction advisable soon.');
            }
            return { body: lines.join('\n'), audit: { session: session.meta.id, tokens } };
        },
    });
    defineTool(server, ctx, {
        name: 'context_update',
        description: 'Pin, unpin, or delete a single entry by its id. Pin what must survive compaction; ' +
            'delete what turned out to be wrong, so it stops polluting recall.',
        schema: z.object({
            session_id: sessionIdArg,
            entry_id: z.string().min(1).describe('Entry id, as shown in recall output'),
            pinned: z.boolean().optional().describe('Set or clear the pin'),
            delete: z.boolean().optional().describe('Remove the entry from recall'),
        }),
        async handler(args, { sessions }) {
            if (args.pinned === undefined && args.delete === undefined) {
                throw new InvalidError('specify pinned and/or delete');
            }
            const session = await sessions.open(args.session_id, undefined);
            if (!session.get(args.entry_id)) {
                throw new NotFoundError(`no entry ${args.entry_id} in session ${session.meta.id}`);
            }
            const changes = {};
            if (args.pinned !== undefined)
                changes.pinned = args.pinned;
            if (args.delete !== undefined)
                changes.deleted = args.delete;
            await session.patch(args.entry_id, changes);
            await sessions.saveMeta(session);
            const done = [
                args.pinned === true ? 'pinned' : args.pinned === false ? 'unpinned' : null,
                args.delete === true ? 'deleted' : args.delete === false ? 'restored' : null,
            ].filter(Boolean);
            return {
                body: `${args.entry_id}: ${done.join(', ')}.`,
                audit: { session: session.meta.id, entry: args.entry_id, ...changes },
            };
        },
    });
    defineTool(server, ctx, {
        name: 'context_list_sessions',
        description: 'List stored sessions, newest first. Use this to find a session id from earlier work ' +
            'when you do not remember it.',
        schema: z.object({}),
        async handler(_args, { sessions }) {
            const metas = await sessions.list();
            if (metas.length === 0) {
                return { body: 'No sessions stored yet.' };
            }
            const now = Date.now();
            return {
                body: [
                    `${pluralize(metas.length, 'session')}:`,
                    ...metas.map((m) => `  ${m.id}  ${m.title}  (updated ${relativeTime(m.updatedAt, now)})`),
                ].join('\n'),
                audit: { sessions: metas.length },
            };
        },
    });
}
//# sourceMappingURL=session-tools.js.map