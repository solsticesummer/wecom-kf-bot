// End-to-end tests of the message pipeline: a signed, encrypted WeCom callback goes in, and
// we assert on what the bot tried to SEND and MOVE.
//
// Every other test in this repo exercises one part in isolation. This is the only one that
// runs the pipeline the product actually is — decrypt, sync, route to a tenant, gate, decide,
// reply, record, hand off — and the only place the load-bearing invariants are demonstrated
// rather than asserted in a comment.
//
// Hermetic: no network, no database, no API key. DATABASE_URL is unset on purpose, so
// retrieval fails and every scenario also proves the full-FAQ degradation.

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeWecom, type FakeWecom } from './helpers/fake-wecom.js';
import { startBot, kfMessage, signedCallback, until, settle, quiesce, type Bot } from './helpers/bot-harness.js';
import { ServiceState } from '../src/wecom.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TENANTS_DIR = path.join(__dirname, 'fixtures', 'tenants');

let fake: FakeWecom;
let bot: Bot;

const texts = () => fake.sent.filter((m) => m.msgtype === 'text').map((m) => m.text!.content);
const menus = () => fake.sent.filter((m) => m.msgtype === 'msgmenu');

/** Deliver `msgs` and wait until the bot has sent `expected` messages. */
async function deliver(msgs: Record<string, unknown>[], expected = 1): Promise<void> {
  fake.queueMessages(msgs);
  await bot.postCallback();
  if (expected > 0) await until(() => fake.sent.length >= expected, `${expected} sent message(s)`);
}

before(async () => {
  fake = await startFakeWecom();
  bot = await startBot({ fakeUrl: fake.url, tenantsDir: TENANTS_DIR });
});

after(async () => {
  await bot?.stop();
  await fake?.close();
});

// Let anything still in flight from the previous test land BEFORE zeroing the counters —
// otherwise it arrives mid-test and fails an assertion that has nothing to do with it.
beforeEach(async () => {
  await quiesce(() => [fake.sent.length, fake.transfers.length, fake.modelCalls.length]);
  fake.reset();
});

// --- Protocol ---------------------------------------------------------------------------

test('URL verification returns the decrypted echostr', async () => {
  const res = await bot.verifyUrl('echo-me-back');
  assert.equal(res.status, 200);
  assert.equal(res.body, 'echo-me-back');
});

test('a tampered signature is refused', async () => {
  const res = await fetch(
    `${bot.url}/wecom/callback?msg_signature=deadbeef&timestamp=1&nonce=n&echostr=x`,
  );
  assert.equal(res.status, 403);
});

test('a callback with a bad signature is not processed', async () => {
  const { body, timestamp, nonce } = signedCallback('<xml><Event><![CDATA[kf_msg_or_event]]></Event><Token><![CDATA[t]]></Token></xml>');
  fake.queueMessages([kfMessage({ open_kfid: 'kf_alpha', external_userid: 'u1' })]);
  const res = await fetch(
    `${bot.url}/wecom/callback?msg_signature=notarealsignature&timestamp=${timestamp}&nonce=${nonce}`,
    { method: 'POST', headers: { 'content-type': 'text/xml' }, body },
  );
  assert.equal(res.status, 403);
  await settle();
  assert.equal(fake.sent.length, 0, 'forged callback must not reach the pipeline');
});

test('the callback ACKs before the work is done', async () => {
  // WeCom retries (i.e. duplicates) after ~5s of silence, so the ACK cannot wait on the
  // model call. Assert the ACK arrives while sent is still empty.
  fake.queueMessages([kfMessage({ open_kfid: 'kf_alpha', external_userid: 'u-ack' })]);
  const res = await bot.postCallback();
  assert.equal(res.body, 'success');
  assert.equal(fake.sent.length, 0, 'ACK must not wait for the reply to be sent');
  await until(() => fake.sent.length > 0, 'the reply, eventually');
});

// --- Routing: the safety invariant ---------------------------------------------------------

