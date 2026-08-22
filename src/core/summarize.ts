/**
 * Summarization, with a local LLM when one is reachable and a purely
 * algorithmic fallback when it is not.
 *
 * The fallback is not a token gesture. A summarizer that throws when LM Studio
 * happens to have no model loaded would take the whole context store down with
 * it, and losing access to stored context is a worse failure than getting a
 * cruder summary of it. Extractive output is always available, always instant,
 * and never hallucinates — it can only pick sentences that were really there.
 */

import type { LlmClient } from './llm.js';
import { LlmUnavailableError } from './llm.js';
import type { TokenCounter } from './tokens.js';
import { chunkText } from './chunk.js';

export type SummaryMethod = 'llm' | 'extractive';

export interface SummaryResult {
  text: string;
  method: SummaryMethod;
  /** Set when the LLM was tried and failed, so callers can surface why. */
  fallbackReason?: string;
  /** How many map-reduce passes ran. 1 means the text fitted in one call. */
  passes: number;
}

export interface SummarizeOptions {
  /** Rough size of the summary to aim for. */
  targetTokens: number;
  /** What the summary is for; steers the prompt. */
  instruction?: string;
}

const DEFAULT_INSTRUCTION =
  'Summarize the material below. Preserve concrete details — names, numbers, ' +
  'file paths, identifiers, decisions and open questions. Drop pleasantries ' +
  'and repetition. Do not add anything that is not present in the source.';

/** Beyond this many tokens, a single call is split into map-reduce passes. */
const SINGLE_PASS_LIMIT = 6000;

export class Summarizer {
  constructor(
    private readonly llm: LlmClient,
    private readonly counter: TokenCounter,
  ) {}

  async summarize(text: string, options: SummarizeOptions): Promise<SummaryResult> {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return { text: '', method: 'extractive', passes: 0 };
    }

    // Already short enough — summarizing would lose detail for no gain.
    if (this.counter.estimate(trimmed) <= options.targetTokens) {
      return { text: trimmed, method: 'extractive', passes: 0 };
    }

    if (this.llm.enabled) {
      try {
        return await this.llmSummarize(trimmed, options);
      } catch (err) {
        const reason =
          err instanceof LlmUnavailableError ? err.message : String(err);
        const extractive = this.extractive(trimmed, options.targetTokens);
        return { ...extractive, fallbackReason: reason };
      }
    }

