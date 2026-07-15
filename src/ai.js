// Claude integration: turns a customer question (+ conversation history)
// into a reply grounded in knowledge/faq.md.
//
// Cost note: the system prompt (instructions + full FAQ) is identical on
// every request, so it carries a cache_control breakpoint — after the first
// message in any 5-minute window, the FAQ bills at ~10% of the input price.
// Only the short per-user history and the new question bill at full price.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-8';
const FALLBACK_REPLY =
  '抱歉，我暂时无法回答这个问题，稍后会有工作人员跟进。/ Sorry, I could not answer right now — a team member will follow up shortly.';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const faqPath = path.join(__dirname, '..', 'knowledge', 'faq.md');
const faq = fs.existsSync(faqPath) ? fs.readFileSync(faqPath, 'utf8') : '';

const SYSTEM = [
  {
    type: 'text',
    text: `You are the customer-service assistant for this business, replying inside WeChat (微信客服).

Rules:
- Answer ONLY from the knowledge base below. If the answer is not in it, say you don't know and that a human team member will follow up — never invent details about prices, policies, or availability.
- Reply in the language the customer used (usually Chinese).
- Keep replies short and chat-friendly: plain text, no markdown, no headings, under ~150 words.
- Be warm and professional.

# Knowledge base
${faq}`,
    cache_control: { type: 'ephemeral' },
  },
];

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

export async function generateReply(history, userText) {
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [...history, { role: 'user', content: userText }],
    });
    if (response.stop_reason === 'refusal') return FALLBACK_REPLY;
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return text || FALLBACK_REPLY;
  } catch (err) {
    console.error('Claude API error:', err.message);
    return FALLBACK_REPLY;
  }
}