test('an unregistered kf account is ignored', async () => {
  // THE safety property. The 微信客服 callback is enterprise-wide, so the live 官方客服's
  // messages really do arrive here; only accounts a tenant claims may be answered.
  await deliver([kfMessage({ open_kfid: 'kf_not_registered', external_userid: 'stranger' })], 0);
  await settle();
  assert.equal(fake.sent.length, 0);
  assert.equal(fake.modelCalls.length, 0, 'no model call for an unrouted message either');
});

test('each kf account is answered by its own tenant, in one batch', async () => {
  fake.setModelReply({ action: 'answer', reply: 'answered' });
  await deliver(
    [
      kfMessage({ open_kfid: 'kf_alpha', external_userid: 'ua', text: { content: '价格' } }),
      kfMessage({ open_kfid: 'kf_beta', external_userid: 'ub', text: { content: '价格' } }),
    ],
    2,
  );
  await until(() => fake.modelCalls.length >= 2, 'both model calls');

  const systems = fake.modelCalls.map((c) => c.system);
  const alpha = systems.find((s) => s.includes('AlphaProduct'));
  const beta = systems.find((s) => s.includes('BetaProduct'));
  assert.ok(alpha && beta, 'each tenant composed its own prompt');
  // Cross-tenant leakage in either direction would be invisible without this.
  assert.ok(!alpha!.includes('BetaProduct'));
  assert.ok(!beta!.includes('AlphaProduct'));
  // Knowledge is per tenant too — these come from different fallback corpora.
  assert.ok(alpha!.includes('11 元') && !alpha!.includes('22 元'));
  assert.ok(beta!.includes('22 元') && !beta!.includes('11 元'));
});

test('history is stored per tenant, in separate state dirs', async () => {
  // Depends on the conversations from the previous test. History is written to disk after the
  // reply is sent, so poll rather than assuming the write has landed — reading immediately
  // races the pipeline and fails intermittently.
  await until(
    () => !!bot.readState('alpha')?.history?.ua && !!bot.readState('beta')?.history?.ub,
    'both tenants to have persisted their history',
  );
  const a = bot.readState('alpha');
  const b = bot.readState('beta');
  assert.ok(!a?.history?.ub && !b?.history?.ua, 'neither tenant can see the other’s conversation');
});

// --- Happy paths ---------------------------------------------------------------------------

test('entering the chat sends that tenant’s welcome', async () => {
  await deliver([
    kfMessage({
      msgtype: 'event',
      origin: undefined,
      text: undefined,
      event: { event_type: 'enter_session', open_kfid: 'kf_beta', external_userid: 'u-welcome' },
    }),
  ]);
  assert.deepEqual(texts(), ['欢迎来到 BetaProduct']);
});

test('an answer is followed by the 转人工 menu', async () => {
  fake.setModelReply({ action: 'answer', reply: '这是回答' });
  await deliver([kfMessage({ open_kfid: 'kf_alpha', external_userid: 'u2' })], 2);
  assert.deepEqual(texts(), ['这是回答']);
  const menu = menus()[0];
  assert.equal(menu.msgmenu!.head_content, '没有解决您的问题？');
  assert.equal(menu.msgmenu!.list[0].click!.id, 'human_service');
  assert.equal(fake.transfers.length, 0, 'a plain answer does not summon a human');
});

// --- Per-action consequences ---------------------------------------------------------------

test('a bug is logged, skips the menu, and summons a human', async () => {
  fake.setModelReply({ action: 'bug', reply: '已记录', bug_summary: '导出失败' });
  await deliver([kfMessage({ open_kfid: 'kf_alpha', external_userid: 'u-bug' })], 1);
  await until(() => fake.transfers.length > 0, 'the handoff');

  assert.deepEqual(texts(), ['已记录']);
  assert.equal(menus().length, 0, 'a human is already coming — the menu would be noise');
  assert.equal(fake.transfers[0].state, ServiceState.QUEUED_FOR_HUMAN);
  const bugs = bot.readState('alpha')?.bugs ?? [];
  assert.equal(bugs.at(-1).summary, '导出失败');
});

