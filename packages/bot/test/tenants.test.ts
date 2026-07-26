import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTenant, loadRegistry, TenantRegistry, type Tenant } from '../src/tenants.js';

// Build a Tenant cheaply for registry tests — only the fields routing touches matter here.
const fake = (id: string, kfIds: string[]): Tenant =>
  ({ id, kfIds, namespace: id }) as Tenant;

test('registry routes a kf account to its owning tenant', () => {
  const reg = new TenantRegistry([fake('alpha', ['kf_a1', 'kf_a2']), fake('beta', ['kf_b1'])]);
  assert.equal(reg.forKfId('kf_a1')?.id, 'alpha');
  assert.equal(reg.forKfId('kf_a2')?.id, 'alpha');
  assert.equal(reg.forKfId('kf_b1')?.id, 'beta');
});

// The safety property that used to live in ALLOWED_KF_IDS. The 微信客服 callback is
// enterprise-wide, so the live 官方客服's messages DO arrive at this endpoint — an
// unregistered account resolving to a tenant would mean answering real customers by accident.
test('registry is fail-closed: unknown or missing kf account routes nowhere', () => {
  const reg = new TenantRegistry([fake('alpha', ['kf_a1'])]);
  assert.equal(reg.forKfId('kf_the_live_official_account'), undefined);
  assert.equal(reg.forKfId(''), undefined);
  assert.equal(reg.forKfId(undefined), undefined);
});

// Whichever tenant won would answer that account's customers as the wrong product, from the
// wrong knowledge base. There is no safe resolution, so refuse to boot.
test('two tenants claiming one kf account refuses to start', () => {
  assert.throws(
    () => new TenantRegistry([fake('alpha', ['kf_shared']), fake('beta', ['kf_shared'])]),
    /claimed by both alpha and beta/,
  );
});

test('duplicate tenant ids and an empty registry are rejected', () => {
  assert.throws(() => new TenantRegistry([fake('alpha', []), fake('alpha', [])]), /duplicate/);
  assert.throws(() => new TenantRegistry([]), /no tenants/);
});

// --- the real tenants on disk ----------------------------------------------------------

test('the shipped tenants load and stay isolated from each other', () => {
  const reg = loadRegistry();
  const dramaclaw = reg.get('dramaclaw')!;
  const demo = reg.get('demo')!;
  assert.ok(dramaclaw && demo, 'both tenants load');

  // Separate corpora: sharing a namespace would let one product answer from the other's KB.
  assert.notEqual(dramaclaw.namespace, demo.namespace);

  // Separate prompts, from the same skill.
  assert.ok(dramaclaw.systemRules.includes('DramaClaw'));
  assert.ok(!demo.systemRules.includes('DramaClaw'));

  // Separate copy — nothing DramaClaw-voiced leaks into the other tenant.
  assert.ok(!demo.copy.welcome.includes('DramaClaw'));
});

// The bug tenant #2 exposed: the retrieval-failure fallback used to be one global read of
// knowledge/faq.md, so a DB outage would have inlined DramaClaw's prices into demo's prompt.
test('each tenant falls back to its OWN corpus, not a shared one', () => {
  const reg = loadRegistry();
  const dramaclaw = reg.get('dramaclaw')!;
  const demo = reg.get('demo')!;

  assert.ok(dramaclaw.fallbackFaq.length > 0 && demo.fallbackFaq.length > 0);
  assert.notEqual(dramaclaw.fallbackFaq, demo.fallbackFaq);
  assert.ok(!demo.fallbackFaq.includes('DramaClaw'), "demo's fallback must not carry DramaClaw's KB");
});

// A tenant filename is config, but the path it names is read straight into a system prompt
// that gets sent to a customer — so it must not be able to escape knowledge/.
test('fallback_faq cannot escape the knowledge directory', () => {
  assert.throws(() => loadTenant('../../../etc/hosts'), /ENOENT|must stay inside/);
});

// Optional actions are per-tenant, and the prompt's action count is generated from them —
// so a tenant that leaves `account` off must be offered three actions, not four.
test('optional actions change both the action set and the generated prompt count', () => {
  const reg = loadRegistry();
  const dramaclaw = reg.get('dramaclaw')!;
  const demo = reg.get('demo')!;

  assert.ok(dramaclaw.actions.some((a) => a.name === 'account'));
  assert.ok(!demo.actions.some((a) => a.name === 'account'));

  assert.equal(dramaclaw.actions.length, demo.actions.length + 1);
  assert.ok(dramaclaw.systemRules.includes('四选一'), 'dramaclaw offers four actions');
  assert.ok(demo.systemRules.includes('三选一'), 'demo offers three');
  assert.ok(!demo.systemRules.includes('"account"'), 'the account bullet is gone entirely');
});
