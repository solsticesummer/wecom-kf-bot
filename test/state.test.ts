import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-state-'));
}

test('cursor persists across store instances (restart survival)', () => {
  const dir = tmpDir();
  new StateStore(dir).setCursor('CURSOR_A');
  assert.equal(new StateStore(dir).cursor, 'CURSOR_A');
});

test('msgid dedupe persists across restarts', () => {
  const dir = tmpDir();
  const s1 = new StateStore(dir);
  s1.markSeen('msg-1');
  const s2 = new StateStore(dir);
  assert.ok(s2.hasSeen('msg-1'));
  assert.ok(!s2.hasSeen('msg-2'));
});

test('history is trimmed to the configured window', () => {
  const dir = tmpDir();
  const s = new StateStore(dir);
  for (let i = 0; i < 30; i++) s.appendHistory('user1', `q${i}`, `a${i}`);
  const h = s.getHistory('user1');
  assert.equal(h.length, 20); // 10 turns * 2 messages
  assert.equal(h[h.length - 1].content, 'a29');
});

test('least-recently-active users are evicted beyond the cap', () => {
  const dir = tmpDir();
  const s = new StateStore(dir);
  for (let i = 0; i < 510; i++) s.appendHistory(`user${i}`, 'hi', 'hello');
  assert.equal(Object.keys(s.state.history).length, 500);
  assert.equal(s.getHistory('user0').length, 0); // oldest evicted
  assert.equal(s.getHistory('user509').length, 2); // newest kept
  // re-activity moves a user to the safe end
  s.appendHistory('user10', 'again', 'sure');
  s.appendHistory('user600', 'new', 'hi');
  assert.ok(s.getHistory('user10').length > 0);
});

test('corrupt state file falls back to fresh state', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'state.json'), '{not json');
  const s = new StateStore(dir);
  assert.equal(s.cursor, '');
});
