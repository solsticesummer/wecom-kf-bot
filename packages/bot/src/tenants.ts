// Tenant loading: tenants/<id>.yaml → a validated Tenant object.
//
// A tenant binds a set of skills to one product: the config values those skills' prompts
// need, the knowledge namespace it answers from, and the model that serves it. Loading is
// eager and strict so a broken config fails at boot rather than mid-conversation.
//
// NOT here yet: routing an inbound message to a tenant by open_kfid, per-tenant state dirs,
// rate-limit keys and admin tokens. That's the tenant *registry*, and it's the next step —
// this module is deliberately just "read one tenant off disk".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { loadSkill, composeSystemRules, enabledActions, type Skill, type SkillAction } from './skills.js';

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
  model: { name: string; temperature: number; maxTokens: number };
  copy: TenantCopy;
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
    copy: loadCopy(id, cfg.copy ?? {}),
  };
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
 * The tenant this process serves. Single-tenant for now — the registry step replaces this
 * with a lookup keyed by the inbound message's open_kfid.
 */
export const activeTenant = (): Tenant => loadTenant(process.env.TENANT_ID || 'dramaclaw');
