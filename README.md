# wecom-kf-bot

AI auto-reply bot for a WeCom (企业微信) 微信客服 account. Customers message
your kf account in WeChat; the bot answers in Chinese with Qwen (Aliyun 百炼 /
DashScope), grounded strictly in `knowledge/faq.md`. When it can't help, it
hands the conversation to a human; when a customer reports a product bug, it
logs the report and hands off too.

## How it works

```
Customer (WeChat) → WeCom → POST /wecom/callback (encrypted event, no content)
                                 │ ack 200 within 5s
                                 ▼
                     kf/sync_msg (pull messages with persisted cursor)
                                 ▼
                     service_state check — human owns the chat? stay silent
                                 ▼
                     Qwen (system = instructions + faq.md) → JSON:
                       { action: answer | handoff | bug, reply, bug_summary }
                                 ▼
                     kf/send_msg → customer sees the reply
                                 ▼ (handoff / bug)
                     kf/service_state/trans → 待接入池 (human queue)
                     bug reports also appended to data/bugs.json
```

State that must survive restarts (sync cursor, msgid dedupe, per-user chat
history, bug reports) lives in `data/` — keep that directory on persistent
disk in production.

## Human takeover

WeCom 微信客服 sessions have an owner: bot (1), human queue (2), human (3).
The bot claims new sessions, and moves a session to the human queue when the
model answers `handoff` (can't understand the customer, can't answer from the
FAQ, customer asks for a human / is upset / disputes billing) or `bug`. Your
staff pick queued sessions up in the WeCom app under 微信客服.

**Prerequisite:** add at least one 接待人员 (servicer) to the kf account in
the admin console, or the transfer API fails (the bot logs this and the
customer is still told a human will follow up).

While a session is queued or human-owned the bot stays silent — it re-checks
`service_state` before every reply.

## Bug reports

When a customer reports a product bug, the bot acknowledges in Chinese,
records `{ id, time, userId, message, summary, status }` to `data/bugs.json`,
and transfers the session to the human queue. Staff can also fetch the list:

```
GET /bugs?token=<ADMIN_TOKEN>
```

(Set `ADMIN_TOKEN` in the env; the endpoint is disabled when unset.)

## Setup

1. `npm install`
2. Copy `.env.example` values into your environment. Each var's comment says
   where to find it (WeCom admin console / Aliyun 百炼 console).
3. Edit `knowledge/faq.md` with your real business info — the bot only
   answers from this file.
4. `npm test` — all tests must pass.
5. `npm start`

## Deploy (Aliyun 轻量应用服务器)

1. Buy a 轻量应用服务器 (2 GB RAM is plenty) with the **Node.js** app image —
   or a plain Debian/Ubuntu image and install Node 18+ yourself.
   *No ICP-filed domain? Pick the Hong Kong region and you can serve without
   备案.*
2. In the server's firewall (安全组/防火墙 tab), open ports 80 and 443.
3. SSH in, clone the repo, `npm install --omit=dev`.
4. Export the vars from `.env.example`, then run under a process manager so
   the bot survives reboots — e.g. pm2:
   ```bash
   npm i -g pm2
   pm2 start src/server.js --name wecom-kf-bot
   pm2 save && pm2 startup
   ```
5. Put HTTPS in front. Easiest is Caddy — one config block gets automatic
   certificates:
   ```
   your.domain.com {
       reverse_proxy localhost:3000
   }
   ```
   Point your domain's DNS A record at the server IP first.
6. Your callback URL is `https://your.domain.com/wecom/callback`.

To update: `git pull && npm install --omit=dev && pm2 restart wecom-kf-bot`.

## Connect WeCom

Admin console → 微信客服 → your kf account → API → 接收消息设置:

- **URL**: the callback URL above
- **Token** / **EncodingAESKey**: generate in the console, and set the same
  values as `WECOM_TOKEN` / `WECOM_AES_KEY` env vars *before* clicking save —
  saving triggers an immediate verification request to your server.

If saving fails, check the server logs (`pm2 logs wecom-kf-bot`):
`URL verification failed` = Token/AESKey mismatch; connection error = app not
running / DNS or firewall wrong.

Also add 接待人员 to the kf account so human takeover has somewhere to go.

## Updating the FAQ

Edit `knowledge/faq.md`, then `git pull` on the server and
`pm2 restart wecom-kf-bot` (the FAQ is read once at startup).

## Ops

- `GET /health` returns `{"ok":true}` — point a free UptimeRobot monitor at it.
- Model defaults to `qwen3.7-plus`; verify the exact model id available in
  your 百炼 套餐 (模型广场) and override with the `QWEN_MODEL` env var if it
  differs. Thinking mode is disabled for latency/cost.
- `data/bugs.json` is plain JSON — safe to download or open directly.
