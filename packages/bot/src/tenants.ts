// Tenant loading and routing: tenants/*.yaml → validated Tenants, indexed by open_kfid.
//
// A tenant binds a set of skills to one product: the config values those skills' prompts
// need, the knowledge namespace it answers from, and the model that serves it. Loading is
// eager and strict so a broken config fails at boot rather than mid-conversation.
//
// `open_kfid` is the natural tenant key on WeCom: the 微信客服 callback is enterprise-wide,
// so every kf account's messages already arrive at one endpoint and the pipeline is forced
// to route by kf account anyway. Making that routing table the tenant registry turns the old
// ALLOWED_KF_IDS safety allowlist from an env var into a structural property — an
// unregistered kf account cannot be answered because there is no tenant to answer it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { loadSkill, composeSystemRules, enabledActions, type Skill, type SkillAction } from './skills.js';
import type { TenantLimits } from './quota.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TENANTS_DIR = path.join(__dirname, '..', 'tenants');

export interface Tenant {
  id: string;
  skill: Skill;
  /** Actions this tenant actually runs (mandatory ones + its opted-in optional ones). */
  actions: SkillAction[];
  /** The composed system prompt: static rules only, knowledge is appended per request. */
  systemRules: string;
  /** Which corpus in the `chunks` table to retrieve from. */
  namespace: string;
  /**
   * This tenant's whole knowledge corpus, inlined verbatim when retrieval fails.
   *
   * Per-tenant on purpose. It used to be one global read of knowledge/faq.md, which was
   * correct while one process served one product and silently wrong the moment it didn't:
   * a database blip would have pasted DramaClaw's entire FAQ — prices, policies — into
   * another tenant's system prompt. Empty when the tenant declares no fallback, which
   * degrades to "answer from nothing" rather than to someone else's facts.
   */
  fallbackFaq: string;
  model: { name: string; temperature: number; maxTokens: number };
  /** Daily spend caps. Empty object = uncapped (see quota.ts). */
  limits: TenantLimits;
  copy: TenantCopy;
  /** WeCom kf accounts (open_kfid) whose conversations this tenant serves. */
  kfIds: string[];
}

/** Fixed strings the bot sends without consulting the model. */
export interface TenantCopy {
  welcome: string;
  menuHead: string;
  menuItem: string;
  handoffReply: string;
  creditsTip: string;
  rateLimit: string;
  apiErrorReply: string;
  /** Sent when the tenant's daily budget is spent — see quota.ts. */
  quotaExceeded: string;
}

/**
 * Read and validate one tenant. Composing the prompt here (rather than lazily per message)
 * means a bad skill/tenant pairing surfaces at startup, and the result is computed once
 * instead of on every customer message.
 */
export function loadTenant(id: string): Tenant {
  const cfg = parseYaml(fs.readFileSync(path.join(TENANTS_DIR, `${id}.yaml`), 'utf8'));

  // One skill per tenant for now. Multi-skill composition needs a merge order and a
  // conflict rule for overlapping action names — not worth designing before a second skill
  // exists to tell us what the right rule is.
  const skillNames: string[] = cfg.skills ?? [];
  if (skillNames.length !== 1) {
    throw new Error(`tenant ${id}: expected exactly one skill, got ${skillNames.length}`);
  }
  const skill = loadSkill(skillNames[0]);
  const optional: string[] = cfg.optional_actions ?? [];

  if (!cfg.namespace) throw new Error(`tenant ${id}: namespace is required`);

  return {
    id: cfg.id ?? id,
    skill,
    actions: enabledActions(skill, optional),
    systemRules: composeSystemRules(skill, cfg.config ?? {}, optional),
    namespace: cfg.namespace,
    model: {
      name: cfg.model?.name ?? 'qwen3.7-plus',
      temperature: cfg.model?.temperature ?? 0.6,
      maxTokens: cfg.model?.max_tokens ?? 512,
    },
    limits: {
      dailyTokens: Number(cfg.limits?.daily_tokens ?? 0) || undefined,
      dailyCalls: Number(cfg.limits?.daily_calls ?? 0) || undefined,
    },
    copy: loadCopy(id, cfg.copy ?? {}),
    kfIds: (cfg.wecom?.kf_ids ?? []).map(String).filter(Boolean),
    fallbackFaq: loadFallbackFaq(id, cfg.fallback_faq),
  };
}

const KNOWLEDGE_DIR = path.join(__dirname, '..', 'knowledge');

