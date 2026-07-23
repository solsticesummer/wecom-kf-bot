import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/ratelimit.js';

test('allows up to the limit then blocks within the window', () => {
  const rl = new RateLimiter({ maxRequests: 3, windowMs: 1000 });
  const t = 1_000_000; // fixed "now" — all within one window
  assert.equal(rl.allow('u', t).allowed, true);
  assert.equal(rl.allow('u', t).allowed, true);
  assert.equal(rl.allow('u', t).allowed, true);
  assert.equal(rl.allow('u', t).allowed, false); // 4th over the limit
});

test('the window slides — old hits expire and free up budget', () => {
  const rl = new RateLimiter({ maxRequests: 2, windowMs: 1000 });
  assert.equal(rl.allow('u', 0).allowed, true);
  assert.equal(rl.allow('u', 500).allowed, true);
  assert.equal(rl.allow('u', 900).allowed, false); // both hits still in window
  assert.equal(rl.allow('u', 1600).allowed, true); // t=0 and t=500 have expired
});

test('separate keys have independent budgets', () => {
  const rl = new RateLimiter({ maxRequests: 1, windowMs: 1000 });
  assert.equal(rl.allow('a', 0).allowed, true);
  assert.equal(rl.allow('b', 0).allowed, true); // b unaffected by a
  assert.equal(rl.allow('a', 0).allowed, false);
});

test('notify fires once per window, stays quiet, then again after a fresh block', () => {
  const rl = new RateLimiter({ maxRequests: 1, windowMs: 1000 });
  assert.equal(rl.allow('u', 0).allowed, true);
  assert.equal(rl.allow('u', 100).notify, true); // first breach → notify
  assert.equal(rl.allow('u', 200).notify, false); // same window, still blocked → quiet
  assert.equal(rl.allow('u', 1050).allowed, true); // window slid, the t=0 hit expired
  assert.equal(rl.allow('u', 1100).notify, true); // blocked again, a full window since last notify
});

test('evicts least-recently-touched keys past maxKeys', () => {
  const rl = new RateLimiter({ maxRequests: 5, windowMs: 10_000, maxKeys: 2 });
  rl.allow('a', 0);
  rl.allow('b', 0);
  rl.allow('c', 0); // 'a' is now the oldest and gets evicted
  assert.equal(rl.hits.has('a'), false);
  assert.equal(rl.hits.has('b'), true);
  assert.equal(rl.hits.has('c'), true);
});
