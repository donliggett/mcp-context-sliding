/**
 * Structured logging to stderr.
 *
 * Never stdout: under the stdio transport that is the JSON-RPC channel, and a
 * single stray write corrupts the stream and silently drops the connection.
 * `protectStdout` enforces the rule rather than leaving it to discipline.
 */
export class Auditor {
    enabled;
    constructor(enabled) {
        this.enabled = enabled;
    }
    log(entry) {
        if (!this.enabled)
            return;
        process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
    }
    info(message, fields = {}) {
        process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: 'info', message, ...fields }) + '\n');
    }
    error(message, fields = {}) {
        process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: 'error', message, ...fields }) + '\n');
    }
}
export function protectStdout(auditor) {
    const reroute = (level) => (...args) => {
        auditor.error('console output redirected from stdout', {
            level,
            text: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
        });
    };
    console.log = reroute('log');
    console.info = reroute('info');
    console.debug = reroute('debug');
}
//# sourceMappingURL=audit.js.map