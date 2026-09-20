/**
 * Structured logging to stderr.
 *
 * Never stdout: under the stdio transport that is the JSON-RPC channel, and a
 * single stray write corrupts the stream and silently drops the connection.
 * `protectStdout` enforces the rule rather than leaving it to discipline.
 */
export type Outcome = 'ok' | 'error';
export interface AuditEntry {
    tool: string;
    outcome: Outcome;
    durationMs: number;
    detail?: string;
    [key: string]: unknown;
}
export declare class Auditor {
    private readonly enabled;
    constructor(enabled: boolean);
    log(entry: AuditEntry): void;
    info(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
}
export declare function protectStdout(auditor: Auditor): void;
