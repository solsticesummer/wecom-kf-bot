import test from 'node:test';
import assert from 'node:assert/strict';
import { truncateUtf8 } from '../src/wecom.js';

test('short strings pass through untouched', () => {
  assert.equal(truncateUtf8('hello 你好', 2000), 'hello 你好');
});

test('long strings are trimmed under the byte limit', () => {
  const long = 'a'.repeat(3000);
  const out = truncateUtf8(long, 2000);
  assert.ok(Buffer.byteLength(out, 'utf8') <= 2000);
  assert.ok(out.endsWith('…'));
});

test('multi-byte characters are never split', () => {
  const long = '你'.repeat(1000); // 3000 bytes
  const out = truncateUtf8(long, 2000);
  assert.ok(Buffer.byteLength(out, 'utf8') <= 2000);
  // a split UTF-8 sequence would produce replacement chars on re-encode
  assert.ok(!out.includes('�'));
});
