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

  // "Pending tip" flags: set when a customer requests a test account, cleared
  // once the post-distribution credits tip has been sent. Persisted so a
  // restart between the human distributing the account and the tip going out
  // doesn't lose the follow-up.
  hasPendingTip(userId) {
    return Boolean(this.state.pendingTips?.[userId]);
  }

  setPendingTip(userId) {
    if (!this.state.pendingTips) this.state.pendingTips = {};
    this.state.pendingTips[userId] = Date.now();
    this._save();
  }

  clearPendingTip(userId) {
    if (this.state.pendingTips?.[userId]) {
      delete this.state.pendingTips[userId];
      this._save();
    }
  }

  // Bug reports live in the same persisted state so they survive restarts,
  // but are also mirrored to data/bugs.json — a standalone, human-readable
  // file your team can open/download without wading through cursors and
  // dedupe ids.
  addBug({ userId, message, summary }) {
    if (!this.state.bugs) this.state.bugs = [];
    const bug = {
      id: this.state.bugs.length + 1,
      time: new Date().toISOString(),
      userId,
      message,
      summary,
      status: 'open',
    };
    this.state.bugs.push(bug);
    this._save();
    const bugsFile = path.join(path.dirname(this.file), 'bugs.json');
    const tmp = bugsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state.bugs, null, 2));
    fs.renameSync(tmp, bugsFile);
    return bug;
  }

  getBugs() {
    return this.state.bugs || [];
  }

  // Coverage-gap log: every question the bot couldn't answer (handed off).
  // Same shape/persistence as bugs — mirrored to data/unanswered.json so the
  // team can review real misses and grow knowledge/faq.md from them.
  addUnanswered({ userId, message, reply, reason }) {
    if (!this.state.unanswered) this.state.unanswered = [];
    const entry = {
      id: this.state.unanswered.length + 1,
      time: new Date().toISOString(),
      userId,
      message,
      reply,
      reason,
    };
    this.state.unanswered.push(entry);
    this._save();
    const file = path.join(path.dirname(this.file), 'unanswered.json');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state.unanswered, null, 2));
    fs.renameSync(tmp, file);
    return entry;
  }

  getUnanswered() {
    return this.state.unanswered || [];
  }

  // Per-day token tally so you can watch free-quota burn without the console.
  // Keyed by UTC date (YYYY-MM-DD); small enough to keep indefinitely.
  addUsage({ promptTokens = 0, completionTokens = 0, totalTokens = 0 } = {}) {
    if (!this.state.usage) this.state.usage = {};
    const day = new Date().toISOString().slice(0, 10);
    const d = this.state.usage[day] || {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    d.calls += 1;
    d.promptTokens += promptTokens;
    d.completionTokens += completionTokens;
    d.totalTokens += totalTokens;
    this.state.usage[day] = d;
    this._save();
    return d;
  }

  getUsage() {
    return this.state.usage || {};
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