    return this.extractive(trimmed, options.targetTokens);
  }

  private async llmSummarize(text: string, options: SummarizeOptions): Promise<SummaryResult> {
    const tokens = this.counter.estimate(text);

    if (tokens <= SINGLE_PASS_LIMIT) {
      const result = await this.callModel(text, options);
      return { text: result, method: 'llm', passes: 1 };
    }

    // Map-reduce: summarize each slice, then summarize the slice summaries.
    // Slices are sized so that one comfortably fits a small local model's
    // window alongside the prompt and the generated output.
    const slices = chunkText(text, this.counter, {
      chunkTokens: Math.min(SINGLE_PASS_LIMIT - 1000, 3000),
      overlapTokens: 100,
    });

    const perSliceTarget = Math.max(
      120,
      Math.floor((options.targetTokens * 2) / Math.max(1, slices.length)),
    );

    const partials: string[] = [];
    for (const slice of slices) {
      // Sequential, not parallel: a local server usually has one model loaded
      // and concurrent requests just queue while multiplying memory pressure.
      partials.push(
        await this.callModel(slice.text, {
          targetTokens: perSliceTarget,
          instruction:
            (options.instruction ?? DEFAULT_INSTRUCTION) +
            ' This is one section of a longer document; summarize only this section.',
        }),
      );
    }

    const combined = partials.join('\n\n');
    if (this.counter.estimate(combined) <= options.targetTokens) {
      return { text: combined, method: 'llm', passes: 2 };
    }

    const reduced = await this.callModel(combined, {
      targetTokens: options.targetTokens,
      instruction:
        (options.instruction ?? DEFAULT_INSTRUCTION) +
        ' The material below is a set of section summaries from one document; ' +
        'merge them into a single coherent summary without repeating points.',
    });

    return { text: reduced, method: 'llm', passes: 3 };
  }

  private async callModel(text: string, options: SummarizeOptions): Promise<string> {
    const instruction = options.instruction ?? DEFAULT_INSTRUCTION;
    const result = await this.llm.chat(
      [
        {
          role: 'system',
          content:
            'You are a summarization engine. You output only the summary itself — ' +
            'no preamble, no "Here is a summary", no commentary on the task.',
        },
        {
          role: 'user',
          content: `${instruction}\n\nAim for roughly ${options.targetTokens} tokens.\n\n---\n${text}\n---`,
        },
      ],
      // Headroom over the target so the model is not cut off mid-sentence.
      { maxTokens: Math.ceil(options.targetTokens * 1.5), temperature: 0.2 },
    );
    return result.text;
  }

  /**
   * Extractive summarization by TF-ISF sentence scoring.
   *
   * Each sentence scores as the summed rarity of the words it contains, so a
   * sentence full of terms that recur across the text but not in every single
   * sentence — the topical words — outranks both boilerplate and one-off
   * asides. Length-normalized, or long sentences would win automatically.
   * Selected sentences are re-emitted in their original order so the result
   * still reads as a narrative.
   */
  private extractive(text: string, targetTokens: number): SummaryResult {
    const sentences = splitSentences(text);
    if (sentences.length <= 1) {
      return { text: this.counter.truncateToBudget(text, targetTokens).text, method: 'extractive', passes: 1 };
    }

    const sentenceTerms = sentences.map((s) => new Set(termsOf(s)));
    const documentFreq = new Map<string, number>();
    for (const terms of sentenceTerms) {
      for (const term of terms) documentFreq.set(term, (documentFreq.get(term) ?? 0) + 1);
    }

    const total = sentences.length;
    const scores = sentences.map((sentence, i) => {
      const terms = termsOf(sentence);
      if (terms.length === 0) return { index: i, score: 0 };

      let score = 0;
      for (const term of terms) {
        const df = documentFreq.get(term) ?? 1;
        score += Math.log(total / df) + 1;
      }
      score /= Math.sqrt(terms.length);

      // Opening sentences disproportionately state the topic; give the first
      // few a modest edge so summaries do not start mid-argument.
      if (i < 3) score *= 1.15;
      return { index: i, score };
    });

    const chosen: number[] = [];
    let used = 0;
    for (const { index } of [...scores].sort((a, b) => b.score - a.score)) {
      const cost = this.counter.estimate(sentences[index]!);
      if (used + cost > targetTokens) continue;
      chosen.push(index);
      used += cost;
      if (used >= targetTokens * 0.9) break;
    }

    if (chosen.length === 0) {
      return {
        text: this.counter.truncateToBudget(text, targetTokens).text,
        method: 'extractive',
        passes: 1,
      };
    }

    chosen.sort((a, b) => a - b);
    return {
      text: chosen.map((i) => sentences[i]!.trim()).join(' '),
      method: 'extractive',
      passes: 1,
    };
  }
}

/**
 * Split into sentences without a full NLP model.
 *
 * The lookbehind guards against the common abbreviations that would otherwise
 * fragment every summary ("e.g.", "Dr.", "vs.") and against decimal points.
 */
export function splitSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return [];

  const parts = normalized.split(
    /(?<!\b(?:e\.g|i\.e|vs|etc|Dr|Mr|Mrs|Ms|Prof|Fig|No|approx)\.)(?<!\b[A-Z])(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/,
  );

  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function termsOf(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_$]{3,}/g) ?? []).filter(
    (w) => !/^\d+$/.test(w),
  );
}
