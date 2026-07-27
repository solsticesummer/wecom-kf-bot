// Per-tenant daily spend caps.
//
// ratelimit.ts caps how fast ONE CUSTOMER can send messages. That protects against a single
// spammer, but not against the bill: a hundred well-behaved customers, a retry loop, or one
// tenant's launch day can each burn the whole DashScope quota without any single customer
// tripping the rate limit. This caps what a TENANT costs per day.
//
// No new persistence — the per-tenant StateStore already tallies calls and tokens per UTC day
// (state.ts addUsage), which is exactly the number a cap needs.

import type { StateStore } from './state.js';
import type { Tenant } from './tenants.js';

export interface TenantLimits {
  /** Max total tokens (prompt + completion) per UTC day. 0/absent = unlimited. */
  dailyTokens?: number;
  /** Max model calls per UTC day. 0/absent = unlimited. */
  dailyCalls?: number;
}

export interface QuotaStatus {
  allowed: boolean;
  /** Which limit tripped, for logging. */
  exceeded?: 'tokens' | 'calls';
  usedTokens: number;
  usedCalls: number;
  limits: TenantLimits;
}

/** The UTC date key state.ts tallies under. Injectable so tests don't wait for midnight. */
export const dayKey = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

/**
 * Is this tenant still within today's budget?
 *
 * NOTE: this answers "already over", not "would go over". A model call's cost isn't known
 * until it returns, so the last message before the cap trips is still paid for — the
 * overshoot is bounded by the tenant's `max_tokens`. Pre-reserving a worst-case budget per
 * message would be more precise and would also throttle a tenant well below its actual limit,
 * which is the worse trade for a customer-facing bot.
 */
export function checkQuota(
  tenant: Tenant,
  store: StateStore,
  now: Date = new Date(),
): QuotaStatus {
  const limits = tenant.limits;
  const today = store.getUsage()[dayKey(now)];
  const usedTokens = today?.totalTokens ?? 0;
  const usedCalls = today?.calls ?? 0;

  // A limit of 0 or undefined means "no cap" — a tenant that doesn't opt in must behave
  // exactly as it did before this existed, not get silently capped at zero.
  const overTokens = !!limits.dailyTokens && usedTokens >= limits.dailyTokens;
  const overCalls = !!limits.dailyCalls && usedCalls >= limits.dailyCalls;

  return {
    allowed: !overTokens && !overCalls,
    exceeded: overTokens ? 'tokens' : overCalls ? 'calls' : undefined,
    usedTokens,
    usedCalls,
    limits,
  };
}
