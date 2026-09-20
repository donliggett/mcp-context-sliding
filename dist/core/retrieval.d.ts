/**
 * Retrieval: BM25 keyword scoring, blended with recency, packed to a budget.
 *
 * BM25 rather than raw term-frequency because it does the two things that
 * matter for a mixed store: it discounts terms that appear everywhere (in a
 * codebase, "function" carries almost no signal), and it stops long entries
 * from dominating simply by containing more words.
 *
 * There is no embedding model here by design. Keyword search needs nothing
 * loaded, costs no VRAM, and is fully deterministic — which matters when the
 * whole point is to be predictable about what the model gets to see.
 */
/**
 * Split text into search terms.
 *
 * Identifiers are indexed both whole and split: `getUserName` yields
 * `getusername`, `get`, `user`, `name`. Without that, a query for "user name"
 * would miss every camelCase occurrence in a codebase.
 */
export declare function tokenize(text: string): string[];
export interface Retrievable {
    id: string;
    text: string;
    /** Epoch millis. Used for the recency blend. */
    createdAt: number;
    /** Pinned items bypass scoring and are always included. */
    pinned?: boolean;
    /** Precomputed token count. */
    tokens: number;
}
export interface Scored<T> {
    item: T;
    score: number;
    /** Why it was included, for the audit trail and for explaining results. */
    reason: 'pinned' | 'match' | 'recent';
}
export declare class Bm25Index<T extends Retrievable> {
    private readonly items;
    private readonly termFreqs;
    private readonly docFreq;
    private readonly lengths;
    private avgLength;
    constructor(items: T[]);
    private idf;
    /**
     * Score every item against the query.
     *
     * `recencyWeight` blends in how new an item is, scaled 0..1 across the set.
     * For a working-memory store this matters a lot: the note written two minutes
     * ago about the current bug is usually more useful than an equally-worded one
     * from last week.
     */
    search(query: string, options?: {
        recencyWeight?: number;
        now?: number;
    }): Array<Scored<T>>;
}
export interface PackResult<T> {
    selected: Array<Scored<T>>;
    usedTokens: number;
    /** Items that scored but did not fit. */
    omitted: number;
}
/**
 * Greedily take the highest-scoring items that fit the budget.
 *
 * Skips over an oversized item rather than stopping at it: one 900-token entry
 * should not block five 100-token entries that would all have fitted. Pinned
 * items are taken first and are allowed to consume the whole budget, because
 * the user explicitly said they matter.
 */
export declare function packToBudget<T extends Retrievable>(scored: Array<Scored<T>>, budgetTokens: number): PackResult<T>;
