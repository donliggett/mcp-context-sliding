/**
 * Tool registration wrapper: uniform error translation and audit logging.
 */
import { ToolError } from '../util/errors.js';
export function defineTool(server, ctx, def) {
    const register = server.registerTool.bind(server);
    register(def.name, { description: def.description, inputSchema: def.schema }, async (rawArgs) => {
        const started = performance.now();
        const args = rawArgs;
        try {
            const result = await def.handler(args, ctx);
            ctx.auditor.log({
                tool: def.name,
                outcome: 'ok',
                durationMs: Math.round(performance.now() - started),
                ...(result.audit ?? {}),
            });
            return { content: [{ type: 'text', text: result.body }] };
        }
        catch (err) {
            const message = err instanceof ToolError
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
    });
}
//# sourceMappingURL=define.js.map