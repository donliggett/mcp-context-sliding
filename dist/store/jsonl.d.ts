/**
 * Append-only JSONL persistence.
 *
 * Every mutation is a new line rather than a rewrite of the file. That buys
 * three things worth more than the disk space: a crash mid-write can corrupt at
 * most the final line (which is skipped on load, not fatal), the history of how
 * the context evolved stays inspectable with `tail`, and appends never race
 * with a concurrent read the way a read-modify-write cycle does.
 *
 * State is reconstructed by replaying the log — the last record wins.
 */
export declare function withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
export declare function assertSafeId(id: string, label: string): void;
/** Generate a short, sortable, collision-resistant id. */
export declare function newId(prefix: string): string;
export declare function ensureDir(dir: string): Promise<void>;
/** Append one record as a single line. */
export declare function appendRecord(file: string, record: unknown): Promise<void>;
/** Append several records in one write, so a batch cannot tear mid-way. */
export declare function appendRecords(file: string, records: unknown[]): Promise<void>;
/**
 * Read every well-formed record from a log.
 *
 * A malformed final line is dropped silently: that is the signature of a
 * process killed mid-append, and refusing to load an entire session because
 * of one torn trailing line would be the wrong trade. Malformed lines
 * elsewhere are also skipped, but counted, so callers can warn.
 */
export declare function readRecords<T>(file: string): Promise<{
    records: T[];
    skipped: number;
}>;
/**
 * Write a small JSON document atomically (temp file, fsync, rename).
 *
 * Serialized per destination, because two concurrent writes to the same path
 * would otherwise race on the temp file. The temp name is also made unique per
 * call — the PID alone is not enough when one process writes twice at once, and
 * a leftover temp from a crashed run would make every later write fail `wx`.
 */
export declare function writeJson(file: string, value: unknown): Promise<void>;
export declare function readJson<T>(file: string): Promise<T | null>;
export declare function listDirs(dir: string): Promise<string[]>;
export declare function removeDir(dir: string): Promise<void>;
