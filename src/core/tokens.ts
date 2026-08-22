/**
 * Token counting.
 *
 * Everything this server does — packing a recall result, sizing a chunk,
 * deciding when to compact — is a budget decision, so the count has to be
 * roughly right and must never be *under*. Undercounting overflows the model's
 * window and silently truncates the very context we were hired to protect.
 * Every heuristic here therefore leans high.
 *
 * There is no universal tokenizer: Llama, Qwen, Mistral and GPT all split text
 * differently, and bundling one BPE table would be both large and wrong for
 * whatever model the user actually loaded. Instead we estimate cheaply, then
 * calibrate the estimate against the real model when it is reachable.
 */

import type { LlmClient } from './llm.js';

/** Characters that a BPE tokenizer almost always spends one token on. */
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ가-힯]/gu;

export interface Calibration {
  /** Tokens per character for non-CJK text. */
  ratio: number;
  /** Model the ratio was measured against, if known. */
  model: string;
  /** When it was measured (ISO). */
  measuredAt: string;
  /** How it was obtained. */
  source: 'default' | 'configured' | 'measured';
}

export class TokenCounter {
  private calibration: Calibration;
  private calibrating: Promise<void> | null = null;

  constructor(initialRatio: number, source: Calibration['source'] = 'default') {
    this.calibration = {
      ratio: initialRatio,
      model: '',
      measuredAt: new Date().toISOString(),
      source,
    };
  }

  get current(): Calibration {
    return { ...this.calibration };
  }

  load(calibration: Calibration): void {
    this.calibration = calibration;
  }

  /**
   * Estimate the token count of a string.
   *
   * Two independent estimates are taken and the larger wins:
   *   - characters x ratio, which tracks dense text like code and minified JSON
   *     where words are long and whitespace is scarce;
   *   - words x 1.35, which tracks ordinary prose, where BPE lands a bit above
   *     one token per word once punctuation and word-pieces are counted.
   *
   * Taking the max rather than an average is the deliberate conservative
   * choice: whichever kind of text this is, we would rather reserve too much
   * budget than too little.
   */
  estimate(text: string): number {
    if (text.length === 0) return 0;

    const cjkMatches = text.match(CJK);
    const cjkCount = cjkMatches ? cjkMatches.length : 0;
    const rest = cjkCount > 0 ? text.replace(CJK, '') : text;

    const byChars = rest.length * this.calibration.ratio;
    const words = rest.split(/\s+/).filter((w) => w.length > 0).length;
    const byWords = words * 1.35;

    // CJK is roughly one token per character in every tokenizer worth caring
    // about, so it is counted directly rather than run through the ratio.
    return Math.ceil(cjkCount + Math.max(byChars, byWords));
  }

  /** Estimate for a list of strings, including a small per-item separator cost. */
  estimateAll(texts: string[], separatorTokens = 1): number {
    return texts.reduce((sum, t) => sum + this.estimate(t) + separatorTokens, 0);
  }

  /**
   * Measure the real tokens-per-character ratio of the loaded model.
   *
   * A single measurement is useless because `usage.prompt_tokens` includes the
   * chat template's own wrapper — the `<|im_start|>user` scaffolding — which is
   * a fixed cost unrelated to our text. Sending two samples of very different
   * lengths and taking the SLOPE between them cancels that constant out:
   *
   *     ratio = (tokens_long - tokens_short) / (chars_long - chars_short)
   *
   * The result is the marginal token cost per character for this exact model,
   * which is what budget arithmetic actually needs.
   *
   * Failure is not an error: an unreachable endpoint just leaves the default
   * ratio in place, and everything keeps working on estimates.
   */
  async calibrate(llm: LlmClient): Promise<boolean> {
    if (this.calibrating) {
      await this.calibrating;
      return this.calibration.source === 'measured';
    }

    let succeeded = false;
    this.calibrating = (async () => {
      // Prose-like filler, repeated, so the sample resembles real input rather
      // than a pathological string of one repeated character.
      const unit =
        'The quick brown fox jumps over the lazy dog while the committee ' +
        'reviews the quarterly figures and adjourns until Tuesday morning. ';
      const short = unit.repeat(2);
      const long = unit.repeat(20);

      const [shortTokens, longTokens] = await Promise.all([
        llm.promptTokensFor(short),
        llm.promptTokensFor(long),
      ]);

      if (shortTokens === null || longTokens === null) return;

      const deltaTokens = longTokens - shortTokens;
      const deltaChars = long.length - short.length;
      if (deltaChars <= 0 || deltaTokens <= 0) return;

      const ratio = deltaTokens / deltaChars;
      // Sanity-bound the result. Anything outside this range means the endpoint
      // reported something we do not understand, and trusting it would corrupt
      // every budget decision from then on.
      if (ratio < 0.05 || ratio > 2) return;

      this.calibration = {
        // A 4% safety margin, because the slope is measured on prose and code
        // tokenizes slightly denser.
        ratio: ratio * 1.04,
        model: this.calibration.model,
        measuredAt: new Date().toISOString(),
        source: 'measured',
      };
      succeeded = true;
    })();

    try {
      await this.calibrating;
    } finally {
      this.calibrating = null;
    }
    return succeeded;
  }

  /** Trim text so its estimated token count fits a budget. Cuts on a boundary. */
  truncateToBudget(text: string, budgetTokens: number): { text: string; truncated: boolean } {
    if (budgetTokens <= 0) return { text: '', truncated: text.length > 0 };
    if (this.estimate(text) <= budgetTokens) return { text, truncated: false };

    // Convert the budget back to characters, then walk down until it fits.
    // A loop is needed because the max() in estimate() is not invertible.
    let hi = Math.min(text.length, Math.ceil(budgetTokens / this.calibration.ratio) + 64);
    let lo = 0;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.estimate(text.slice(0, mid)) <= budgetTokens) lo = mid;
      else hi = mid - 1;
    }

    let cut = lo;
    // Prefer to end on a paragraph, then a sentence, then a word.
    const window = text.slice(Math.max(0, cut - 200), cut);
    const paragraph = window.lastIndexOf('\n\n');
    const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('.\n'));
    const space = window.lastIndexOf(' ');
    const offset = Math.max(0, cut - 200);
    if (paragraph > 0) cut = offset + paragraph;
    else if (sentence > 0) cut = offset + sentence + 1;
    else if (space > 0) cut = offset + space;

    return { text: text.slice(0, cut).trimEnd(), truncated: true };
  }
}
