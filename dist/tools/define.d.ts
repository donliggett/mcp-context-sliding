/**
 * Tool registration wrapper: uniform error translation and audit logging.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';
import type { Config } from '../config.js';
import type { Auditor } from '../util/audit.js';
import type { TokenCounter } from '../core/tokens.js';
import type { Summarizer } from '../core/summarize.js';
import type { LlmClient } from '../core/llm.js';
import type { SessionStore } from '../store/sessions.js';
import type { DocumentStore } from '../store/documents.js';
import type { IngestSandbox } from '../util/safepath.js';
export interface ToolContext {
    config: Config;
    auditor: Auditor;
    counter: TokenCounter;
    summarizer: Summarizer;
    llm: LlmClient;
    sessions: SessionStore;
    documents: DocumentStore;
    ingest: IngestSandbox;
}
export interface ToolResult {
    body: string;
    /** Extra fields folded into the audit line. */
    audit?: Record<string, unknown>;
}
export interface ToolDefinition<S extends z.ZodType> {
    name: string;
    description: string;
    schema: S;
    handler: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolResult>;
}
export declare function defineTool<S extends z.ZodType>(server: McpServer, ctx: ToolContext, def: ToolDefinition<S>): void;
