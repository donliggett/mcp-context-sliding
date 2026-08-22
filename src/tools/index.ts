/**
 * Tool registration.
 *
 * Under Streamable HTTP the SDK builds a server per request, so this runs on
 * every call and must stay cheap and hold no per-connection state. Everything
 * shared lives in `ctx`, built once at startup.
 */

import * as z from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';

import { defineTool, type ToolContext } from './define.js';
import { registerSessionTools } from './session-tools.js';
import { registerDocumentTools } from './doc-tools.js';

export type { ToolContext };

const GUIDE = `
This server is an EXTERNAL context buffer. It cannot see or trim your context
window — no MCP server can. It works only because you deliberately move
material out of your context and pull pieces back when you need them.

Two halves:

SESSIONS — working memory across a long task
  1. context_open at the start, with a session_id you reuse throughout.
  2. context_append every time you learn something worth keeping. Write each
     entry so it stands alone; you may read it back with no surrounding
     conversation. Pin the goal and any hard constraints.
  3. context_recall with a query to pull back only what is relevant, instead
     of re-reading everything.
  4. context_compact when status says you are over budget. Old entries fold
     into a summary; pinned ones survive untouched.

DOCUMENTS — material too large to read at once
  1. doc_ingest the file or text. It is chunked and stored; almost nothing
     enters your context.
  2. doc_outline to see its structure and decide what matters.
  3. doc_search when you know what you are looking for — usually the right
     move, and much cheaper than paging.
  4. doc_window to read chunk ranges in order. The cursor advances on its
     own, so repeated calls page forward.
  5. doc_summarize for the gist of a range too big to read.

The habit that makes this work: append as you go, recall narrowly, and never
pull a whole document in when a search would do.
`.trim();

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  defineTool(server, ctx, {
    name: 'context_guide',
    description:
      'Explain how to use this server effectively — the intended workflow for sessions and ' +
      'documents. Call this once if you have not used these tools before.',
    schema: z.object({}),
    async handler(_args, { config, llm, ingest }) {
      const status = [
        '',
        '--- this instance ---',
        `data directory:  ${config.dataDir}`,
        `default budget:  ${config.defaultBudget} tokens`,
        `chunk size:      ${config.chunkTokens} tokens (overlap ${config.chunkOverlap})`,
        `summarizer:      ${llm.enabled ? llm.describe : 'disabled — extractive only'}`,
        `file ingestion:  ${ingest.enabled ? ingest.allowed.join(', ') : 'disabled (inline text only)'}`,
      ].join('\n');
      return { body: GUIDE + '\n' + status };
    },
  });

  registerSessionTools(server, ctx);
  registerDocumentTools(server, ctx);
}

export const TOOL_NAMES = [
  'context_guide',
  'context_open',
  'context_append',
  'context_recall',
  'context_compact',
  'context_status',
  'context_update',
  'context_list_sessions',
  'doc_ingest',
  'doc_outline',
  'doc_window',
  'doc_search',
  'doc_summarize',
  'doc_list',
  'doc_forget',
] as const;
