// Admin-surface authentication, scoped per tenant.
//
// The admin routes serve /bugs and /unanswered, which contain VERBATIM CUSTOMER MESSAGES.
// One shared token across every tenant meant whoever operates tenant A could read tenant B's
// customers — a real boundary hole the moment a second tenant exists, and the exact thing the
// rest of the multi-tenant work was for.
//
// Two levels:
//   ADMIN_TOKEN_<TENANT_ID>  — reads only that tenant.
//   ADMIN_TOKEN              — operator-wide: reads every tenant, and is the only thing that
//                              can list /tenants. A single-tenant deployment can keep using
//                              just this and behaves exactly as before.
//
// Tokens come from the environment, never from tenants/<id>.yaml — those files are committed
// to git, and a credential in the repo is a credential in every clone and every backup.

import { timingSafeEqual } from 'node:crypto';

/** ADMIN_TOKEN_<ID>, with the id upper-cased and non-alphanumerics folded to `_`. */
export const tokenEnvName = (tenantId: string): string =>
  `ADMIN_TOKEN_${tenantId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

/**
 * Constant-time string compare.
 *
 * `===` short-circuits at the first differing byte, so response timing leaks the token one
 * character at a time to anyone who can measure it. timingSafeEqual throws on a length
 * mismatch, so the length is checked first — that leaks only the length, which is not the
 * secret.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** True when `supplied` matches a configured, non-empty token. */
const matches = (supplied: string, configured: string | undefined): boolean =>
  !!configured && !!supplied && safeEqual(supplied, configured);

/**
 * The presented token, from `Authorization: Bearer <t>` or the legacy `?token=` query param.
 *
 * The header is preferred and is what the docs now recommend: query strings end up in access
 * logs, proxy logs, referrers and browser history. `?token=` stays supported because SETUP.md
 * shipped it and breaking an operator's saved curl command is a poor trade for a dev tool.
 */
export function presentedToken(headerValue: unknown, queryToken: unknown): string {
  const header = typeof headerValue === 'string' ? headerValue : '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (m) return m[1];
  return typeof queryToken === 'string' ? queryToken : '';
}

/** Operator-wide access: every tenant, plus /tenants. */
export function isOperator(supplied: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return matches(supplied, env.ADMIN_TOKEN);
}

/**
 * May `supplied` read `tenantId`? The tenant's own token, or the operator token.
 *
 * Fail-closed: with nothing configured, `matches` is false for both and every admin route is
 * refused. An unauthenticated admin surface would expose customer messages, so "no token set"
 * must mean "no access", never "no check".
 */
export function canReadTenant(
  supplied: string,
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isOperator(supplied, env) || matches(supplied, env[tokenEnvName(tenantId)]);
}
