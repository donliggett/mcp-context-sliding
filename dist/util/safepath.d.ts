/**
 * Path containment for file ingestion.
 *
 * Reading files server-side is the point of `doc_ingest`: if the model had to
 * pull a 2 MB log through its own context just to hand it over, the tool would
 * have saved nothing. But that means this server opens paths a model chose,
 * so the same discipline as any filesystem sandbox applies.
 *
 * Ingestion is OFF unless the operator names roots explicitly. The check
 * resolves through `realpath` before deciding, so a symlink planted inside a
 * root cannot point out of it, and containment compares whole path segments so
 * `/data-secret` never matches a root of `/data`.
 */
export declare class IngestSandbox {
    private readonly roots;
    private constructor();
    /** Resolve configured roots to their physical paths, dropping unusable ones. */
    static create(rawRoots: string[]): Promise<IngestSandbox>;
    get enabled(): boolean;
    get allowed(): readonly string[];
    private comparable;
    private within;
    /** Verify a file path and return its physical location. Throws if refused. */
    resolveFile(input: string): Promise<string>;
}
