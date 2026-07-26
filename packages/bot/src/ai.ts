// Qwen (Aliyun DashScope) integration: turns a customer question (+ history)
// into a structured decision grounded in knowledge/faq.md.
//
// One call does two jobs — answering AND triage — by asking the model for a
// JSON object: { action: "answer" | "handoff" | "bug", reply, bug_summary }.
// A separate "did the bot fail?" classification call would double cost and
// latency for no accuracy gain.
//
// Efficiency notes:
// - enable_thinking:false turns off Qwen3's reasoning mode (a thinking trace
//   would cost tokens and seconds per message; FAQ lookup doesn't need it).
// - DashScope applies implicit context caching to the repeated system prompt
//   automatically — no cache_control markup needed (unlike the Claude API).

import { search } from './retrieval.js';
import { postJson } from './http.js';
import type { Tenant } from './tenants.js';
import type { Usage } from './state.js';

const API_URL =
  process.env.QWEN_API_URL ||
  'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

// Everything tenant-scoped — the composed system prompt, the action taxonomy, the handoff
// reasons, the model and its sampling settings — arrives as the `tenant` argument to
// generateReply. It used to be a module-level singleton read at import time, which quietly
// stopped being correct the moment one process could serve two tenants: the first import
// would have pinned one product's prompt and model for every conversation, including the
// other tenant's. The knowledge block is still appended per-request from retrieval.

// Was a hardcoded union; the action set is now whatever the tenant's skill declares, so it
// can only be validated at runtime (against ACTION_NAMES) rather than by the compiler.
export type Action = string;

export interface ChatMessage {
  role: string;
  content: string;
}

export interface GenerateResult {
  action: Action;
  reply: string;
  bugSummary: string;
  handoffReason: string;
  usage?: Usage;
}

// Exported for tests. The model is told to output bare JSON, but LLMs
// sometimes wrap it in ```json fences or prepend a phrase — recover the
// object rather than failing the whole reply.
export function parseModelJson(text: string): any | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// POST to Qwen (with the shared retry/backoff client). `body` is already a
// JSON string. Returns the parsed JSON body, or throws after exhausting retries.
async function callModel(body: string): Promise<any> {
  return postJson(API_URL, { body, apiKey: process.env.DASHSCOPE_API_KEY });
}

// Returns { action, reply, bugSummary, handoffReason, usage }.
// Never throws — API/parse failures degrade to a handoff so the customer is
// picked up by a human instead of being left on read.
export async function generateReply(
  tenant: Tenant,
  history: ChatMessage[],
  userText: string,
): Promise<GenerateResult> {
  const HANDOFF_REPLY = tenant.copy.apiErrorReply;
  // Read off the skill so the list the model is shown and the list we validate against
  // cannot drift. 'api_error' is deliberately absent — we set it ourselves on a fallback,
  // the model never chooses it.
  const HANDOFF_REASONS = tenant.skill.handoffReasons.map((r) => r.name);
  const ACTION_NAMES = tenant.actions.map((a) => a.name);

  // Retrieve the few relevant KB chunks for this question. Any failure (no DB, no
  // Model Studio key, embedding/rerank down) degrades to inlining THIS TENANT's full FAQ, so
  // a retrieval outage never turns into a handoff. Empty result → also fall back.
  let knowledge: string;
  try {
    knowledge = (await search(userText, { namespace: tenant.namespace })).map((c) => c.content).join('\n\n');
    if (!knowledge) knowledge = tenant.fallbackFaq;
  } catch (err) {
    console.error(`retrieval failed for ${tenant.id}, using full FAQ:`, err.message);
    knowledge = tenant.fallbackFaq;
  }
  // Static rules first (cacheable prefix), variable knowledge last.
  const system = `${tenant.systemRules}\n\n# 知识库\n${knowledge}`;

  let raw: string;
  let usage: Usage | undefined; // token counts from the API, threaded out so callers can log cost
  try {
    const data = await callModel(
      JSON.stringify({
        model: tenant.model.name,
        max_tokens: tenant.model.maxTokens,
        temperature: tenant.model.temperature,
        response_format: { type: 'json_object' },
        enable_thinking: false,
        messages: [
          { role: 'system', content: system },
          ...history,
          { role: 'user', content: userText },
        ],
      }),
    );
    raw = data.choices?.[0]?.message?.content ?? '';
    // Normalize the API's snake_case usage to our camelCase house style.
    if (data.usage) {
      usage = {
        promptTokens: data.usage.prompt_tokens ?? 0,
        completionTokens: data.usage.completion_tokens ?? 0,
        totalTokens: data.usage.total_tokens ?? 0,
      };
    }
  } catch (err) {
    console.error('Qwen API error:', err.message);
    return { action: 'handoff', reply: HANDOFF_REPLY, bugSummary: '', handoffReason: 'api_error' };
  }

  const parsed = parseModelJson(raw);
  if (!parsed || typeof parsed.reply !== 'string' || !parsed.reply.trim()) {
    // Model didn't give us a usable object. If it produced real prose, send that
    // as a plain answer. But at higher temperature it sometimes leaks JSON debris
    // (a bare "action", a half-formed object) — sending that to a customer is
    // worse than a handoff, so only accept prose that doesn't look like debris.
    const fallbackText = raw.trim();
    const isDebris =
      !fallbackText ||
      /^[{["]/.test(fallbackText) ||
      /^"?(action|reply|answer|handoff|bug|account|bug_summary|handoff_reason)"?$/i.test(fallbackText);
    return isDebris
      ? { action: 'handoff', reply: HANDOFF_REPLY, bugSummary: '', handoffReason: 'api_error', usage }
      : { action: 'answer', reply: fallbackText, bugSummary: '', handoffReason: '', usage };
  }

  // An action the tenant doesn't run (a hallucinated name, or one belonging to an optional
  // flow this tenant left off) degrades to 'answer': the reply text is still usable, and
  // silently answering beats dispatching to a handler that doesn't exist.
  const action: Action = ACTION_NAMES.includes(parsed.action) ? parsed.action : 'answer';
  // Only handoffs carry a reason. An untagged/invalid handoff defaults to
  // 'not_in_kb' — better to over-surface a real gap than hide it in the log.
  const handoffReason =
    action === 'handoff'
      ? HANDOFF_REASONS.includes(parsed.handoff_reason)
        ? parsed.handoff_reason
        : 'not_in_kb'
      : '';
  return {
    action,
    reply: parsed.reply.trim(),
    bugSummary: typeof parsed.bug_summary === 'string' ? parsed.bug_summary.trim() : '',
    handoffReason,
    usage,
  };
}
