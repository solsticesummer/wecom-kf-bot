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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { search } from './retrieval.js';
import { postJson } from './http.js';
import { buildSystemRules, DRAMACLAW } from './prompt.js';
import type { Usage } from './state.js';

const MODEL = process.env.QWEN_MODEL || 'qwen3.7-plus';
const API_URL =
  process.env.QWEN_API_URL ||
  'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

// Sampling temperature: higher = more varied/original wording (less FAQ-parroting),
// lower = more repetitive/safe. 0.6 is a balanced default; tune via env without a
// code change. Grounding is enforced by the prompt, not by keeping this low.
const TEMPERATURE = Number(process.env.QWEN_TEMPERATURE || 0.6);

const HANDOFF_REPLY = '抱歉，我暂时无法处理您的问题，正在为您转接人工客服，请稍候。';

// Why the bot handed off, used to filter the coverage-gap log. The first two
// are genuine "couldn't answer" gaps worth adding to the FAQ; the rest are
// by-design handoffs. 'api_error' is set by us (not the model) on a fallback.
const HANDOFF_REASONS = ['not_in_kb', 'unclear', 'user_request', 'upset', 'business', 'discount'];

// The static rules half of the system prompt is now assembled from a tenant
// config (prompt.ts). The knowledge block is appended per-request from
// retrieval (see generateReply), not baked in here.
const SYSTEM_RULES = buildSystemRules(DRAMACLAW);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const faqPath = path.join(__dirname, '..', 'knowledge', 'faq.md');
// Kept only as the degradation fallback: if retrieval fails we inline the whole FAQ
// (zero regression while the KB still fits the context window). Not the default anymore.
const fullFaq = fs.existsSync(faqPath) ? fs.readFileSync(faqPath, 'utf8') : '';

export type Action = 'answer' | 'account' | 'handoff' | 'bug';

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
  history: ChatMessage[],
  userText: string,
): Promise<GenerateResult> {
  // Retrieve the few relevant KB chunks for this question. Any failure (no DB, no
  // Model Studio key, embedding/rerank down) degrades to inlining the full FAQ, so a
  // retrieval outage never turns into a handoff. Empty result → also fall back.
  let knowledge: string;
  try {
    knowledge = (await search(userText)).map((c) => c.content).join('\n\n');
    if (!knowledge) knowledge = fullFaq;
  } catch (err) {
    console.error('retrieval failed, using full FAQ:', err.message);
    knowledge = fullFaq;
  }
  // Static rules first (cacheable prefix), variable knowledge last.
  const system = `${SYSTEM_RULES}\n\n# 知识库\n${knowledge}`;

  let raw: string;
  let usage: Usage | undefined; // token counts from the API, threaded out so callers can log cost
  try {
    const data = await callModel(
      JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        temperature: TEMPERATURE,
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

  const action: Action = (['answer', 'account', 'handoff', 'bug'] as const).includes(parsed.action)
    ? parsed.action
    : 'answer';
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