/** Read the tenant's fallback corpus from knowledge/<file>. Absent → no fallback. */
function loadFallbackFaq(id: string, file: unknown): string {
  if (!file) {
    console.warn(`tenant ${id}: no fallback_faq — a retrieval outage will answer from nothing`);
    return '';
  }
  // Contain the path to knowledge/: the filename comes from a config file, and a tenant
  // should not be able to name ../../.env and have it read into a prompt sent to a customer.
  const resolved = path.resolve(KNOWLEDGE_DIR, String(file));
  if (path.relative(KNOWLEDGE_DIR, resolved).startsWith('..')) {
    throw new Error(`tenant ${id}: fallback_faq must stay inside knowledge/ (got ${file})`);
  }
  if (!fs.existsSync(resolved)) throw new Error(`tenant ${id}: fallback_faq not found: ${file}`);
  return fs.readFileSync(resolved, 'utf8');
}

// snake_case in YAML (idiomatic there) → camelCase in TS (house style).
const COPY_KEYS: [keyof TenantCopy, string][] = [
  ['welcome', 'welcome'],
  ['menuHead', 'menu_head'],
  ['menuItem', 'menu_item'],
  ['handoffReply', 'handoff_reply'],
  ['creditsTip', 'credits_tip'],
  ['rateLimit', 'rate_limit'],
  ['apiErrorReply', 'api_error_reply'],
  ['quotaExceeded', 'quota_exceeded'],
];

/**
 * Every copy string is required — no defaults. A missing key would otherwise reach a
 * customer as the literal text "undefined", and unlike a crash that failure is silent and
 * lands in a real conversation.
 */
function loadCopy(id: string, raw: Record<string, unknown>): TenantCopy {
  const copy = {} as TenantCopy;
  const missing: string[] = [];
  for (const [tsKey, yamlKey] of COPY_KEYS) {
    const val = raw[yamlKey];
    if (typeof val !== 'string' || !val.trim()) missing.push(yamlKey);
    else copy[tsKey] = val;
  }
  if (missing.length) throw new Error(`tenant ${id}: missing copy: ${missing.join(', ')}`);
  return copy;
}

/**
 * Every tenant this deployment serves, indexed for routing.
 *
 * Built once at boot: a malformed tenant, or two tenants claiming the same kf account, is a
 * deployment mistake that should stop the process, not something to discover on a live
 * message. Nothing here reloads at runtime — adding a tenant is a restart.
 */
export class TenantRegistry {
  private readonly byKfId = new Map<string, Tenant>();
  private readonly byId = new Map<string, Tenant>();

  constructor(tenants: Tenant[]) {
    if (tenants.length === 0) throw new Error('tenant registry: no tenants/*.yaml found');
    for (const t of tenants) {
      if (this.byId.has(t.id)) throw new Error(`tenant registry: duplicate tenant id ${t.id}`);
      this.byId.set(t.id, t);
      for (const kfId of t.kfIds) {
        // Two tenants claiming one kf account has no correct resolution — whichever won
        // would answer that account's customers in the wrong product's voice, from the wrong
        // knowledge base. Refuse to start instead of picking.
        const owner = this.byKfId.get(kfId);
        if (owner) {
          throw new Error(
            `tenant registry: kf account ${kfId} claimed by both ${owner.id} and ${t.id}`,
          );
        }
        this.byKfId.set(kfId, t);
      }
    }
  }

  /**
   * The tenant serving this kf account, or undefined if none does.
   *
   * Fail-closed by construction: an unregistered (or absent) open_kfid returns undefined and
   * the caller drops the message. This subsumes what ALLOWED_KF_IDS did — with the safety
   * property now coming from "no tenant exists to answer" rather than from remembering to
   * set an env var.
   */
  forKfId(kfId: string | undefined): Tenant | undefined {
    return kfId ? this.byKfId.get(kfId) : undefined;
  }

  get(id: string): Tenant | undefined {
    return this.byId.get(id);
  }

  all(): Tenant[] {
    return [...this.byId.values()];
  }

  /** Which tenant the legacy un-prefixed admin routes report on. */
  get defaultTenant(): Tenant {
    const id = process.env.DEFAULT_TENANT_ID;
    if (id) {
      const t = this.byId.get(id);
      if (!t) throw new Error(`DEFAULT_TENANT_ID=${id} matches no tenant`);
      return t;
    }
    return this.all()[0];
  }
}

/** Load and validate every tenants/*.yaml. */
export function loadRegistry(): TenantRegistry {
  const ids = fs
    .readdirSync(TENANTS_DIR)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map((f) => f.replace(/\.ya?ml$/, ''))
    .sort();
  return new TenantRegistry(ids.map(loadTenant));
}
