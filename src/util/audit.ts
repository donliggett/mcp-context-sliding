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

export class Auditor {
  constructor(private readonly enabled: boolean) {}

  log(entry: AuditEntry): void {
    if (!this.enabled) return;
    process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  }

  info(message: string, fields: Record<string, unknown> = {}): void {
    process.stderr.write(
      JSON.stringify({ ts: new Date().toISOString(), level: 'info', message, ...fields }) + '\n',
    );
  }

  error(message: string, fields: Record<string, unknown> = {}): void {
    process.stderr.write(
      JSON.stringify({ ts: new Date().toISOString(), level: 'error', message, ...fields }) + '\n',
    );
  }
}

export function protectStdout(auditor: Auditor): void {
  const reroute =
    (level: string) =>
    (...args: unknown[]): void => {
      auditor.error('console output redirected from stdout', {
        level,
        text: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
      });
    };
  console.log = reroute('log');
  console.info = reroute('info');
  console.debug = reroute('debug');
}
