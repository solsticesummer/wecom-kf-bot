# wecom-kf-bot

AI auto-reply bot for a WeCom (企业微信) 微信客服 account. Customers message
your kf account in WeChat; the bot answers with Claude, grounded strictly in
`knowledge/faq.md`.

## How it works

```
Customer (WeChat) → WeCom → POST /wecom/callback (encrypted event, no content)
                                 │ ack 200 within 5s
                                 ▼
                     kf/sync_msg (pull messages with persisted cursor)
                                 ▼
                     Claude API (system = instructions + faq.md, cached)
                                 ▼
                     kf/send_msg → customer sees the reply
```

State that must survive restarts (sync cursor, msgid dedupe, per-user chat
history) lives in `data/state.json` — mount a persistent volume there in
production.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env`-style env vars (locally: `export ...`; on
   Railway: Variables tab). Each var's comment says where to find it in the
   WeCom admin console.
3. Edit `knowledge/faq.md` with your real business info — the bot only
   answers from this file.
4. `npm test` — crypto + state tests must pass.
5. `npm start`

## Deploy (Railway)

1. Push this repo to GitHub.
2. Railway → New Project → Deploy from GitHub repo (Node auto-detected,
   start command `npm start`).
3. Add a **Volume** mounted at `/app/data`, and set env var `DATA_DIR=/app/data`.
4. Set all env vars from `.env.example` in the Variables tab.
5. Settings → Networking → Generate Domain. Your callback URL is
   `https://<your-app>.up.railway.app/wecom/callback`.
6. Use the **Hobby** plan (always-on). Free-trial instances sleep on idle,
   which makes WeCom callbacks silently fail.

## Connect WeCom

Admin console → 微信客服 → your kf account → API → 接收消息设置:

- **URL**: the Railway callback URL above
- **Token** / **EncodingAESKey**: generate in the console, and set the same
  values as `WECOM_TOKEN` / `WECOM_AES_KEY` env vars *before* clicking save —
  saving triggers an immediate verification request to your server.

If saving fails, check Railway logs: `URL verification failed` = Token/AESKey
mismatch; connection error = app not deployed/domain wrong.

## Updating the FAQ

Edit `knowledge/faq.md`, commit, push — Railway redeploys automatically.

## Ops

- `GET /health` returns `{"ok":true}` — point a free UptimeRobot monitor at it.
- Model is `claude-opus-4-8` by default; override with the `CLAUDE_MODEL` env
  var (e.g. `claude-sonnet-5` or `claude-haiku-4-5` to cut cost at volume).
