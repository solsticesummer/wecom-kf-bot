import test from 'node:test';
import assert from 'node:assert/strict';
import { canReadTenant, isOperator, presentedToken, tokenEnvName } from '../src/adminauth.js';

const env = {
  ADMIN_TOKEN: 'operator-token',
  ADMIN_TOKEN_DRAMACLAW: 'dramaclaw-token',
  ADMIN_TOKEN_DEMO: 'demo-token',
} as NodeJS.ProcessEnv;

test('env var name is derived from the tenant id', () => {
  assert.equal(tokenEnvName('dramaclaw'), 'ADMIN_TOKEN_DRAMACLAW');
  assert.equal(tokenEnvName('acme-corp'), 'ADMIN_TOKEN_ACME_CORP');
  assert.equal(tokenEnvName('a.b c'), 'ADMIN_TOKEN_A_B_C');
});

// THE boundary this whole module exists for: /bugs and /unanswered carry verbatim customer
// messages, so one tenant's operator must not be able to read another's.
test('a tenant token reads only its own tenant', () => {
  assert.equal(canReadTenant('demo-token', 'demo', env), true);
  assert.equal(canReadTenant('demo-token', 'dramaclaw', env), false);
  assert.equal(canReadTenant('dramaclaw-token', 'demo', env), false);
});

test('the operator token reads every tenant', () => {
  assert.equal(canReadTenant('operator-token', 'demo', env), true);
  assert.equal(canReadTenant('operator-token', 'dramaclaw', env), true);
  assert.equal(isOperator('operator-token', env), true);
});

test('a tenant token is not an operator token', () => {
  // /tenants names every tenant, which is more than one tenant's operator should see.
  assert.equal(isOperator('demo-token', env), false);
});

test('fail-closed when nothing is configured', () => {
  // "No token set" must mean no access, never no check — an open admin surface leaks
  // customer messages.
  assert.equal(canReadTenant('', 'demo', {} as NodeJS.ProcessEnv), false);
  assert.equal(canReadTenant('anything', 'demo', {} as NodeJS.ProcessEnv), false);
  assert.equal(isOperator('', {} as NodeJS.ProcessEnv), false);
});

test('empty and wrong-length tokens are rejected without throwing', () => {
  // timingSafeEqual throws on a length mismatch, so the length guard has to come first —
  // otherwise a short token turns a 403 into a 500.
  assert.equal(canReadTenant('', 'demo', env), false);
  assert.equal(canReadTenant('x', 'demo', env), false);
  assert.equal(canReadTenant('demo-token-but-longer', 'demo', env), false);
  assert.equal(canReadTenant('demo-toke', 'demo', env), false);
});

test('an unknown tenant has no token and is refused', () => {
  assert.equal(canReadTenant('demo-token', 'no-such-tenant', env), false);
});

test('the token is read from a Bearer header or the legacy query param', () => {
  assert.equal(presentedToken('Bearer abc123', undefined), 'abc123');
  assert.equal(presentedToken('bearer abc123', undefined), 'abc123', 'scheme is case-insensitive');
  assert.equal(presentedToken('  Bearer   abc123  ', undefined), 'abc123');
  assert.equal(presentedToken(undefined, 'abc123'), 'abc123', 'legacy ?token= still works');
  // A header, when present, wins — so an operator can override a stale bookmarked URL.
  assert.equal(presentedToken('Bearer header-wins', 'query-loses'), 'header-wins');
  assert.equal(presentedToken(undefined, undefined), '');
  assert.equal(presentedToken('Basic abc', undefined), '', 'non-Bearer schemes are not tokens');
});
