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
import { ToolError } from '../util/errors.js';

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

interface TextToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * `registerTool` with its generics erased.
 *
 * The SDK types the callback as a CONDITIONAL type — `BaseToolCallback` picks
 * its shape depending on whether `Args extends StandardSchemaWithJSON`.
 * TypeScript cannot resolve a conditional while its check type is an
 * unresolved generic, so a generic wrapper can never satisfy the overload even
 * though every concrete call site would. Constraining the generic to
 * `StandardSchemaWithJSON` does not help; the conditional stays deferred.
 *
 * Erasing the types at this one boundary is the fix, and costs nothing real:
 * `ToolDefinition` still binds `schema` to `handler` through `S`, so each
 * handler receives fully-typed args inferred from its own Zod schema.
 */
type ErasedRegisterTool = (
  name: string,
  config: { description: string; inputSchema: unknown },
  cb: (args: unknown) => Promise<TextToolResult>,
) => void;

export function defineTool<S extends z.ZodType>(
  server: McpServer,
  ctx: ToolContext,
  def: ToolDefinition<S>,
): void {
  const register = server.registerTool.bind(server) as unknown as ErasedRegisterTool;

  register(
    def.name,
    { description: def.description, inputSchema: def.schema },
    async (rawArgs: unknown): Promise<TextToolResult> => {
      const started = performance.now();
      const args = rawArgs as z.infer<S>;

      try {
        const result = await def.handler(args, ctx);
        ctx.auditor.log({
          tool: def.name,
          outcome: 'ok',
          durationMs: Math.round(performance.now() - started),
          ...(result.audit ?? {}),
        });
        return { content: [{ type: 'text', text: result.body }] };
      } catch (err) {
        const message =
          err instanceof ToolError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);

        ctx.auditor.log({
          tool: def.name,
          outcome: 'error',
          durationMs: Math.round(performance.now() - started),
          detail: err instanceof Error ? (err.stack ?? err.message) : String(err),
        });

        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
