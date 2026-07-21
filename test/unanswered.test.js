import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateStore } from '../src/state.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'unanswered-test-'));
}

test('unanswered entries persist across restarts and get sequential ids', () => {
  const dir = tmpDir();
  const a = new StateStore(dir);
  const e1 = a.addUnanswered({ userId: 'u1', message: '你们在哪个城市？', reply: '正在为您转接人工客服' });
  assert.equal(e1.id, 1);

  const b = new StateStore(dir); // simulated restart
  const e2 = b.addUnanswered({ userId: 'u2', message: '能开发票吗？', reply: '正在为您转接人工客服' });
  assert.equal(e2.id, 2);
  assert.equal(b.getUnanswered().length, 2);
  assert.equal(b.getUnanswered()[0].message, '你们在哪个城市？');
});

test('unanswered entries are mirrored to a readable unanswered.json', () => {
  const dir = tmpDir();
  const store = new StateStore(dir);
  store.addUnanswered({ userId: 'u1', message: '有安卓 App 吗？', reply: '转人工' });
  const mirrored = JSON.parse(fs.readFileSync(path.join(dir, 'unanswered.json'), 'utf8'));
  assert.equal(mirrored.length, 1);
  assert.equal(mirrored[0].userId, 'u1');
  assert.equal(mirrored[0].message, '有安卓 App 吗？');
});