test('a handoff records the coverage gap with its reason', async () => {
  fake.setModelReply({ action: 'handoff', reply: '正在转接', handoff_reason: 'upset' });
  await deliver([kfMessage({ open_kfid: 'kf_alpha', external_userid: 'u-ho' })], 1);
  await until(() => fake.transfers.length > 0, 'the handoff');

  const entry = (bot.readState('alpha')?.unanswered ?? []).at(-1);
  assert.equal(entry.reason, 'upset');
  assert.equal(fake.transfers[0].state, ServiceState.QUEUED_FOR_HUMAN);
});

test('an unknown action degrades to a plain answer', async () => {
  // A hallucinated name must not reach a dispatcher that has no handler for it.
  fake.setModelReply({ action: 'launch_missiles', reply: '普通回答' });
  await deliver([kfMessage({ open_kfid: 'kf_alpha', external_userid: 'u-unknown' })], 2);
  assert.deepEqual(texts(), ['普通回答']);
  assert.equal(fake.transfers.length, 0);
});

test('an action the tenant did not enable degrades too', async () => {
  // beta leaves `account` off, so it must not be dispatchable there even if the model says it.
  fake.setModelReply({ action: 'account', reply: '稍等' });
  await deliver([kfMessage({ open_kfid: 'kf_beta', external_userid: 'u-noacct' })], 2);
  assert.equal(menus().length, 1, 'treated as a plain answer, so the menu is offered');
  assert.equal(fake.transfers.length, 0);
  assert.equal(bot.readState('beta')?.pendingTips?.['u-noacct'], undefined);
});

test('account flags a pending tip, and the staff reply triggers it', async () => {
  fake.setModelReply({ action: 'account', reply: '稍等，马上为您申请测试账号' });
  await deliver([kfMessage({ open_kfid: 'kf_alpha', external_userid: 'u-acct' })], 1);
  await until(() => fake.transfers.length > 0, 'the handoff');
  assert.ok(bot.readState('alpha')?.pendingTips?.['u-acct'], 'tip pending');

  // origin 5 = a human staff member replied — that IS the account being distributed.
  fake.reset();
  await deliver([
    kfMessage({ open_kfid: 'kf_alpha', external_userid: 'u-acct', origin: 5, text: { content: '账号给您' } }),
  ]);
  assert.deepEqual(texts(), ['AlphaProduct 积分提示']);
  await until(() => !bot.readState('alpha')?.pendingTips?.['u-acct'], 'the flag to clear');
});

test('tapping 转人工 hands off without consulting the model', async () => {
  await deliver([
    kfMessage({
      open_kfid: 'kf_alpha',
      external_userid: 'u-tap',
      text: { content: '转人工客服', menu_id: 'human_service' },
    }),
  ]);
  await until(() => fake.transfers.length > 0, 'the handoff');

  assert.deepEqual(texts(), ['好的，正在为您转接人工客服。']);
  assert.equal(fake.modelCalls.length, 0, 'a structured tap needs no intent-guessing');
  assert.equal((bot.readState('alpha')?.unanswered ?? []).at(-1).reason, 'user_request');
});

// --- Invariants that had never run ----------------------------------------------------------

test('the bot stays silent when a human owns the session', async () => {
  // Replying here would talk over your staff, mid-conversation, in front of the customer.
  fake.setServiceState(ServiceState.HUMAN);
  await deliver([kfMessage({ open_kfid: 'kf_alpha', external_userid: 'u-human' })], 0);
  await settle();
  assert.equal(fake.sent.length, 0);
  assert.equal(fake.modelCalls.length, 0);
});

test('a spent budget replies and hands off instead of calling the model', async () => {
  // gamma's cap is one call a day, and no other test touches it — so the first message is
  // always answered and the second is always the capped one, whatever ran before.
  fake.setModelReply({ action: 'answer', reply: 'first' });
  await deliver([kfMessage({ open_kfid: 'kf_gamma', external_userid: 'u-q1' })], 2);
  await until(() => (bot.readState('gamma')?.usage ?? null) !== null, 'usage recorded');

  fake.reset();
  await deliver([kfMessage({ open_kfid: 'kf_gamma', external_userid: 'u-q2' })], 1);
  await until(() => fake.transfers.length > 0, 'the handoff');

  assert.deepEqual(texts(), ['GammaProduct 智能客服暂时不可用，正在转接人工。']);
  assert.equal(fake.modelCalls.length, 0, 'the point of a cap is to not spend');
  assert.equal(fake.transfers[0].state, ServiceState.QUEUED_FOR_HUMAN);
  // The customer is never left on read, even when it is the operator who ran out of money.
});

