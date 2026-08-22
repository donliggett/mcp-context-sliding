/**
 * Structure-aware chunking.
 *
 * Naive fixed-size chunking cuts through the middle of sentences, code blocks
 * and tables, and the resulting fragments summarize and retrieve badly. This
 * splits on the document's own structure first — headings, paragraphs, fenced
 * code — and only falls back to a hard character cut for a single block that
 * is genuinely larger than a whole chunk.
 *
 * Each chunk also carries the heading trail it sits under, which is what makes
 * `doc_outline` readable and gives retrieval results somewhere to anchor.
 */

import type { TokenCounter } from './tokens.js';

export interface Chunk {
  index: number;
  text: string;
  tokens: number;
  startChar: number;
  endChar: number;
  /** Heading breadcrumb, e.g. "Install > Windows". Empty for unstructured text. */
  heading: string;
}

export interface ChunkOptions {
  chunkTokens: number;
  overlapTokens: number;
}

interface Block {
  text: string;
  start: number;
  end: number;
  /** Heading level if this block is a heading (1-6), else 0. */
  headingLevel: number;
  headingText: string;
}

const FENCE = /^(?:```|~~~)/;
const ATX_HEADING = /^(#{1,6})\s+(.*)$/;

/**
 * Split source text into structural blocks, preserving byte offsets.
 * Fenced code blocks are emitted whole, however long they are.
 */
function splitBlocks(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];

  let offset = 0;
  let buffer: string[] = [];
  let bufferStart = 0;
  let inFence = false;

  const flush = (end: number) => {
    if (buffer.length === 0) return;
    const body = buffer.join('\n');
    if (body.trim().length > 0) {
      blocks.push({ text: body, start: bufferStart, end, headingLevel: 0, headingText: '' });
    }
    buffer = [];
  };

  for (const line of lines) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    offset = lineEnd + 1; // +1 for the newline consumed by split

    if (FENCE.test(line.trim())) {
      if (!inFence) {
        // Opening a fence: everything buffered so far is a separate block.
        flush(lineStart);
        bufferStart = lineStart;
        inFence = true;
        buffer.push(line);
      } else {
        // Closing a fence: emit the code block intact.
        buffer.push(line);
        const body = buffer.join('\n');
        blocks.push({ text: body, start: bufferStart, end: lineEnd, headingLevel: 0, headingText: '' });
        buffer = [];
        inFence = false;
        bufferStart = offset;
      }
      continue;
    }

    if (inFence) {
      buffer.push(line);
      continue;
    }

    const heading = ATX_HEADING.exec(line);
    if (heading) {
      flush(lineStart);
      blocks.push({
        text: line,
        start: lineStart,
        end: lineEnd,
        headingLevel: heading[1]!.length,
        headingText: heading[2]!.trim(),
      });
      bufferStart = offset;
      continue;
    }

    if (line.trim() === '') {
      flush(lineStart);
      bufferStart = offset;
      continue;
    }

    if (buffer.length === 0) bufferStart = lineStart;
    buffer.push(line);
  }

  flush(offset);
  return blocks;
}

/** Maintain a heading breadcrumb as we walk the document. */
function updateTrail(trail: string[], level: number, text: string): string[] {
  const next = trail.slice(0, Math.max(0, level - 1));
  next[level - 1] = text;
  return next.filter((t) => t !== undefined && t !== '');
}

/**
 * Hard-split a block that exceeds a whole chunk on its own — a giant code
 * block, a minified file, a table with no blank lines. Splits on line
 * boundaries when it can, character boundaries when it cannot.
 */
function hardSplit(
  block: Block,
  counter: TokenCounter,
  chunkTokens: number,
): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  const lines = block.text.split('\n');

  let current: string[] = [];
  let currentTokens = 0;
  let start = block.start;
  let cursor = block.start;

  const flush = () => {
    if (current.length === 0) return;
    const body = current.join('\n');
    out.push({ text: body, start, end: start + body.length });
    current = [];
    currentTokens = 0;
  };

  for (const line of lines) {
    const lineTokens = counter.estimate(line);

    // A single line bigger than a chunk (minified JS, base64 blob) must be
    // cut mid-line; there is no structural boundary left to respect.
    if (lineTokens > chunkTokens) {
      flush();
      let remaining = line;
      let localStart = cursor;
      while (remaining.length > 0) {
        const piece = counter.truncateToBudget(remaining, chunkTokens);
        const taken = piece.text.length > 0 ? piece.text : remaining.slice(0, 1000);
        out.push({ text: taken, start: localStart, end: localStart + taken.length });
        localStart += taken.length;
        remaining = remaining.slice(taken.length);
      }
      cursor += line.length + 1;
      start = cursor;
      continue;
    }

    if (currentTokens + lineTokens > chunkTokens && current.length > 0) {
      flush();
      start = cursor;
    }
    if (current.length === 0) start = cursor;
    current.push(line);
    currentTokens += lineTokens;
    cursor += line.length + 1;
  }

  flush();
  return out;
}

export function chunkText(text: string, counter: TokenCounter, options: ChunkOptions): Chunk[] {
  const { chunkTokens, overlapTokens } = options;
  const blocks = splitBlocks(text);
  const chunks: Chunk[] = [];

  let trail: string[] = [];
  let pending: Array<{ text: string; start: number; end: number; tokens: number }> = [];
  let pendingTokens = 0;
  let pendingTrail = '';

  const emit = () => {
    if (pending.length === 0) return;
    const body = pending.map((p) => p.text).join('\n\n');
    chunks.push({
      index: chunks.length,
      text: body,
      tokens: counter.estimate(body),
      startChar: pending[0]!.start,
      endChar: pending[pending.length - 1]!.end,
      heading: pendingTrail,
    });

    // Carry the tail of this chunk into the next one so a fact spanning a
    // boundary is retrievable from either side.
    if (overlapTokens > 0) {
      const carried: typeof pending = [];
      let carriedTokens = 0;
      for (let i = pending.length - 1; i >= 0; i--) {
        const piece = pending[i]!;
        if (carriedTokens + piece.tokens > overlapTokens) break;
        carried.unshift(piece);
        carriedTokens += piece.tokens;
      }
      // Never carry the entire chunk, or chunking cannot advance.
      pending = carried.length < pending.length ? carried : [];
      pendingTokens = pending.reduce((s, p) => s + p.tokens, 0);
    } else {
      pending = [];
      pendingTokens = 0;
    }
  };

  for (const block of blocks) {
    if (block.headingLevel > 0) {
      trail = updateTrail(trail, block.headingLevel, block.headingText);
      // A heading starts a new chunk when the current one already has content,
      // so sections do not bleed together.
      if (pendingTokens > chunkTokens * 0.5) emit();
    }

    const blockTokens = counter.estimate(block.text);

    if (blockTokens > chunkTokens) {
      emit();
      pendingTrail = trail.join(' > ');
      for (const piece of hardSplit(block, counter, chunkTokens)) {
        chunks.push({
          index: chunks.length,
          text: piece.text,
          tokens: counter.estimate(piece.text),
          startChar: piece.start,
          endChar: piece.end,
          heading: pendingTrail,
        });
      }
      pending = [];
      pendingTokens = 0;
      continue;
    }

    if (pendingTokens + blockTokens > chunkTokens && pending.length > 0) {
      emit();
    }

    if (pending.length === 0) pendingTrail = trail.join(' > ');
    pending.push({ text: block.text, start: block.start, end: block.end, tokens: blockTokens });
    pendingTokens += blockTokens;
  }

  emit();

  // A final emit() can leave carried-over overlap behind; flush it as its own
  // chunk only if it holds content the previous chunk did not already cover.
  if (pending.length > 0) {
    const body = pending.map((p) => p.text).join('\n\n');
    const last = chunks[chunks.length - 1];
    if (!last || !last.text.endsWith(body)) {
      chunks.push({
        index: chunks.length,
        text: body,
        tokens: counter.estimate(body),
        startChar: pending[0]!.start,
        endChar: pending[pending.length - 1]!.end,
        heading: pendingTrail,
      });
    }
  }

  return chunks;
}
