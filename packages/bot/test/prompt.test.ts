import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadSkill, composeSystemRules, render } from '../src/skills.js';
import { loadTenant } from '../src/tenants.js';

// Golden-fixture lock: the composed DramaClaw prompt must stay byte-identical to the prompt
// the bot shipped with. The prompt now comes from skills/cs-triage/{skill.yaml,prompt.md}
// rather than a TypeScript constant, but the FIXTURE IS UNCHANGED — that's the whole point.
// Any drift here is a prompt-behavior change and must be intentional (update the fixture
// deliberately), not a refactor accident.
const golden = readFileSync(
  new URL('./fixtures/dramaclaw-system-rules.txt', import.meta.url),
  'utf8',
).replace(/\n$/, ''); // tolerate a single trailing newline the file may carry

test('the dramaclaw tenant reproduces the shipped prompt byte-for-byte', () => {
  assert.equal(loadTenant('dramaclaw').systemRules, golden);
});

test('a different tenant config swaps productName and domainTerms, structure intact', () => {
  const skill = loadSkill('cs-triage');
  const out = composeSystemRules(skill, { productName: 'Acme', domainTerms: 'X、Y、Z' }, ['account']);
  assert.ok(out.includes('只回答与 Acme 产品相关的问题'));
  assert.ok(out.includes('（如 X、Y、Z等）'));
  assert.ok(!out.includes('DramaClaw'));
});

// The reason skill.yaml generates the bullets instead of prompt.md spelling them out: with
// an optional action switched off, a hardcoded 四选一 would tell the model to pick from a
// list that no longer has four entries.
test('dropping the optional account action removes its bullet and re-counts', () => {
  const skill = loadSkill('cs-triage');
  const out = composeSystemRules(skill, { productName: 'Acme', domainTerms: 'X' }, []);
  assert.ok(out.includes('"action"：三选一'), 'count follows the enabled actions');
  assert.ok(!out.includes('"account"'), 'the optional bullet is gone');
  assert.ok(!/\n\n\s*- "handoff"/.test(out), 'no blank line left where the bullet was');
});

test('the tenant exposes only the actions it opted into', () => {
  const names = loadTenant('dramaclaw').actions.map((a) => a.name);
  assert.deepEqual(names, ['answer', 'account', 'handoff', 'bug']);
});

// These two guards are why the loader is strict: either failure mode would otherwise reach
// a customer as a literal "{{productName}}" in the chat window.
test('render rejects an unfilled slot and an unused config key', () => {
  assert.throws(() => render('hi {{missing}}', {}), /no value/);
  assert.throws(() => render('hi', { extra: 'x' }), /never used/);
});

test('a tenant opting into an action the skill does not have fails loudly', () => {
  const skill = loadSkill('cs-triage');
  assert.throws(() => composeSystemRules(skill, { productName: 'A', domainTerms: 'B' }, ['acount']), /no optional action/);
});
