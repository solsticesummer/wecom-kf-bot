// JSON-file persistence for everything that must survive a restart:
//   - cursor:   our position in WeCom's message stream (lose it → replay old messages)
//   - seen:     recently-processed msgids (WeCom retries callbacks → dedupe)
//   - history:  per-user conversation turns so follow-up questions have context
//
// A single JSON file is deliberate: at customer-support volume there is no
// concurrency pressure, and one file on a persistent volume is trivially
// inspectable when debugging. Swap for SQLite/Redis if volume ever demands it.

import fs from 'node:fs';
import path from 'node:path';

const MAX_SEEN = 5000; // bound the dedupe set so the file can't grow forever
const MAX_HISTORY_TURNS = 10; // user+assistant pairs kept per conversation
const MAX_HISTORY_USERS = 500; // evict least-recently-active users beyond this

export class StateStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'state.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.state = { cursor: '', seen: [], history: {} };
    if (fs.existsSync(this.file)) {
      try {
        this.state = { ...this.state, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
      } catch {
        console.error('state.json corrupt — starting fresh');
      }
    }
    this._seenSet = new Set(this.state.seen);
  }

  _save() {
    // write-then-rename so a crash mid-write can't corrupt the file
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  get cursor() {
    return this.state.cursor;
  }

  setCursor(cursor) {
    this.state.cursor = cursor || '';
    this._save();
  }

  hasSeen(msgid) {
    return this._seenSet.has(msgid);
  }

  markSeen(msgid) {
    if (this._seenSet.has(msgid)) return;
    this._seenSet.add(msgid);
    this.state.seen.push(msgid);
    while (this.state.seen.length > MAX_SEEN) {
      this._seenSet.delete(this.state.seen.shift());
    }
    this._save();
  }

  getHistory(userId) {
    return this.state.history[userId] || [];
  }

  appendHistory(userId, userText, assistantText) {
    const h = this.getHistory(userId).slice();
    h.push({ role: 'user', content: userText });
    h.push({ role: 'assistant', content: assistantText });
    // Deleting + re-inserting moves this user to the end of the object's key
    // order, so key order doubles as an LRU list for eviction below.
    delete this.state.history[userId];
    this.state.history[userId] = h.slice(-MAX_HISTORY_TURNS * 2);
    const users = Object.keys(this.state.history);
    for (const stale of users.slice(0, Math.max(0, users.length - MAX_HISTORY_USERS))) {
      delete this.state.history[stale];
    }
    this._save();
  }
}
