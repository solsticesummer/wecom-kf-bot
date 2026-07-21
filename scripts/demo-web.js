// Dev-only web playground for the AI layer — a browser chat page so you can
// actually talk to the bot without WeCom. Same generateReply() and FAQ the
// real server uses; only the transport (a local web page) is different.
//
// Run:  node --env-file=.env scripts/demo-web.js   (needs DASHSCOPE_API_KEY)
// Then open http://localhost:3000
//
// Deliberately separate from src/server.js: this endpoint has no WeCom
// signature check, so it must never be part of the production server.

import express from 'express';
import { generateReply } from '../src/ai.js';

if (!process.env.DASHSCOPE_API_KEY) {
  console.error('DASHSCOPE_API_KEY is not set — run: node --env-file=.env scripts/demo-web.js');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());

app.post('/chat', async (req, res) => {
  const { message, history = [] } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message required' });
  }
  try {
    const r = await generateReply(history, message);
    res.json(r);
  } catch (err) {
    console.error('demo /chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (_req, res) => res.type('html').send(PAGE));

app.listen(PORT, () => {
  console.log(`DramaClaw 客服 测试台 → http://localhost:${PORT}`);
});

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DramaClaw 客服 · 测试台</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    background: linear-gradient(135deg, #fff4e6 0%, #ffe9f3 50%, #e8f4ff 100%);
    min-height: 100vh; display: flex; flex-direction: column; align-items: center;
    color: #2b2b3a;
  }
  header {
    width: 100%; max-width: 720px; padding: 20px 16px 8px; text-align: center;
  }
  header h1 { margin: 0; font-size: 22px; }
  header h1 .dot { color: #ff5da2; }
  header p { margin: 4px 0 0; font-size: 13px; color: #7a7a8c; }
  #chat {
    width: 100%; max-width: 720px; flex: 1; overflow-y: auto;
    padding: 16px; display: flex; flex-direction: column; gap: 12px;
  }
  .row { display: flex; }
  .row.me { justify-content: flex-end; }
  .bubble {
    max-width: 78%; padding: 10px 14px; border-radius: 16px; line-height: 1.5;
    font-size: 15px; white-space: pre-wrap; word-break: break-word;
    box-shadow: 0 2px 8px rgba(0,0,0,0.06);
  }
  .me .bubble { background: linear-gradient(135deg,#ff8fb1,#ff5da2); color:#fff; border-bottom-right-radius: 4px; }
  .bot .bubble { background: #ffffff; color: #2b2b3a; border-bottom-left-radius: 4px; }
  .tag {
    display: inline-block; margin-top: 6px; font-size: 11px; font-weight: 600;
    padding: 2px 8px; border-radius: 999px; letter-spacing: .3px;
  }
  .tag.answer   { background:#e3f9e5; color:#1b7a2f; }
  .tag.handoff  { background:#fff0d9; color:#b76e00; }
  .tag.bug      { background:#ffe0e0; color:#c0392b; }
  .tag.account  { background:#e5efff; color:#1c62c9; }
  .meta { font-size: 11px; color:#9a9aad; margin-top: 4px; }
  form {
    width: 100%; max-width: 720px; display: flex; gap: 8px; padding: 12px 16px 20px;
    position: sticky; bottom: 0;
  }
  #msg {
    flex: 1; padding: 12px 14px; border: 2px solid #ffd0e2; border-radius: 14px;
    font-size: 15px; outline: none; background:#fff;
  }
  #msg:focus { border-color:#ff5da2; }
  button {
    padding: 0 20px; border: none; border-radius: 14px; font-size: 15px; font-weight: 600;
    color:#fff; background: linear-gradient(135deg,#ffb454,#ff5da2); cursor: pointer;
  }
  button:disabled { opacity:.5; cursor: default; }
  .hint { color:#9a9aad; font-size: 13px; text-align:center; margin: 24px 0; }
</style>
</head>
<body>
  <header>
    <h1>DramaClaw 客服<span class="dot"> · </span>测试台</h1>
    <p>本地测试用 · 换个说法、用英文、问产品外的问题都试试看</p>
  </header>
  <div id="chat">
    <div class="hint">发一条消息开始对话，比如「虾镜是干嘛的？」或「How do I start?」</div>
  </div>
  <form id="f">
    <input id="msg" autocomplete="off" placeholder="输入客户消息…" autofocus>
    <button id="send" type="submit">发送</button>
  </form>
<script>
  const chat = document.getElementById('chat');
  const form = document.getElementById('f');
  const input = document.getElementById('msg');
  const sendBtn = document.getElementById('send');
  const history = [];

  function add(role, text, tag, meta) {
    const row = document.createElement('div');
    row.className = 'row ' + (role === 'me' ? 'me' : 'bot');
    const b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = text;
    if (tag) {
      const t = document.createElement('div');
      t.className = 'tag ' + tag;
      t.textContent = tag;
      b.appendChild(document.createElement('br'));
      b.appendChild(t);
    }
    if (meta) {
      const m = document.createElement('div');
      m.className = 'meta';
      m.textContent = meta;
      b.appendChild(m);
    }
    row.appendChild(b);
    chat.appendChild(row);
    chat.scrollTop = chat.scrollHeight;
    return b;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendBtn.disabled = true;
    add('me', text);
    const thinking = add('bot', '…');
    const t0 = Date.now();
    try {
      const res = await fetch('/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text, history }),
      });
      const r = await res.json();
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      thinking.textContent = r.reply || ('[error] ' + (r.error || 'no reply'));
      if (r.action) {
        const t = document.createElement('div');
        t.className = 'tag ' + r.action;
        t.textContent = r.action + (r.handoffReason ? ' · ' + r.handoffReason : '');
        thinking.appendChild(document.createElement('br'));
        thinking.appendChild(t);
      }
      const tok = r.usage ? r.usage.totalTokens + ' tokens · ' : '';
      const m = document.createElement('div');
      m.className = 'meta';
      m.textContent = tok + secs + 's';
      thinking.appendChild(m);
      if (r.reply) {
        history.push({ role: 'user', content: text });
        history.push({ role: 'assistant', content: r.reply });
      }
    } catch (err) {
      thinking.textContent = '[network error] ' + err.message;
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  });
</script>
</body>
</html>`;
