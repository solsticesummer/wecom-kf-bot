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

const MODEL = process.env.QWEN_MODEL || 'qwen3.7-plus';
const API_URL =
  process.env.QWEN_API_URL ||
  'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

const HANDOFF_REPLY = '抱歉，我暂时无法处理您的问题，正在为您转接人工客服，请稍候。';

// Why the bot handed off, used to filter the coverage-gap log. The first two
// are genuine "couldn't answer" gaps worth adding to the FAQ; the rest are
// by-design handoffs. 'api_error' is set by us (not the model) on a fallback.
const HANDOFF_REASONS = ['not_in_kb', 'unclear', 'user_request', 'upset', 'business', 'discount'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const faqPath = path.join(__dirname, '..', 'knowledge', 'faq.md');
const faq = fs.existsSync(faqPath) ? fs.readFileSync(faqPath, 'utf8') : '';

const SYSTEM = `你是本企业在微信客服里的智能客服助手，根据下方知识库回答客户的简单问题。

回复规则：
- 只根据知识库回答产品相关问题。知识库里没有的价格、政策、库存、账号等具体信息，绝对不能编造。
- 抓住客户问题里的关键词和真实意图去匹配知识库。客户的说法、用词、语言可能和知识库不一样（同义词、口语、不同问法都要理解）。只要知识库里有相关信息，就像 ChatGPT、Claude 那样把信息整理成自然、有帮助的回答，可以综合多处内容，不要生硬照抄，也不要因为措辞不同就轻易转人工。
- 语言：默认用简体中文。如果客户用其他语言（英文等）提问，就用客户所用的那种语言回答。
- 只回答与 DramaClaw 产品相关的问题。与产品无关的常识、闲聊或其他领域问题（天气、数学、编程、时政、情感等），礼貌说明你只能协助 DramaClaw 相关的问题，不要回答其内容，也不要转人工（action 用 "answer"）。
- 回复要简短、口语化、适合聊天窗口：纯文本，不用 markdown，不用标题；一般 150 字以内，需要分步骤说明时可适当加长但不要啰嗦。
- 态度亲切、专业。

输出格式：每次只输出一个 JSON 对象（不要任何其他文字），字段如下：
- "action"：四选一
  - "answer"：知识库能回答这个产品问题；或者客户问的是与 DramaClaw 无关的问题，此时用 reply 礼貌婉拒（只说你能协助 DramaClaw 相关的问题），不要转人工。
  - "account"：客户想申请测试账号 / 想要测试（关键词：申请账号、测试）。reply 固定为「稍等，马上为您申请测试账号」，工作人员会跟进分发账号。
  - "handoff"：需要转人工——限于：与产品相关但知识库回答不了、看不懂客户在说什么、客户主动要求人工、客户情绪激动、涉及退款或投诉纠纷、客户提出商务合作（关键词：合作）、客户想谈充值优惠。注意：与产品无关的闲聊或常识问题不要转人工，用 answer 婉拒即可。
  - "bug"：客户在报告产品故障、bug、异常或使用问题
- "reply"：发给客户的话。
  - action 为 "handoff" 时按场景回复：商务合作 →「请稍等，我这边联系商务与您具体联系，方便告知您的联系方式以及贵公司名称吗？」；谈充值优惠 →「您这边有哪些具体需求呢？我这边也好申请更多优惠」；其他情况告诉客户正在转接人工客服。
  - action 为 "bug" 时，reply 要告诉客户问题已记录、正在转接人工客服。
- "bug_summary"：仅当 action 为 "bug" 时填写，用一句话概括客户报告的问题。
- "handoff_reason"：仅当 action 为 "handoff" 时填写，从以下六选一，用于区分「真正答不上来」和「本就该转人工」：
  - "not_in_kb"：知识库里没有相关信息，答不了
  - "unclear"：看不懂客户想问什么
  - "user_request"：客户主动要求人工
  - "upset"：客户情绪激动、退款或投诉纠纷
  - "business"：商务合作
  - "discount"：想谈充值优惠

# 知识库
${faq}`;

// Exported for tests. The model is told to output bare JSON, but LLMs
// sometimes wrap it in ```json fences or prepend a phrase — recover the
// object rather than failing the whole reply.
export function parseModelJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Returns { action: 'answer'|'handoff'|'bug', reply, bugSummary }.
// Never throws — API/parse failures degrade to a handoff so the customer is
// picked up by a human instead of being left on read.
export async function generateReply(history, userText) {
  let raw;
  let usage; // token counts from the API, threaded out so callers can log cost
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        enable_thinking: false,
        messages: [
          { role: 'system', content: SYSTEM },
          ...history,
          { role: 'user', content: userText },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`${res.status} ${data?.error?.message || data?.message || ''}`);
    }
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
    // Model ignored the format. If it at least produced text, send that as a
    // plain answer; a truly empty response becomes a handoff.
    const fallbackText = raw.trim();
    return fallbackText
      ? { action: 'answer', reply: fallbackText, bugSummary: '', handoffReason: '', usage }
      : { action: 'handoff', reply: HANDOFF_REPLY, bugSummary: '', handoffReason: 'api_error', usage };
  }

  const action = ['answer', 'account', 'handoff', 'bug'].includes(parsed.action)
    ? parsed.action
    : 'answer';
  // Only handoffs carry a reason. An untagged/invalid handoff defaults to
  // 'not_in_kb' — better to over-surface a real gap than hide it in the log.
  const handoffReason =
    action === 'handoff'
      ? (HANDOFF_REASONS.includes(parsed.handoff_reason) ? parsed.handoff_reason : 'not_in_kb')
      : '';
  return {
    action,
    reply: parsed.reply.trim(),
    bugSummary: typeof parsed.bug_summary === 'string' ? parsed.bug_summary.trim() : '',
    handoffReason,
    usage,
  };
}
