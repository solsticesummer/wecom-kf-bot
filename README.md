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

- `GET /health` → `{"ok":true}`
- `GET /bugs?token=…` — reported bugs.
- `GET /unanswered?token=…[&reason=not_in_kb]` — handoffs / FAQ gaps. `reason`: `not_in_kb`, `unclear`, `user_request`, `upset`, `business`, `discount`, `api_error`.
- `GET /usage?token=…` — per-day token spend.

## Key env vars

- `ALLOWED_KF_IDS` — safety allowlist of kf accounts the bot may answer (set to your TEST account while testing; unset = answer all).
- `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_SECONDS` — per-customer limit (default 15/60s).
- `QWEN_MODEL` (default `qwen3.7-plus`), `QWEN_TEMPERATURE` (default `0.6`).
- `WELCOME_MSG`, `HUMAN_MENU_HEAD`, `HUMAN_MENU_ITEM`, `HUMAN_HANDOFF_REPLY` — copy overrides.

Runtime state (cursor, dedupe, history, bugs) lives in `packages/bot/data/` — keep it on persistent disk.
