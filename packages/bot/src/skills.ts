// Skill loading, validation and prompt rendering.
//
// A skill is DATA, not code: a directory holding `skill.yaml` (the action contract + the
// config slots it needs) and `prompt.md` (the prose, with {{slots}}). This module turns that
// pair plus a tenant's config into the system prompt string and the validated action
// taxonomy the runtime enforces.
//
// Everything here fails LOUDLY at load time. A skill/tenant mismatch that survived to
// runtime would ship a literal "{{productName}}" to a paying customer, or accept an action
// the dispatcher has no handler for — both are worse than refusing to boot.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// ../skills resolves the same from src/ (tsx) and from dist/src/ (compiled), as long as the
// build copies skills/ next to dist/src — see the `build` script in package.json.
const SKILLS_DIR = path.join(__dirname, '..', 'skills');

export interface SkillAction {
  name: string;
  /** Bullet shown to the model in the action list. */
  prompt: string;
  /** Move the conversation to the human queue after the reply is sent. */
  handoff: boolean;
  /** Off unless the tenant opts in via `optional_actions`. */
  optional: boolean;
  /** Extra JSON field the model must fill for this action ('bug_summary' | 'handoff_reason'). */
  requires?: string;
}

export interface Skill {
  name: string;
  description: string;
  /** Config keys this skill's prompt requires from the tenant. */
  configKeys: string[];
  actions: SkillAction[];
  handoffReasons: { name: string; prompt: string }[];
  /** Raw prompt.md, {{slots}} unrendered. */
  template: string;
}

/** Chinese numerals for the "choose one of N" counts. Only small N is ever needed. */
const CN_NUMERALS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const cnNumeral = (n: number): string => CN_NUMERALS[n] ?? String(n);

/**
 * Substitute every {{slot}} in `template` from `values`.
 *
 * Strict in both directions on purpose:
 * - an unknown slot throws (a typo in prompt.md would otherwise reach a customer verbatim)
 * - an unused value throws (a renamed slot would otherwise leave the tenant silently ignored)
 *
 * A slot alone on its own line whose value is empty removes the whole line, so an optional
 * block leaves no blank gap behind.
 */
export function render(template: string, values: Record<string, string>): string {
  const used = new Set<string>();

  // Whole-line slots first, so an empty value takes the newline with it.
  let out = template.replace(/^[ \t]*\{\{(\w+)\}\}[ \t]*\n/gm, (_m, key: string) => {
    if (!(key in values)) throw new Error(`prompt slot {{${key}}} has no value`);
    used.add(key);
    return values[key] === '' ? '' : `${values[key]}\n`;
  });

  out = out.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    if (!(key in values)) throw new Error(`prompt slot {{${key}}} has no value`);
    used.add(key);
    return values[key];
  });

  const unused = Object.keys(values).filter((k) => !used.has(k));
  if (unused.length) throw new Error(`config keys never used by the prompt: ${unused.join(', ')}`);
  return out;
}

/** Load and validate one skill directory (skills/<name>/). Throws on any malformed field. */
export function loadSkill(name: string): Skill {
  const dir = path.join(SKILLS_DIR, name);
  const meta = parseYaml(fs.readFileSync(path.join(dir, 'skill.yaml'), 'utf8'));
  // Files conventionally end with a newline; the composed prompt must not.
  const template = fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8').replace(/\n$/, '');

  const actions: SkillAction[] = (meta.actions ?? []).map((a: any) => {
    if (!a?.name || typeof a.prompt !== 'string') {
      throw new Error(`skill ${name}: every action needs a name and a prompt`);
    }
    return {
      name: a.name,
      prompt: a.prompt,
      handoff: a.handoff === true,
      optional: a.optional === true,
      requires: a.requires,
    };
  });
  if (!actions.length) throw new Error(`skill ${name}: no actions declared`);

  return {
    name: meta.name ?? name,
    description: meta.description ?? '',
    configKeys: Object.keys(meta.config ?? {}),
    actions,
    handoffReasons: meta.handoff_reasons ?? [],
    template,
  };
}

/**
 * Compose a skill's system prompt for one tenant.
 *
 * The action and handoff-reason bullets are GENERATED from skill.yaml rather than written
 * out in prompt.md, so the taxonomy the model is told about is by construction the same one
 * `enabledActions()` validates against. The "choose one of N" counts are derived for the
 * same reason — with `account` switched off, a hardcoded 四 would lie to the model.
 */
export function composeSystemRules(skill: Skill, config: Record<string, string>, optionalActions: string[]): string {
  const missing = skill.configKeys.filter((k) => !(k in config));
  if (missing.length) throw new Error(`skill ${skill.name}: tenant is missing config: ${missing.join(', ')}`);

  const actions = enabledActions(skill, optionalActions);
  const bullet = (name: string, text: string) => `  - "${name}"：${text}`;

  return render(skill.template, {
    ...config,
    actionCount: cnNumeral(actions.length),
    actionList: actions.map((a) => bullet(a.name, a.prompt)).join('\n'),
    handoffReasonCount: cnNumeral(skill.handoffReasons.length),
    handoffReasonList: skill.handoffReasons.map((r) => bullet(r.name, r.prompt)).join('\n'),
  });
}

/**
 * The actions in play for one tenant: every non-optional action, plus the optional ones it
 * opted into. Throws on an opt-in that names an action the skill doesn't have (a typo in the
 * tenant file would otherwise silently disable a flow the tenant is paying for).
 */
export function enabledActions(skill: Skill, optionalActions: string[]): SkillAction[] {
  const unknown = optionalActions.filter((n) => !skill.actions.some((a) => a.name === n && a.optional));
  if (unknown.length) {
    throw new Error(`skill ${skill.name}: no optional action named ${unknown.join(', ')}`);
  }
  return skill.actions.filter((a) => !a.optional || optionalActions.includes(a.name));
}
