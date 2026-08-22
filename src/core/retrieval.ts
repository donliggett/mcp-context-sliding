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

const STOPWORDS = new Set([
  'a', 'about', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can',
  'could', 'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'he', 'her',
  'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'no',
  'not', 'of', 'on', 'or', 'our', 's', 'she', 'so', 'than', 'that', 'the',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'up', 'was',
  'we', 'were', 'what', 'when', 'which', 'who', 'why', 'will', 'with', 'would',
  'you', 'your',
]);

/**
 * Split text into search terms.
 *
 * Identifiers are indexed both whole and split: `getUserName` yields
 * `getusername`, `get`, `user`, `name`. Without that, a query for "user name"
 * would miss every camelCase occurrence in a codebase.
 */
export function tokenize(text: string): string[] {
  const terms: string[] = [];
  const raw = text.toLowerCase().match(/[a-z0-9_$]+/g) ?? [];

  for (const word of raw) {
    if (word.length < 2 || STOPWORDS.has(word)) continue;
    terms.push(word);

    if (word.includes('_')) {
      for (const part of word.split('_')) {
        if (part.length >= 2 && !STOPWORDS.has(part)) terms.push(part);
      }
    }
  }

  // camelCase / PascalCase splitting works on the original casing.
  for (const word of text.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []) {
    const parts = word.split(/(?<=[a-z0-9])(?=[A-Z])/);
    if (parts.length > 1) {
      for (const part of parts) {
        const lower = part.toLowerCase();
        if (lower.length >= 2 && !STOPWORDS.has(lower)) terms.push(lower);
      }
    }
  }

  return terms;
}

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

const K1 = 1.2;
const B = 0.75;

export class Bm25Index<T extends Retrievable> {
  private readonly items: T[];
  private readonly termFreqs: Array<Map<string, number>> = [];
  private readonly docFreq = new Map<string, number>();
  private readonly lengths: number[] = [];
  private avgLength = 0;

  constructor(items: T[]) {
    this.items = items;

    for (const item of items) {
      const terms = tokenize(item.text);
      const freq = new Map<string, number>();
      for (const term of terms) freq.set(term, (freq.get(term) ?? 0) + 1);
      this.termFreqs.push(freq);
      this.lengths.push(terms.length);
      for (const term of freq.keys()) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      }
    }

    const total = this.lengths.reduce((a, b) => a + b, 0);
    this.avgLength = items.length > 0 ? total / items.length : 0;
  }

  private idf(term: string): number {
    const n = this.items.length;
    const df = this.docFreq.get(term) ?? 0;
    // Standard BM25 IDF with the +1 that keeps it non-negative for terms
    // present in most documents.
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /**
   * Score every item against the query.
   *
   * `recencyWeight` blends in how new an item is, scaled 0..1 across the set.
   * For a working-memory store this matters a lot: the note written two minutes
   * ago about the current bug is usually more useful than an equally-worded one
   * from last week.
   */
  search(query: string, options: { recencyWeight?: number; now?: number } = {}): Array<Scored<T>> {
    const recencyWeight = options.recencyWeight ?? 0.25;
    const now = options.now ?? Date.now();
    const queryTerms = [...new Set(tokenize(query))];

    const times = this.items.map((i) => i.createdAt);
    const oldest = times.length > 0 ? Math.min(...times) : now;
    const span = Math.max(1, now - oldest);

    const results: Array<Scored<T>> = [];

    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i]!;
      if (item.pinned) {
        results.push({ item, score: Number.POSITIVE_INFINITY, reason: 'pinned' });
        continue;
      }

      let score = 0;
      if (queryTerms.length > 0) {
        const freq = this.termFreqs[i]!;
        const length = this.lengths[i]!;
        for (const term of queryTerms) {
          const tf = freq.get(term) ?? 0;
          if (tf === 0) continue;
          const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * (length / (this.avgLength || 1))));
          score += this.idf(term) * norm;
        }
      }

      const recency = (item.createdAt - oldest) / span;

      if (score > 0) {
        results.push({ item, score: score * (1 + recencyWeight * recency), reason: 'match' });
      } else if (queryTerms.length === 0) {
        // An empty query means "give me what matters most", which reduces to
        // pure recency ordering.
        results.push({ item, score: recency, reason: 'recent' });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }
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
export function packToBudget<T extends Retrievable>(
  scored: Array<Scored<T>>,
  budgetTokens: number,
): PackResult<T> {
  const selected: Array<Scored<T>> = [];
  let used = 0;
  let omitted = 0;

  for (const entry of scored) {
    if (used + entry.item.tokens <= budgetTokens) {
      selected.push(entry);
      used += entry.item.tokens;
    } else {
      omitted++;
    }
  }

  return { selected, usedTokens: used, omitted };
}
