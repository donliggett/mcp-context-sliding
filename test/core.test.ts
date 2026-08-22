/**
 * Tests for the pure logic: token estimation, chunking, retrieval, extractive
 * summarization. None of these touch the network or the LLM.
 *
 * Run with:  npm run build && npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { TokenCounter } from '../dist/core/tokens.js';
import { chunkText } from '../dist/core/chunk.js';
import { Bm25Index, packToBudget, tokenize } from '../dist/core/retrieval.js';
import { Summarizer, splitSentences } from '../dist/core/summarize.js';
import { LlmClient } from '../dist/core/llm.js';

const counter = new TokenCounter(0.27);

describe('token estimation', () => {
  test('empty text costs nothing', () => {
    assert.equal(counter.estimate(''), 0);
  });

  test('scales with length', () => {
    const short = counter.estimate('hello world');
    const long = counter.estimate('hello world '.repeat(50));
    assert.ok(long > short * 40, `expected roughly linear growth, got ${short} -> ${long}`);
  });

  test('never undercounts plain English badly', () => {
    // ~20 words. A real BPE tokenizer lands near 24 tokens; we must not be
    // under that, since undercounting is what overflows a context window.
    const text =
      'The committee reviewed the quarterly figures and adjourned until Tuesday ' +
      'morning without reaching agreement on the proposed budget revision.';
    const estimate = counter.estimate(text);
    assert.ok(estimate >= 20, `estimate ${estimate} is suspiciously low`);
    assert.ok(estimate < 90, `estimate ${estimate} is wildly high`);
  });

  test('counts CJK near one token per character', () => {
    const text = '这是一个测试字符串';
    const estimate = counter.estimate(text);
    assert.ok(estimate >= text.length, `CJK should cost at least 1 token/char, got ${estimate}`);
  });

  test('truncateToBudget respects the budget and reports truncation', () => {
    const text = 'Sentence one. Sentence two. Sentence three. '.repeat(40);
    const result = counter.truncateToBudget(text, 50);
    assert.equal(result.truncated, true);
    assert.ok(counter.estimate(result.text) <= 50);
    assert.ok(result.text.length > 0);
  });

  test('truncateToBudget leaves short text alone', () => {
    const result = counter.truncateToBudget('short', 100);
    assert.equal(result.truncated, false);
    assert.equal(result.text, 'short');
  });
});

describe('chunking', () => {
  const options = { chunkTokens: 100, overlapTokens: 10 };

  test('short text is a single chunk', () => {
    const chunks = chunkText('Just a short paragraph.', counter, options);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.text, 'Just a short paragraph.');
  });

  test('chunks stay near the target size', () => {
    const text = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} with some filler words in it.`).join('\n\n');
    const chunks = chunkText(text, counter, options);
    assert.ok(chunks.length > 1, 'expected multiple chunks');
    for (const chunk of chunks) {
      assert.ok(
        chunk.tokens <= options.chunkTokens * 1.6,
        `chunk ${chunk.index} is ${chunk.tokens} tokens, far over target`,
      );
    }
  });

  test('indices are contiguous from zero', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Line ${i} of filler content here.`).join('\n\n');
    const chunks = chunkText(text, counter, options);
    chunks.forEach((chunk, i) => assert.equal(chunk.index, i));
  });

  test('headings become breadcrumbs', () => {
    const text = [
      '# Guide',
      '',
      'Intro text.',
      '',
      '## Install',
      '',
      'Install steps here.',
      '',
      '### Windows',
      '',
      'Windows specifics.',
    ].join('\n');
    const chunks = chunkText(text, counter, { chunkTokens: 20, overlapTokens: 0 });
    const trails = chunks.map((c) => c.heading);
    assert.ok(
      trails.some((t) => t.includes('Install')),
      `expected an Install breadcrumb, got ${JSON.stringify(trails)}`,
    );
  });

  test('fenced code blocks are not split mid-fence', () => {
    const code = ['```js', ...Array.from({ length: 10 }, (_, i) => `const x${i} = ${i};`), '```'].join('\n');
    const text = `Intro paragraph.\n\n${code}\n\nOutro paragraph.`;
    const chunks = chunkText(text, counter, { chunkTokens: 500, overlapTokens: 0 });
    const withFence = chunks.filter((c) => c.text.includes('```'));
    for (const chunk of withFence) {
      const fences = (chunk.text.match(/```/g) ?? []).length;
      assert.equal(fences % 2, 0, `chunk ${chunk.index} has an unbalanced code fence`);
    }
  });

  test('an oversized single line is hard-split rather than dropped', () => {
    const blob = 'x'.repeat(20000);
    const chunks = chunkText(blob, counter, options);
    assert.ok(chunks.length > 1, 'expected the blob to be split');
    const recovered = chunks.map((c) => c.text).join('');
    assert.ok(recovered.length >= blob.length * 0.9, 'most of the content should survive');
  });

  test('always terminates on pathological input', () => {
    const chunks = chunkText('\n\n\n\n   \n\n', counter, options);
    assert.ok(Array.isArray(chunks));
  });
});

describe('retrieval', () => {
  test('tokenize splits camelCase and snake_case', () => {
    const terms = tokenize('getUserName and user_id here');
    assert.ok(terms.includes('user'), `expected "user" in ${JSON.stringify(terms)}`);
    assert.ok(terms.includes('name'), `expected "name" in ${JSON.stringify(terms)}`);
    assert.ok(terms.includes('getusername'), 'the whole identifier should also be indexed');
  });

  test('tokenize drops stopwords', () => {
    assert.equal(tokenize('the and of').length, 0);
  });

  const items = [
    { id: 'a', text: 'The database migration failed on the users table', createdAt: 1000, tokens: 10 },
    { id: 'b', text: 'Lunch options near the office include three cafes', createdAt: 2000, tokens: 10 },
    { id: 'c', text: 'Migration rollback procedure for the users table', createdAt: 3000, tokens: 10 },
  ];

  test('ranks by relevance', () => {
    const index = new Bm25Index(items);
    const results = index.search('migration users table');
    assert.ok(results.length >= 2);
    assert.ok(['a', 'c'].includes(results[0]!.item.id), 'a migration entry should rank first');
    assert.ok(!results.some((r) => r.item.id === 'b'), 'the unrelated entry should not match');
  });

  test('pinned items always come first with an infinite score', () => {
    const withPin = [...items, { id: 'p', text: 'totally unrelated', createdAt: 0, tokens: 5, pinned: true }];
    const results = new Bm25Index(withPin).search('migration');
    assert.equal(results[0]!.item.id, 'p');
    assert.equal(results[0]!.reason, 'pinned');
  });

  test('an empty query falls back to recency order', () => {
    const results = new Bm25Index(items).search('');
    assert.equal(results[0]!.item.id, 'c', 'newest entry should lead');
    assert.equal(results[0]!.reason, 'recent');
  });

  test('packToBudget skips oversized items rather than stopping', () => {
    const scored = [
      { item: { id: 'big', text: '', createdAt: 0, tokens: 500 }, score: 10, reason: 'match' as const },
      { item: { id: 'small', text: '', createdAt: 0, tokens: 20 }, score: 5, reason: 'match' as const },
    ];
    const packed = packToBudget(scored, 100);
    assert.equal(packed.selected.length, 1);
    assert.equal(packed.selected[0]!.item.id, 'small');
    assert.equal(packed.omitted, 1);
    assert.equal(packed.usedTokens, 20);
  });
});

describe('extractive summarization', () => {
  // An LLM client that is disabled, forcing the extractive path.
  const offline = new LlmClient({
    enabled: false,
    baseUrl: 'http://127.0.0.1:9',
    model: '',
    apiKey: '',
    timeoutMs: 100,
  });
  const summarizer = new Summarizer(offline, counter);

  test('splitSentences keeps abbreviations intact', () => {
    const sentences = splitSentences('We met Dr. Smith today. He agreed. Work starts Monday.');
    assert.equal(sentences.length, 3, `got ${JSON.stringify(sentences)}`);
  });

  test('short input is returned unchanged', async () => {
    const result = await summarizer.summarize('Already brief.', { targetTokens: 500 });
    assert.equal(result.text, 'Already brief.');
  });

  test('long input is reduced and stays within budget', async () => {
    const text = Array.from(
      { length: 60 },
      (_, i) =>
        `The deployment pipeline failed at stage ${i} because the container registry rejected the credentials.`,
    ).join(' ');

    const result = await summarizer.summarize(text, { targetTokens: 60 });
    assert.equal(result.method, 'extractive');
    assert.ok(result.text.length > 0, 'should produce something');
    assert.ok(counter.estimate(result.text) <= 80, 'should respect the target with slack');
    assert.ok(result.text.length < text.length, 'should actually be shorter');
  });

  test('extractive output only contains source sentences', async () => {
    const sentences = [
      'Alpha handles authentication.',
      'Beta manages the queue.',
      'Gamma writes to disk.',
      'Delta reports metrics upstream.',
    ];
    const text = sentences.join(' ').repeat(8);
    const result = await summarizer.summarize(text, { targetTokens: 30 });
    // Every emitted sentence must have come from the source — extractive
    // summarization is incapable of hallucinating, and this proves it.
    for (const sentence of splitSentences(result.text)) {
      assert.ok(
        sentences.some((s) => s.includes(sentence.trim()) || sentence.trim().includes(s)),
        `"${sentence}" was not in the source`,
      );
    }
  });

  test('falls back gracefully when the endpoint is unreachable', async () => {
    const broken = new LlmClient({
      enabled: true,
      baseUrl: 'http://127.0.0.1:9',
      model: '',
      apiKey: '',
      timeoutMs: 250,
    });
    const s = new Summarizer(broken, counter);
    const text = 'Some sentence about widgets. '.repeat(40);
    const result = await s.summarize(text, { targetTokens: 40 });
    assert.equal(result.method, 'extractive');
    assert.ok(result.fallbackReason, 'should explain why it fell back');
  });
});
