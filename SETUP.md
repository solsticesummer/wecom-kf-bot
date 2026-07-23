# First-time setup

Zero to a live 微信客服 bot. Terse by-topic reference: [README](./README.md).

You'll collect five secrets: `CORP_ID`, `KF_SECRET`, `DASHSCOPE_API_KEY`, `WECOM_TOKEN`, `WECOM_AES_KEY`.

## Prereqs

- WeCom (企业微信) admin account with 微信客服 enabled.
- Aliyun 百炼 / DashScope activated.
- A server (Node 20+) with a domain + HTTPS (WeCom refuses plain HTTP). No ICP 备案? Use the Hong Kong region.

## 1. WeCom side

- `CORP_ID`: 我的企业 → 企业信息 → 企业ID.
- `KF_SECRET`: 微信客服 → API → Secret (create a kf account first if needed).
- Add at least one **接待人员** to the kf account — required, or human handoff fails.
- Leave Token / EncodingAESKey for Step 4.

## 2. Aliyun key

- 百炼 console → API-KEY → create. That's `DASHSCOPE_API_KEY` (`sk-…`).
- Check 模型广场 for your model id; set `QWEN_MODEL` if it isn't `qwen3.7-plus`.

## 3. Deploy

```bash
# open ports 80/443 in the firewall first
git clone <repo-url> wecom-kf-bot && cd wecom-kf-bot
npm install
cp packages/bot/.env.example packages/bot/.env
#   fill: CORP_ID, KF_SECRET, DASHSCOPE_API_KEY, ADMIN_TOKEN (leave WECOM_* for Step 4)
#   put real product info in packages/bot/knowledge/faq.md (the bot only answers from it)
npm test && npm run build
npm i -g pm2
cd packages/bot && pm2 start dist/src/server.js --name wecom-kf-bot && pm2 save && pm2 startup
```

HTTPS via Caddy: `your.domain.com { reverse_proxy localhost:3000 }`; point the DNS A record at the server.
Callback URL: `https://your.domain.com/wecom/callback`. Check: `curl …/health` → `{"ok":true}`.

## 4. Wire the callback

Admin console → 微信客服 → API → 接收消息设置:

1. URL = your callback URL.
2. Generate Token → `WECOM_TOKEN`; generate EncodingAESKey (43 chars) → `WECOM_AES_KEY`.
3. `pm2 restart wecom-kf-bot` **before** clicking Save (Save fires an immediate verification call using those values).
4. Click Save.

Optional copy overrides in `.env`: `WELCOME_MSG`, `HUMAN_MENU_HEAD`, `HUMAN_MENU_ITEM`, `HUMAN_HANDOFF_REPLY`.

## 5. Smoke test (`pm2 logs wecom-kf-bot`)

- FAQ question from a non-admin WeChat → reply (`[reply:answer]`).
- Tap the 转人工客服 menu → lands in 待接入池 (`[handoff:button]`); needs a 接待人员.
- `curl "…/unanswered?token=ADMIN_TOKEN"` and `…/usage?token=…`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Save fails / `URL verification failed` | Token/AESKey mismatch or saved before restart → re-copy, `pm2 restart`, Save |
| Save connection error | Server down / DNS / ports 80,443 → `curl …/health`, check A record + firewall |
| No reply | Wrong `DASHSCOPE_API_KEY` or bad model id → check logs, set `QWEN_MODEL` |
| Handoff goes nowhere | No 接待人员 on the kf account → add one |
| Unhelpful replies | `faq.md` too thin → fill it, `pm2 restart` |

Update later: `git pull && npm install && npm run build && pm2 restart wecom-kf-bot`.
