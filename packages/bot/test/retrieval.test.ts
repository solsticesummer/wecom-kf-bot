import test from 'node:test';
import assert from 'node:assert/strict';
import { cosineSim } from '../src/retrieval.js';

// Pure — always runs. Powers the near-duplicate suppression in search().
test('cosineSim: identical → 1, orthogonal → 0, magnitude-invariant, zero-safe', () => {
  assert.ok(Math.abs(cosineSim([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
  assert.ok(Math.abs(cosineSim([1, 0], [0, 1]) - 0) < 1e-9);
  assert.ok(cosineSim([1, 1], [2, 2]) > 0.999); // same direction, different magnitude
  assert.equal(cosineSim([0, 0], [1, 1]), 0); // zero-vector guard → no NaN
});

// Integration smoke test — needs a live DB (with an indexed corpus) AND a Model Studio
// key for embeddings/rerank. Gated so `npm test` stays green offline with no DB.
const enabled =
  process.env.RUN_DB_TESTS === '1' &&
  !!process.env.DATABASE_URL &&
  !!(process.env.MODELSTUDIO_API_KEY || process.env.DASHSCOPE_API_KEY);

test(
  'search() returns reranked chunks for a KB question',
  { skip: enabled ? false : 'set RUN_DB_TESTS=1 + DATABASE_URL + MODELSTUDIO_API_KEY' },
  async () => {
    const { search } = await import('../src/retrieval.js');
    const { closePool } = await import('../src/db.js');
    try {
      const results = await search('积分怎么充值', { k: 3 });
      assert.ok(Array.isArray(results) && results.length > 0, 'expected at least one chunk');
      for (const r of results) {
        assert.equal(typeof r.content, 'string');
        assert.equal(typeof r.score, 'number');
      }
    } finally {
      await closePool();
    }
  },
);
