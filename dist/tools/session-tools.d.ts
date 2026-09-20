/**
 * Session tools — the working-memory half of the server.
 *
 * The tool descriptions carry more weight here than in most servers. A host
 * cannot be given standing instructions (MCP has no mechanism for it, and the
 * v2 `McpServer` exposes no `instructions` field), so the descriptions are the
 * only place to teach the model when to reach for these. They are written to
 * be prescriptive rather than merely descriptive.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { type ToolContext } from './define.js';
export declare function registerSessionTools(server: McpServer, ctx: ToolContext): void;
