import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state.js';
import { runAction, actionHandlers } from '../src/actions.js';
import { loadTenant } from '../src/tenants.js';
import type { GenerateResult } from '../src/ai.js';

const tmpStore = () => new StateStore(fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-actions-')));

const ctx = (store: StateStore, result: Partial<GenerateResult>) => ({
  store,
  userId: 'u1',
  userText: '打不开页面',
  result: { action: 'answer', reply: 'r', bugSummary: '', handoffReason: '', ...result } as GenerateResult,
});

test('bug records a report, falling back to the message when the model gave no summary', () => {
  const store = tmpStore();
  runAction('bug', ctx(store, { action: 'bug', bugSummary: '页面白屏' }));
  runAction('bug', ctx(store, { action: 'bug', bugSummary: '' }));

  const bugs = store.getBugs();
  assert.equal(bugs.length, 2);
  assert.equal(bugs[0].summary, '页面白屏');
  assert.equal(bugs[1].summary, '打不开页面', 'empty summary falls back to the customer message');
});

test('handoff records a coverage gap tagged with its reason', () => {
  const store = tmpStore();
  runAction('handoff', ctx(store, { action: 'handoff', reply: '正在转接', handoffReason: 'not_in_kb' }));

  const [entry] = store.getUnanswered();
  assert.equal(entry.reason, 'not_in_kb');
  assert.equal(entry.reply, '正在转接');
  assert.equal(entry.message, '打不开页面');
});

test('account flags the customer for the follow-up credits tip', () => {
  const store = tmpStore();
  assert.equal(store.hasPendingTip('u1'), false);
  runAction('account', ctx(store, { action: 'account' }));
  assert.equal(store.hasPendingTip('u1'), true);
});

// 'answer' is the common case and deliberately has no handler; an unknown name can reach
// here only via a bug, and dropping it beats throwing inside the message pipeline.
test('actions with no handler are a no-op, not a crash', () => {
  const store = tmpStore();
  assert.doesNotThrow(() => runAction('answer', ctx(store, {})));
  assert.doesNotThrow(() => runAction('nonexistent', ctx(store, {})));
  assert.equal(store.getBugs().length, 0);
  assert.equal(store.getUnanswered().length, 0);
});

// The pipeline no longer lists which actions end in a human takeover — it reads the flag off
// the skill. If these drift, the bot either talks over staff or strands the customer.
test('the handoff flag matches what the pipeline used to hardcode', () => {
  const handsOff = Object.fromEntries(loadTenant('dramaclaw').actions.map((a) => [a.name, a.handoff]));
  assert.deepEqual(handsOff, { answer: false, account: true, handoff: true, bug: true });
});

// Every action that records something must have a handler registered, or the side effect
// silently stops happening the moment someone adds an action to skill.yaml.
test('every recording action in the skill has a handler', () => {
  for (const name of ['bug', 'handoff', 'account']) {
    assert.ok(actionHandlers[name], `no handler registered for '${name}'`);
  }
});
