/**
 * Tool registration.
 *
 * Under Streamable HTTP the SDK builds a server per request, so this runs on
 * every call and must stay cheap and hold no per-connection state. Everything
 * shared lives in `ctx`, built once at startup.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { type ToolContext } from './define.js';
export type { ToolContext };
export declare function registerAllTools(server: McpServer, ctx: ToolContext): void;
export declare const TOOL_NAMES: readonly ["context_guide", "context_open", "context_append", "context_recall", "context_compact", "context_status", "context_update", "context_list_sessions", "doc_ingest", "doc_outline", "doc_window", "doc_search", "doc_summarize", "doc_list", "doc_forget"];
