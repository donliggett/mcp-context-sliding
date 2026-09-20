/**
 * Document tools — the paging half of the server.
 *
 * The pattern these are designed around: ingest once, read the outline, then
 * pull only the windows you actually need. A 400 KB log becomes a 300-token
 * outline plus a handful of targeted reads, instead of an instant overflow.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { type ToolContext } from './define.js';
export declare function registerDocumentTools(server: McpServer, ctx: ToolContext): void;
