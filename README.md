# wecom-kf-bot

AI auto-reply bot for a WeCom (企业微信) 微信客服 account. Customers message
your kf account in WeChat; the bot answers with Qwen (Aliyun 百炼 / DashScope),
grounded strictly in `knowledge/faq.md`. It matches on intent/keywords (not
exact wording), replies in the customer's own language (Chinese by default),
and politely declines off-topic/general questions instead of escalating them.
When it can't help with a product question it hands the conversation to a
human; when a customer reports a product bug, it logs the report and hands off too.

> **New here?** Follow [`SETUP.md`](./SETUP.md) for a step-by-step first deploy. This
> README is the terse, by-topic reference.

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

**"转人工客服" button.** After every normal answer the bot re-offers an inline menu with
a 转人工客服 option (WeCom 微信客服 has no persistent bottom-of-screen button, so the menu
is re-sent each turn to stay within reach). A tap comes back with a stable `menu_id`, so
the bot skips the AI entirely, moves the session to 待接入池, and logs it under
`user_request` — same destination as any other handoff, so it still needs a 接待人员.
Customize the copy via `HUMAN_MENU_HEAD` / `HUMAN_MENU_ITEM` / `HUMAN_HANDOFF_REPLY`.

## Bug reports

When a customer reports a product bug, the bot acknowledges in Chinese,
records `{ id, time, userId, message, summary, status }` to `data/bugs.json`,
and transfers the session to the human queue. Staff can also fetch the list:

```
GET /bugs?token=<ADMIN_TOKEN>
```

(Set `ADMIN_TOKEN` in the env; the endpoint is disabled when unset.)

## Coverage gaps

Every time the bot hands off, it records
`{ id, time, userId, message, reply, reason }` to `data/unanswered.json`.
Review this list to see which real customer questions are missing from
`knowledge/faq.md`, then add them — the FAQ grows from actual misses instead of
guesswork.

`reason` tells genuine gaps apart from by-design handoffs:

| reason | meaning | genuine FAQ gap? |
|--------|---------|------------------|
| `not_in_kb` | 知识库答不上来 | ✅ **yes** |
| `unclear` | 看不懂客户想问什么 | ✅ yes |
| `user_request` | 客户主动要求人工 | no |
| `upset` | 情绪激动 / 退款 / 投诉 | no |
| `business` | 商务合作 | no |
| `discount` | 想谈充值优惠 | no |
| `api_error` | API/解析失败的兜底转人工（非内容问题） | no |

```
GET /unanswered?token=<ADMIN_TOKEN>                 # everything
GET /unanswered?token=<ADMIN_TOKEN>&reason=not_in_kb # just the real FAQ gaps
```

(Same `ADMIN_TOKEN` gate as `/bugs`; entries contain customer messages, so it's
never public.)

## Token usage

Every model reply's token count (from the API's `usage`) is tallied per UTC day
in `data/state.json`. Use it to watch your 百炼 free-quota / cost burn without
opening the Aliyun console:

```
GET /usage?token=<ADMIN_TOKEN>
```

Returns `{ "2026-07-21": { calls, promptTokens, completionTokens, totalTokens }, … }`.
(`ADMIN_TOKEN`-gated for consistency. Rough rule of thumb: ~1M free tokens ≈
250–300 conversations, since the FAQ rides in the prompt on every message.)

## Rate limiting

Each **customer** (`external_userid`) is capped at **15 messages per 60s** by
default; over that, the bot drops the message *before* any Qwen or WeCom call
and sends one gentle "slow down" notice per window. This protects your token
spend / WeCom quota from a single spammer. Tune via `RATE_LIMIT_MAX`,
`RATE_LIMIT_WINDOW_SECONDS`, `RATE_LIMIT_MSG`.

The limit is **per customer, not per IP** — every request arrives through
WeCom's servers, so an IP limit would throttle WeCom itself, not the abuser.
State is in-memory (a restart just resets the windows). Note: limits are
per-process, so they'd multiply if you ran multiple instances — the single-
instance pm2 deploy below is fine.

## Setup

1. `npm install`
2. Copy `.env.example` values into your environment. Each var's comment says
   where to find it (WeCom admin console / Aliyun 百炼 console).
3. Edit `knowledge/faq.md` with your real business info — the bot only
   answers from this file.
4. `npm test` — all tests must pass.
5. `npm run dev` (runs the TypeScript directly via tsx). For a production-style
   run, `npm run build && npm start` (compiles `src/` → `dist/`, then runs the
   compiled JS).

## Deploy (Aliyun 轻量应用服务器)

1. Buy a 轻量应用服务器 (2 GB RAM is plenty) with the **Node.js** app image —
   or a plain Debian/Ubuntu image and install Node 18+ yourself.
   *No ICP-filed domain? Pick the Hong Kong region and you can serve without
   备案.*
2. In the server's firewall (安全组/防火墙 tab), open ports 80 and 443.
3. SSH in, clone the repo, `npm install` (the full install — the TypeScript
   compiler is a devDependency needed for the build), then `npm run build` to
   emit `dist/`.
4. Export the vars from `.env.example`, then run the **compiled** entrypoint
   under a process manager so the bot survives reboots — e.g. pm2:
   ```bash
   npm i -g pm2
   pm2 start dist/src/server.js --name wecom-kf-bot
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

To update: `git pull && npm install && npm run build && pm2 restart wecom-kf-bot`.

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
- Reply tone/creativity is tunable via `QWEN_TEMPERATURE` (default `0.6`): lower
  is more repetitive/safe, higher is more varied/original. Facts stay grounded in
  the FAQ regardless (enforced by the prompt).
- `data/bugs.json` is plain JSON — safe to download or open directly.
