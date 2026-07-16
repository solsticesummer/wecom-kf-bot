// Dev-only REPL for testing the AI layer without WeCom.
// Usage: node --env-file=.env scripts/chat.js   (needs DASHSCOPE_API_KEY)
//
// Talks to the real Qwen API through the real generateReply(), with the real
// FAQ — the only thing simulated is the customer typing in a terminal
// instead of WeChat. Prints the action the bot chose so the scripted flows
// (answer / account / handoff / bug) can be verified by eye.

import readline from 'node:readline/promises';
import { generateReply } from '../src/ai.js';

if (!process.env.DASHSCOPE_API_KEY) {
  console.error('DASHSCOPE_API_KEY is not set — run with: node --env-file=.env scripts/chat.js');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const history = [];

console.log('DramaClaw 客服 AI 测试 — 输入客户消息，Ctrl+C 退出\n');

while (true) {
  const text = (await rl.question('客户> ')).trim();
  if (!text) continue;
  const started = Date.now();
  const { action, reply, bugSummary } = await generateReply(history, text);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n[action: ${action}${bugSummary ? ` | bug: ${bugSummary}` : ''} | ${seconds}s]`);
  console.log(`客服> ${reply}\n`);
  history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
}
