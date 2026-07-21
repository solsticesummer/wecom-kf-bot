import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateStore } from '../src/state.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-'));
}

test('usage accumulates per day and survives restarts', () => {
  const dir = tmpDir();
  const a = new StateStore(dir);
  a.addUsage({ promptTokens: 100, completionTokens: 20, totalTokens: 120 });
  a.addUsage({ promptTokens: 50, completionTokens: 10, totalTokens: 60 });

  const day = new Date().toISOString().slice(0, 10);
  const b = new StateStore(dir); // simulated restart
  const today = b.getUsage()[day];
  assert.equal(today.calls, 2);
  assert.equal(today.promptTokens, 150);
  assert.equal(today.completionTokens, 30);
  assert.equal(today.totalTokens, 180);
});

test('addUsage tolerates missing/partial usage objects', () => {
  const dir = tmpDir();
  const store = new StateStore(dir);
  store.addUsage(); // e.g. API returned no usage block
  store.addUsage({ totalTokens: 5 });
  const day = new Date().toISOString().slice(0, 10);
  const today = store.getUsage()[day];
  assert.equal(today.calls, 2);
  assert.equal(today.totalTokens, 5);
  assert.equal(today.promptTokens, 0);
});