test('alpha still answers while gamma is capped — budgets are per tenant', async () => {
  fake.setModelReply({ action: 'answer', reply: 'alpha ok' });
  await deliver([kfMessage({ open_kfid: 'kf_alpha', external_userid: 'u-alpha-ok' })], 2);
  assert.deepEqual(texts(), ['alpha ok']);
  assert.ok(fake.modelCalls.length > 0, 'and it really did call the model');
});

test('a model failure still answers and summons a human', async () => {
  fake.failModel(400);
  await deliver([kfMessage({ open_kfid: 'kf_alpha', external_userid: 'u-apierr' })], 1);
  await until(() => fake.transfers.length > 0, 'the handoff');

  assert.deepEqual(texts(), ['AlphaProduct 暂时无法处理，正在转接人工。']);
  assert.equal((bot.readState('alpha')?.unanswered ?? []).at(-1).reason, 'api_error');
});

test('with retrieval down the model still gets the tenant’s own knowledge', async () => {
  // DATABASE_URL is unset for the whole run, so this has been true of every test above —
  // assert it explicitly so the degradation is a tested property, not a side effect.
  fake.setModelReply({ action: 'answer', reply: 'ok' });
  await deliver([kfMessage({ open_kfid: 'kf_alpha', external_userid: 'u-fallback' })], 1);
  await until(() => fake.modelCalls.length > 0, 'the model call');
  assert.ok(fake.modelCalls[0].system.includes('11 元'), 'alpha’s FAQ was inlined');
});

// --- Robustness -----------------------------------------------------------------------------

test('a repeated msgid is answered once', async () => {
  const msg = kfMessage({ open_kfid: 'kf_alpha', external_userid: 'u-dupe' });
  fake.setModelReply({ action: 'answer', reply: 'once' });
  await deliver([msg], 2);
  const after = fake.sent.length;

  await deliver([msg], 0); // WeCom retrying the same message
  await settle();
  assert.equal(fake.sent.length, after, 'the retry produced no second reply');
});

test('a stale message is dropped', async () => {
  await deliver(
    [
      kfMessage({
        open_kfid: 'kf_alpha',
        external_userid: 'u-old',
        send_time: Math.floor(Date.now() / 1000) - 3600,
      }),
    ],
    0,
  );
  await settle();
  assert.equal(fake.sent.length, 0, 'a backlog on first deploy must not be answered');
});

test('a flood is rate-limited to one notice', async () => {
  fake.setModelReply({ action: 'answer', reply: 'r' });
  const msgs = Array.from({ length: 20 }, () =>
    kfMessage({ open_kfid: 'kf_alpha', external_userid: 'u-flood' }),
  );
  await deliver(msgs, 1);
  await until(() => texts().filter((t) => t === '您发送得太频繁啦').length > 0, 'the notice');
  await settle();

  const notices = texts().filter((t) => t === '您发送得太频繁啦');
  assert.equal(notices.length, 1, 'a spammer gets told once, not once per message');
  assert.ok(texts().filter((t) => t === 'r').length <= 15, 'answers stopped at the limit');
});

test('an over-long reply is truncated without splitting a character', async () => {
  const long = '积'.repeat(1200); // 3 bytes each — well past WeCom's 2048-byte cap
  fake.setModelReply({ action: 'answer', reply: long });
  await deliver([kfMessage({ open_kfid: 'kf_alpha', external_userid: 'u-long' })], 1);

  const sent = texts()[0];
  assert.ok(Buffer.byteLength(sent, 'utf8') <= 2000);
  assert.ok(sent.endsWith('…'));
  assert.ok(!sent.includes('�'), 'no mangled multi-byte character');
});

test('a non-text message type is ignored', async () => {
  await deliver([kfMessage({ open_kfid: 'kf_alpha', external_userid: 'u-img', msgtype: 'image', text: undefined })], 0);
  await settle();
  assert.equal(fake.sent.length, 0);
});
