import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSystemRules, DRAMACLAW } from '../src/prompt.js';

// Golden-fixture lock: the composed DramaClaw prompt must stay byte-identical to
// the prompt the bot shipped with. Any drift here is a prompt-behavior change and
// must be intentional (update the fixture deliberately), not a refactor accident.
const golden = readFileSync(
  new URL('./fixtures/dramaclaw-system-rules.txt', import.meta.url),
  'utf8',
).replace(/\n$/, ''); // tolerate a single trailing newline the file may carry

test('buildSystemRules(DRAMACLAW) reproduces the shipped prompt byte-for-byte', () => {
  assert.equal(buildSystemRules(DRAMACLAW), golden);
});

test('a different tenant swaps productName and domainTerms, structure intact', () => {
  const out = buildSystemRules({ productName: 'Acme', domainTerms: 'X、Y、Z' });
  assert.ok(out.includes('只回答与 Acme 产品相关的问题'));
  assert.ok(out.includes('（如 X、Y、Z等）'));
  assert.ok(!out.includes('DramaClaw'));
});
