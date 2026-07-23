# First-time setup — from zero to a live bot

This is the hand-holding walkthrough: follow it top to bottom and you'll end with a
working 微信客服 bot that answers customers and can hand them to a real person.

If you already know your way around the WeCom console and just want the terse facts,
the [README](./README.md) has them by topic. This guide is the *linear path* for a
first deploy.

> **How the pieces fit together.** A customer messages your 微信客服 account inside
> WeChat → WeCom forwards an (encrypted) event to *your* server → your server pulls the
> message, asks Qwen for an answer, and sends the reply back through WeCom. So you need
> three things wired together: a **WeCom account**, an **Aliyun 百炼 key** (the brain),
> and a **server with a public HTTPS URL** (the glue). We set them up in that order.

---

## 0. What you need before you start

- A **WeCom (企业微信)** account where you're an admin, with **微信客服** enabled
  (admin console: <https://work.weixin.qq.com>).
- An **Aliyun** account with **百炼 / DashScope** activated
  (<https://bailian.console.aliyun.com>).
- A **server** to run the bot on. An Aliyun **轻量应用服务器** with 2 GB RAM is plenty.
- A **domain name** you can point at that server, so WeCom can reach it over **HTTPS**
  (WeCom refuses plain HTTP).
  - *No ICP 备案 filing yet?* Buy the 轻量应用服务器 in the **Hong Kong** region — you
    can serve without 备案 there.
- **Node.js 18+** on the server.

Keep a scratch note open — you'll collect five secrets along the way:
`CORP_ID`, `KF_SECRET`, `DASHSCOPE_API_KEY`, `WECOM_TOKEN`, `WECOM_AES_KEY`.

---

## 1. Set up the WeCom side

**a. Get your 企业ID (`CORP_ID`).**
Admin console → **我的企业 → 企业信息** → copy **企业ID**.

**b. Create (or open) your 微信客服 account and get its `KF_SECRET`.**
Admin console → **微信客服**. If you don't have a kf account yet, create one. Then go to
**微信客服 → API** and copy the **Secret** (企业内部开发凭据). This is `KF_SECRET`.

**c. Add at least one 接待人员 (a human servicer).** ⚠️ **Don't skip this.**
Still under your kf account, add yourself (or a colleague) as a **接待人员**.

> **Why this matters:** when the bot gives up — the customer taps the **转人工客服**
> button, reports a bug, or asks something the FAQ can't answer — it moves the chat into
> the **待接入池** (human queue). If there's no 接待人员, that queue has nowhere to
> deliver the chat and the WeCom transfer API returns an error. The bot logs the failure
> and still tells the customer "a human will follow up," but no human actually can. So
> the button you built in Task 1 only *works* once a 接待人员 exists.

Leave the **Token / EncodingAESKey** screen for now — we come back to it in Step 4, after
the server is running (saving there triggers an immediate call to your server).

---

## 2. Get your Aliyun 百炼 API key

Go to <https://bailian.console.aliyun.com> → **API-KEY** → create one. Copy it — that's
`DASHSCOPE_API_KEY` (it starts with `sk-`).

While you're there, check **模型广场** for the exact model id available on your 套餐
(e.g. `qwen-plus` / `qwen3.7-plus`). The bot defaults to `qwen3.7-plus`; if yours differs,
you'll set `QWEN_MODEL` in the env below.

> **Cost note:** the FAQ rides along in the prompt on every message, so roughly 1M free
> tokens ≈ 250–300 conversations. You can watch the burn later via `/usage` (Step 5).

---

## 3. Deploy the server

SSH into your 轻量应用服务器, then:

```bash
# 1. Open the firewall for web traffic
#    (Aliyun console → your server → 防火墙/安全组 → allow ports 80 and 443)

# 2. Get the code and install dependencies (the TypeScript compiler is a
#    devDependency needed to build, so this is the full install, not --omit=dev)
git clone <your-repo-url> wecom-kf-bot
cd wecom-kf-bot
npm install

# 3. Create your .env from the template and fill in the five secrets
cp packages/bot/.env.example packages/bot/.env
#    edit packages/bot/.env → CORP_ID, KF_SECRET, DASHSCOPE_API_KEY
#    (leave WECOM_TOKEN / WECOM_AES_KEY for Step 4)
#    also set ADMIN_TOKEN to a long random string so the /bugs, /unanswered,
#    /usage dashboards are reachable but not public.

# 4. Edit packages/bot/knowledge/faq.md with your real product info — the bot
#    ONLY answers from this file, so an empty FAQ means an unhelpful bot.

# 5. Sanity check, build, then run under pm2 so it survives reboots
#    (npm commands run from the repo root; they delegate to packages/bot)
npm test                       # all tests must pass
npm run build                  # compile packages/bot/src → dist/ (+ copy knowledge/)
npm i -g pm2
cd packages/bot && pm2 start dist/src/server.js --name wecom-kf-bot
pm2 save && pm2 startup        # follow the printed command to enable on boot
```

**Put HTTPS in front.** Point your domain's DNS **A record** at the server's IP, then
use [Caddy](https://caddyserver.com) — it fetches a certificate automatically. A single
config block does it:

```
your.domain.com {
    reverse_proxy localhost:3000
}
```

Your public callback URL is now:

```
https://your.domain.com/wecom/callback
```

Quick check it's alive: `curl https://your.domain.com/health` should return
`{"ok":true}`.

> **Updating later:** `git pull && npm install && npm run build && pm2 restart wecom-kf-bot`.
> The FAQ is read once at startup, so a `faq.md` change also needs that restart.

---

## 4. Wire the callback (connect WeCom to your server)

Back in the admin console → **微信客服 → API → 接收消息设置**:

1. **URL** — paste `https://your.domain.com/wecom/callback`.
2. **Token** — click to generate one. Copy it into `.env` as `WECOM_TOKEN`.
3. **EncodingAESKey** — click to generate one (43 chars). Copy it into `.env` as
   `WECOM_AES_KEY`.
4. **Restart the bot so it picks up the new values, *before* you save:**
   `pm2 restart wecom-kf-bot`.
5. **Now click Save in the console.**

> **Why the order matters:** clicking Save makes WeCom immediately send a verification
> request to your URL. Your server has to answer it using the *same* Token and AESKey —
> so those must already be in the running process's environment. Save before the restart
> and the handshake fails.

If Save succeeds, you're connected. If it fails, jump to **Troubleshooting** below.

**Finally, set your welcome + human-handoff copy (optional).** The button text and the
message shown when someone taps 转人工客服 have sensible Chinese defaults, but you can
override them in `.env` (`WELCOME_MSG`, `HUMAN_MENU_HEAD`, `HUMAN_MENU_ITEM`,
`HUMAN_HANDOFF_REPLY`) — see `.env.example` for each.

---

## 5. Smoke test — prove it actually works

Watch the logs in one terminal while you test from a phone:

```bash
pm2 logs wecom-kf-bot
```

**Test A — the bot answers.** From a *different* WeChat account (not the admin's), open
your 微信客服 account and send a question that your `faq.md` covers.
- ✅ You get a reply in WeChat.
- ✅ The logs show `[msg] …` (message received) then `[reply:answer] …` (bot answered).

**Test B — the 转人工客服 button (your Task 1 feature).** After the bot's answer, a menu
with a **转人工客服** row appears underneath. Tap it.
- ✅ The logs show `[handoff:button] …`.
- ✅ In the WeCom app, the conversation now appears in your **待接入池** for a 接待人员
  to pick up. (If nothing lands there, you skipped Step 1c — add a 接待人员.)

**Test C — the staff dashboards.** From your machine, using the `ADMIN_TOKEN` you set:

```bash
curl "https://your.domain.com/unanswered?token=YOUR_ADMIN_TOKEN"   # includes the button tap, reason "user_request"
curl "https://your.domain.com/usage?token=YOUR_ADMIN_TOKEN"        # today's token spend
```

---

## 6. Go live & troubleshooting

Once the three tests pass, you're live — real customers reaching your 微信客服 account
will be answered automatically, with a human always one tap away.

Point a free uptime monitor (e.g. UptimeRobot) at `https://your.domain.com/health` so
you know if the bot goes down.

| Symptom | Most likely cause | Fix |
|---|---|---|
| Save in the console **fails** / logs say `URL verification failed` | `WECOM_TOKEN` / `WECOM_AES_KEY` in the env don't match the console, or you saved before restarting | Re-copy both values, `pm2 restart`, then Save |
| Save fails with a **connection error** | Server not running, DNS not pointing at it, or ports 80/443 closed | `curl …/health`; check the A record and the firewall (Step 3.1) |
| Customer gets **no reply** at all | Wrong `DASHSCOPE_API_KEY`, or a model id your 套餐 doesn't have | Check the logs for a `Qwen API error`; set `QWEN_MODEL` to a valid id |
| Bot replies, but **转人工 / handoff goes nowhere** | No **接待人员** on the kf account | Add one (Step 1c) — the queue needs a human to receive it |
| Bot answers, but replies are **unhelpful / "I can't help with that"** | `knowledge/faq.md` is empty or too thin | Fill it with real product info, then `pm2 restart` |

Day-to-day operations (reviewing coverage gaps in `/unanswered`, bug reports in `/bugs`,
token spend in `/usage`, tuning tone) are documented by topic in the
[README](./README.md).
