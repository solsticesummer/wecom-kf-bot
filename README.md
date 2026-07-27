# wecom-kf-bot

AI auto-reply bot for a WeCom (企业微信) 微信客服 account. Customers message the kf
account in WeChat; the bot answers with Qwen (Aliyun DashScope) grounded in
`packages/bot/knowledge/faq.md`, and hands off to a human (moves the session to
待接入池) when it can't answer, is asked to, or a bug is reported.

First deploy? See [SETUP.md](./SETUP.md).

## Layout (npm-workspaces monorepo)

- `packages/bot/` — this TypeScript bot.
- `packages/knowledge/` — separate Python knowledge + MCP layer (own README; not an npm workspace).

Run npm commands from the repo root (root scripts delegate to the bot) or `cd packages/bot`.

## Setup

1. `npm install`
2. `cp packages/bot/.env.example packages/bot/.env` and fill it in (each var's comment says where to find it).
3. Put your business info in `packages/bot/knowledge/faq.md` — the bot only answers from this file.
4. `npm test`
5. `npm run dev` (tsx), or `npm run build && npm start` for a compiled run.

## Deploy (Node 20+ host, e.g. Aliyun 轻量应用服务器 2 GB)

1. Open ports 80/443. No ICP 备案? Use the Hong Kong region.
2. `git clone`, `npm install`, `npm run build`.
3. Run the compiled entry under pm2:
   ```bash
   npm i -g pm2
   cd packages/bot && pm2 start dist/src/server.js --name wecom-kf-bot
   pm2 save && pm2 startup
   ```
4. HTTPS via Caddy: `your.domain.com { reverse_proxy localhost:3000 }`; point the DNS A record at the server.
5. Callback URL: `https://your.domain.com/wecom/callback`.

- Update: `git pull && npm install && npm run build && pm2 restart wecom-kf-bot`.
- Update the FAQ: edit `packages/bot/knowledge/faq.md`, then `npm run build` (copies it into `dist/`) + `pm2 restart`.

## Connect WeCom

Admin console → 微信客服 → your kf account → API → 接收消息设置:

- **URL**: the callback URL above.
- **Token / EncodingAESKey**: generate them, set `WECOM_TOKEN` / `WECOM_AES_KEY`, and restart the bot **before** clicking Save (Save fires an immediate verification call).
- Add at least one **接待人员** to the kf account, or human handoff has nowhere to go.

Save fails? `pm2 logs`: `URL verification failed` = Token/AESKey mismatch; connection error = app down / DNS / firewall.

## Admin endpoints (ADMIN_TOKEN-gated — contain customer messages)

Authenticate with `Authorization: Bearer <token>` (or the legacy `?token=`, which lands in
access and proxy logs). `ADMIN_TOKEN` is operator-wide; `ADMIN_TOKEN_<TENANT>` reads only that
tenant. Fail-closed: nothing configured means every route 403s.

- `GET /health` → `{"ok":true}` (unauthenticated)
- `GET /tenants` — configured tenants. **Operator token only.**
- `GET /t/<tenant>/bugs` — reported bugs.
- `GET /t/<tenant>/unanswered[?reason=not_in_kb]` — handoffs / FAQ gaps. `reason`: `not_in_kb`, `unclear`, `user_request`, `upset`, `business`, `discount`, `api_error`, `quota_exceeded`.
- `GET /t/<tenant>/usage` — per-day spend, plus today's totals against the tenant's caps and `withinBudget`.

The un-prefixed `/bugs`, `/unanswered`, `/usage` still work and act on the default tenant.

## Configuration

Split in two. **`.env` is infrastructure** — the same for every tenant:

- `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_SECONDS` — per-customer limit (default 15/60s).
- `ALLOWED_KF_IDS` — optional extra narrowing for a staged rollout. **Not** the safety mechanism: routing is (see below).
- `TENANT_ID` — dev scripts only (`npm run chat` / `demo`). `DEFAULT_TENANT_ID` — which tenant the legacy un-prefixed admin routes report on.
- Keys, endpoints, `DATABASE_URL`.

**`packages/bot/tenants/<id>.yaml` is the product** — model, temperature, knowledge namespace,
and every customer-facing string (welcome, 转人工 menu, credits tip, rate-limit notice). These
are deliberately *not* env-overridable: one global env var can't mean two things once a second
tenant exists.

The prompt itself is `packages/bot/skills/cs-triage/` — `skill.yaml` (action contract) plus
`prompt.md` (prose). The action and handoff-reason bullets in the prompt are generated from
`skill.yaml`, so edit the contract there, not the prose.

## Multi-tenancy

One process serves every `tenants/*.yaml`. The 微信客服 callback is enterprise-wide — every kf
account's messages land on one endpoint — so each message is routed to the tenant whose
`wecom.kf_ids` claims its `open_kfid`.

**This is the safety mechanism.** A kf account no tenant claims has no tenant to answer as,
so its messages are dropped. Nothing answers your live 官方客服 until you put its `open_kfid`
in a tenant file. Two tenants claiming one account refuses to boot.

Each tenant gets its own conversation history, bugs, coverage gaps, usage, rate-limit budget
and retrieval namespace. The sync cursor and msgid dedupe stay corp-wide, because the sync
stream is. Admin routes are per tenant: `/t/<tenant>/bugs|unanswered|usage`, plus `/tenants`.

`tenants/demo.yaml` is a fake second tenant kept purely to hold the boundary honest — it owns
no kf accounts and can never receive a real message.

### Spend caps

Each tenant may declare a daily budget (UTC days). Omit the block for no cap:

```yaml
limits:
  daily_tokens: 2000000
  daily_calls: 20000
```

This is a different control from the per-customer rate limit in `.env`: that stops one
spammer, but a hundred well-behaved customers or a retry loop can still run up the bill
without any single customer tripping it.

Over budget, the customer gets `copy.quota_exceeded` and is transferred to a human — never
left on read, matching how every other failure in this codebase degrades. The cap is checked
*before* the model call, so it means "already over" rather than "would go over": the last
message before it trips is still paid for, bounded by the tenant's `max_tokens`.

Runtime state (cursor, dedupe, history, bugs) lives in `packages/bot/data/` — keep it on persistent disk.
