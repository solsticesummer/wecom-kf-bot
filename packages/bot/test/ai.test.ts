import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelJson } from '../src/ai.js';

test('bare JSON object parses', () => {
  const out = parseModelJson('{"action":"answer","reply":"你好"}');
  assert.deepEqual(out, { action: 'answer', reply: '你好' });
});

test('JSON wrapped in markdown fences parses', () => {
  const out = parseModelJson('```json\n{"action":"bug","reply":"收到","bug_summary":"支付失败"}\n```');
  assert.equal(out.action, 'bug');
  assert.equal(out.bug_summary, '支付失败');
});

test('JSON with a leading phrase parses', () => {
  const out = parseModelJson('好的，输出如下：{"action":"handoff","reply":"正在转接"}');
  assert.equal(out.action, 'handoff');
});

test('nested braces inside strings survive', () => {
  const out = parseModelJson('{"action":"answer","reply":"配置示例 {a: 1}"}');
  assert.equal(out.reply, '配置示例 {a: 1}');
});

test('garbage returns null instead of throwing', () => {
  assert.equal(parseModelJson('抱歉我不知道'), null);
  assert.equal(parseModelJson(''), null);
  assert.equal(parseModelJson('{broken'), null);
});
