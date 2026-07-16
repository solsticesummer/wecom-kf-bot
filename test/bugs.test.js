import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateStore } from '../src/state.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bugs-test-'));
}

test('bugs persist across restarts and get sequential ids', () => {
  const dir = tmpDir();
  const a = new StateStore(dir);
  const bug1 = a.addBug({ userId: 'u1', message: '支付按钮点了没反应', summary: '支付按钮无响应' });
  assert.equal(bug1.id, 1);
  assert.equal(bug1.status, 'open');

  const b = new StateStore(dir); // simulated restart
  const bug2 = b.addBug({ userId: 'u2', message: '图片加载不出来', summary: '图片加载失败' });
  assert.equal(bug2.id, 2);
  assert.equal(b.getBugs().length, 2);
  assert.equal(b.getBugs()[0].summary, '支付按钮无响应');
});

test('bugs are mirrored to a readable bugs.json', () => {
  const dir = tmpDir();
  const store = new StateStore(dir);
  store.addBug({ userId: 'u1', message: 'app 闪退', summary: 'app 闪退' });
  const mirrored = JSON.parse(fs.readFileSync(path.join(dir, 'bugs.json'), 'utf8'));
  assert.equal(mirrored.length, 1);
  assert.equal(mirrored[0].userId, 'u1');
});
