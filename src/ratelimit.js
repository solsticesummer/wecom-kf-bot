// In-memory per-key sliding-window rate limiter.
//
// Deliberately NOT persisted (unlike StateStore): a rate-limit window is a
// short-lived runtime concern, a restart clearing it is harmless, and keeping
// it out of state.json avoids a disk write on every message plus unbounded
// growth.
//
// Why we key on the customer (external_userid) and not an IP: every request
// reaches us through WeCom's servers via one signed callback, so all traffic
// shares a handful of WeCom IPs and a single callback can carry many users'
// messages. An IP limiter would throttle WeCom (i.e. everyone) while doing
// nothing to stop one abusive customer — whose spam is what actually costs us
// Qwen API calls.

export class RateLimiter {
  constructor({ maxRequests, windowMs, maxKeys = 10_000 }) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.hits = new Map(); // key -> timestamps (ms) still inside the window
    this.notifiedAt = new Map(); // key -> last time we told them they're throttled
  }

  // Returns { allowed, notify }. Records the hit when allowed. `now` is
  // injectable so the sliding window is testable without real timers.
  allow(key, now = Date.now()) {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) || []).filter((t) => t > cutoff);

    // delete+set moves this key to the end of the Map, so insertion order
    // doubles as an LRU list for eviction below.
    this.hits.delete(key);
    this.hits.set(key, recent);
    this._evict();

    if (recent.length < this.maxRequests) {
      recent.push(now);
      return { allowed: true, notify: false };
    }

    // Over the limit: notify at most once per window (default -Infinity so the
    // first breach always fires) — a spammer shouldn't get a flood of notices.
    const last = this.notifiedAt.get(key) ?? -Infinity;
    const notify = now - last >= this.windowMs;
    if (notify) this.notifiedAt.set(key, now);
    return { allowed: false, notify };
  }

  // Bound memory: customers churn, so drop the least-recently-touched keys
  // once we exceed the cap.
  _evict() {
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      this.hits.delete(oldest);
      this.notifiedAt.delete(oldest);
    }
  }
}
