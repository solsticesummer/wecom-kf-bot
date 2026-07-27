import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state.js';
import { checkQuota, dayKey } from '../src/quota.js';
import { loadRegistry, type Tenant } from '../src/tenants.js';

const tmpStore = (): StateStore =>
  new StateStore(fs.mkdtempSync(path.join(os.tmpdir(), 'quota-')));

const withLimits = (dailyTokens?: number, dailyCalls?: number): Tenant =>
  ({ id: 't', limits: { dailyTokens, dailyCalls } }) as Tenant;

test('a tenant with no limits is never capped', () => {
  const store = tmpStore();
  for (let i = 0; i < 50; i++) store.addUsage({ totalTokens: 1_000_000 });
  // Absent limits must mean "unlimited", not "0" — a tenant that never opted in must behave
  // exactly as it did before quotas existed.
  assert.equal(checkQuota({ id: 't', limits: {} } as Tenant, store).allowed, true);
});

test('the token cap trips only once today’s spend reaches it', () => {
  const store = tmpStore();
  const tenant = withLimits(1000);
  store.addUsage({ totalTokens: 999 });
  assert.equal(checkQuota(tenant, store).allowed, true, '999 < 1000 still allowed');

  store.addUsage({ totalTokens: 1 }); // now exactly at the cap
  const out = checkQuota(tenant, store);
  assert.equal(out.allowed, false);
  assert.equal(out.exceeded, 'tokens');
  assert.equal(out.usedTokens, 1000);
});

test('the call cap is enforced independently of the token cap', () => {
  const store = tmpStore();
  for (let i = 0; i < 3; i++) store.addUsage({ totalTokens: 1 });
  assert.equal(checkQuota(withLimits(undefined, 3), store).exceeded, 'calls');
  // Cheap calls must not trip a generous token cap.
  assert.equal(checkQuota(withLimits(1_000_000), store).allowed, true);
});

test('the budget resets on a new UTC day', () => {
  const store = tmpStore();
  const tenant = withLimits(100);
  store.addUsage({ totalTokens: 500 }); // today: way over
  assert.equal(checkQuota(tenant, store).allowed, false);

  // Same store, next day: the tally is keyed by UTC date, so tomorrow starts clean.
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
  assert.notEqual(dayKey(tomorrow), dayKey());
  assert.equal(checkQuota(tenant, store, tomorrow).allowed, true);
});

test('usage is per tenant — one tenant’s spend cannot exhaust another’s budget', () => {
  const a = tmpStore();
  const b = tmpStore();
  const tenant = withLimits(100);
  a.addUsage({ totalTokens: 5000 });
  assert.equal(checkQuota(tenant, a).allowed, false);
  assert.equal(checkQuota(tenant, b).allowed, true, "b's budget is untouched by a's spend");
});

test('the shipped tenants declare independent caps', () => {
  const reg = loadRegistry();
  const dramaclaw = reg.get('dramaclaw')!;
  const demo = reg.get('demo')!;
  assert.ok(dramaclaw.limits.dailyTokens && demo.limits.dailyTokens);
  assert.notEqual(dramaclaw.limits.dailyTokens, demo.limits.dailyTokens);
});

test('every tenant has the quota copy string', () => {
  // Missing copy would reach a customer as the literal text "undefined" at the exact moment
  // the bot is already degraded.
  for (const t of loadRegistry().all()) {
    assert.equal(typeof t.copy.quotaExceeded, 'string');
    assert.ok(t.copy.quotaExceeded.trim().length > 0, `${t.id} has quota_exceeded copy`);
  }
});
