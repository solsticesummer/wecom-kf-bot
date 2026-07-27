// Express server exposing the WeCom callback endpoint.
//
// The load-bearing pattern here is ACK-THEN-PROCESS: WeCom expects a response
// within ~5 seconds and will retry (duplicate!) the callback if we're slow.
// An AI call can take longer than that, so the POST handler decrypts,
// responds 200 immediately, and does sync → dedupe → AI → reply afterwards.

import express, { type Request, type Response } from 'express';
import { XMLParser } from 'fast-xml-parser';
import { WecomCrypto } from './crypto.js';
import { WecomClient, ServiceState, type KfMessage } from './wecom.js';
import { StateStore } from './state.js';
import { RateLimiter } from './ratelimit.js';
import { generateReply } from './ai.js';
import { loadRegistry, type Tenant } from './tenants.js';
import { runAction } from './actions.js';
import { checkQuota } from './quota.js';
import { canReadTenant, isOperator, presentedToken } from './adminauth.js';
import path from 'node:path';

// Fail-fast on a missing required env var, and narrow `string | undefined` to
// `string` for the rest of the module. Replaces the old validation loop.
function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env var ${name} — see .env.example`);
    process.exit(1);
  }
  return val;
}

const CORP_ID = requireEnv('CORP_ID');
const KF_SECRET = requireEnv('KF_SECRET');
const WECOM_TOKEN = requireEnv('WECOM_TOKEN');
const WECOM_AES_KEY = requireEnv('WECOM_AES_KEY');
requireEnv('DASHSCOPE_API_KEY'); // read later by ai.ts; validated here so we fail at boot

const DATA_DIR = process.env.DATA_DIR || './data';
const PORT = Number(process.env.PORT) || 3000;

// Every product this deployment serves, indexed by the kf accounts each one owns. A
// malformed tenant, or two tenants claiming one kf account, throws here and the process
// never starts listening.
const registry = loadRegistry();
console.log(
  `tenants: ${registry.all().map((t) => `${t.id}[${t.kfIds.join(',') || 'no kf accounts'}]`).join(' ')}`,
);

// "转人工客服" menu. WeCom 微信客服 has no persistent bottom-of-screen button,
// so we re-offer this inline menu after each bot answer — always one tap away
// the moment a reply doesn't satisfy the customer. When tapped, WeCom echoes a
// text message carrying text.menu_id === HUMAN_HANDOFF_ID, which we act on
// directly (no AI call, no intent-guessing).
const HUMAN_HANDOFF_ID = 'human_service'; // must match on send and on the tap

// Extra narrowing on top of the registry, for testing against production safely: when set,
// only these kf accounts are served even if a tenant claims others. The registry is now what
// makes the bot fail-closed (an unregistered kf account has no tenant to answer it), so this
// is no longer the safety mechanism — it's a temporary "only this one account" switch for a
// staged rollout. Leave it unset in normal operation.
const ALLOWED_KF_IDS = new Set(
  (process.env.ALLOWED_KF_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
);

// Per-customer rate limit: caps how many messages one external_userid can send
// per window before we stop answering (protects Qwen tokens / WeCom quota from
// a spammer). Generous for a real human, fatal to a script. The thresholds stay
// env-driven (infrastructure protection); only the notice text is tenant copy.
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 15);
const RATE_LIMIT_WINDOW_SECONDS = Number(process.env.RATE_LIMIT_WINDOW_SECONDS || 60);

// Ignore anything older than this on sync — prevents replying to a backlog of
// stale messages on first deploy (empty cursor returns history, not just new).
const MAX_MSG_AGE_SECONDS = 300;

const wxCrypto = new WecomCrypto(WECOM_TOKEN, WECOM_AES_KEY, CORP_ID);
const wecom = new WecomClient(CORP_ID, KF_SECRET);

// TWO LEVELS OF STATE, because they have genuinely different owners.
//
// The 微信客服 sync stream is enterprise-wide: one cursor and one msgid space cover every kf
// account in the corp. Those belong to the CORP — partitioning them per tenant would replay
// messages (each tenant's cursor lagging the shared stream) and break dedupe for anything we
// drop before knowing which tenant it belongs to.
//
// Everything else — conversation history, bug reports, coverage gaps, token usage, pending
// credits tips — is per-TENANT, and must be, since it is customer data belonging to one
// product. A shared history store would let one tenant's conversation context leak into
// another's prompt.
const systemStore = new StateStore(DATA_DIR);
const tenantStores = new Map<string, StateStore>(
  registry.all().map((t) => [t.id, new StateStore(path.join(DATA_DIR, 'tenants', t.id))]),
);
const storeFor = (tenant: Tenant): StateStore => tenantStores.get(tenant.id)!;

const rateLimiter = new RateLimiter({
  maxRequests: RATE_LIMIT_MAX,
  windowMs: RATE_LIMIT_WINDOW_SECONDS * 1000,
});
// parseTagValue:false keeps every value a string — the default would coerce a
// purely-numeric sync Token into a JS number and corrupt it.
const xml = new XMLParser({ parseTagValue: false });

const app = express();
// WeCom posts raw XML — capture the body as text, not JSON
app.use(express.text({ type: '*/*' }));

app.get('/health', (_req: Request, res: Response) => res.json({ ok: true }));

// Staff-facing admin surface. /bugs and /unanswered contain verbatim customer messages, so
// every route is gated — and gated PER TENANT: see adminauth.ts for why one shared token was
// a real boundary hole once a second tenant existed.

/** Resolve the tenant for a route, authorize the caller, and hand back its store. */
function authedStore(req: Request, res: Response): { tenant: Tenant; store: StateStore } | undefined {
  const id = req.params.tenantId;
  // Un-prefixed legacy routes act on the default tenant, so the URLs in SETUP.md keep
  // working on a single-tenant deployment.
  const tenant = id ? registry.get(id) : registry.defaultTenant;
  if (!tenant) {
    res.status(404).json({ error: `unknown tenant ${id}` });
    return undefined;
  }
  const token = presentedToken(req.headers.authorization, req.query.token);
  if (!canReadTenant(token, tenant.id)) {
    // Deliberately the same 403 for "wrong token" and "right token, wrong tenant" — telling
    // a caller which tenants exist is itself information they haven't authenticated for.
    res.status(403).json({ error: 'forbidden' });
    return undefined;
  }
  return { tenant, store: storeFor(tenant) };
}

// Operator-only: naming every tenant is more than any single tenant's operator should see.
app.get('/tenants', (req: Request, res: Response) => {
  if (!isOperator(presentedToken(req.headers.authorization, req.query.token))) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json(registry.all().map((t) => ({ id: t.id, namespace: t.namespace, kfIds: t.kfIds })));
});

for (const p of ['/bugs', '/t/:tenantId/bugs']) {
  app.get(p, (req: Request, res: Response) => {
    const ctx = authedStore(req, res);
    if (ctx) res.json(ctx.store.getBugs());
  });
}

for (const p of ['/unanswered', '/t/:tenantId/unanswered']) {
  app.get(p, (req: Request, res: Response) => {
    const ctx = authedStore(req, res);
    if (!ctx) return;
    // ?reason=not_in_kb narrows to one handoff reason (e.g. the genuine FAQ gaps);
    // no reason param returns everything.
    const list = ctx.store.getUnanswered();
    res.json(req.query.reason ? list.filter((e) => e.reason === req.query.reason) : list);
  });
}

for (const p of ['/usage', '/t/:tenantId/usage']) {
  app.get(p, (req: Request, res: Response) => {
    const ctx = authedStore(req, res);
    if (!ctx) return;
    // Report the cap alongside the spend, so "why did the bot start handing off?" is
    // answerable from one endpoint instead of cross-referencing the tenant file.
    const q = checkQuota(ctx.tenant, ctx.store);
    res.json({
      usage: ctx.store.getUsage(),
      today: { tokens: q.usedTokens, calls: q.usedCalls },
      limits: ctx.tenant.limits,
      withinBudget: q.allowed,
    });
  });
}

// Step 1: URL verification handshake (fires when you click save in the console)
app.get('/wecom/callback', (req: Request, res: Response) => {
  const { msg_signature, timestamp, nonce, echostr } = req.query;
  try {
    const plain = wxCrypto.verifyUrl(
      String(msg_signature),
      String(timestamp),
      String(nonce),
      String(echostr),
    );
    res.send(plain); // raw decrypted echostr — nothing else
  } catch (err) {
    console.error('URL verification failed:', err.message);
    res.status(403).send('forbidden');
  }
});

// Step 2: encrypted event notifications
app.post('/wecom/callback', (req: Request, res: Response) => {
  try {
    const { msg_signature, timestamp, nonce } = req.query;
    const encrypted = xml.parse(req.body)?.xml?.Encrypt;
    if (
      !encrypted ||
      !wxCrypto.verifySignature(String(msg_signature), String(timestamp), String(nonce), String(encrypted))
    ) {
      return res.status(403).send('forbidden');
    }
    const event = xml.parse(wxCrypto.decrypt(String(encrypted)))?.xml;
    res.send('success'); // ack now — WeCom retries after ~5s of silence

    if (event?.Event === 'kf_msg_or_event' && event.Token) {
      handleSyncEvent(String(event.Token));
    }
  } catch (err) {
    console.error('callback error:', err.message);
    res.status(400).send('bad request');
  }
});

// Chain the async work so overlapping callbacks can't run two sync loops at
// once (two loops would race on the cursor and double-reply).
let queue: Promise<void> = Promise.resolve();
function handleSyncEvent(syncToken: string): void {
  // log-and-continue: one failed sync must not wedge the queue for later events
  queue = queue
    .then(() => processMessages(syncToken))
    .catch((err) => console.error('processMessages error:', err.message));
}

async function processMessages(syncToken: string): Promise<void> {
  const { messages, cursor } = await wecom.syncMessages(syncToken, systemStore.cursor);

  for (const msg of messages) {
    // Per-message isolation: one failed send (e.g. user blocked the account)
    // must not abort the replies to everyone after them in the batch.
    try {
      await handleOneMessage(msg);
    } catch (err) {
      console.error(`message ${msg.msgid} failed:`, err.message);
    }
  }

  // Cursor is committed only after the batch is processed. If we crash
  // mid-batch, the next sync re-fetches from the old cursor and the msgid
  // dedupe (marked after a successful reply) skips what was already answered.
  systemStore.setCursor(cursor);
}

// Move the session into the human queue (待接入池). Best-effort: if it fails
// (e.g. no 接待人员 configured on the kf account yet), the customer has
// already been told a human will follow up — log loudly and move on.
async function transferToHuman(openKfId: string, externalUserId: string): Promise<void> {
  try {
    await wecom.transServiceState(openKfId, externalUserId, ServiceState.QUEUED_FOR_HUMAN);
    console.log(`[handoff] ${externalUserId} → human queue`);
  } catch (err) {
    console.error(`handoff failed for ${externalUserId}: ${err.message} — check that 接待人员 are configured`);
  }
}

async function handleOneMessage(msg: KfMessage): Promise<void> {
  if (systemStore.hasSeen(msg.msgid)) return;

  const ageSeconds = Date.now() / 1000 - (msg.send_time || 0);
  if (msg.send_time && ageSeconds > MAX_MSG_AGE_SECONDS) {
    systemStore.markSeen(msg.msgid); // too old — swallow silently, don't reply
    return;
  }

  // Route to the tenant that owns this kf account. Regular messages carry open_kfid;
  // enter_session events carry it under .event. No tenant (or no kf account at all) means we
  // have no product to answer as — drop it. This is the fail-closed guarantee that used to
  // be ALLOWED_KF_IDS: the enterprise-wide callback delivers EVERY kf account's messages
  // here, including the live 官方客服's, and only registered accounts get served.
  const kfId = msg.open_kfid || msg.event?.open_kfid || '';
  const tenant = registry.forKfId(kfId);
  if (!tenant || (ALLOWED_KF_IDS.size && !ALLOWED_KF_IDS.has(kfId))) {
    systemStore.markSeen(msg.msgid);
    return;
  }
  const COPY = tenant.copy;
  const store = storeFor(tenant);

  // Greet users who just opened the chat (event arrives via the same sync)
  if (msg.msgtype === 'event' && msg.event?.event_type === 'enter_session') {
    systemStore.markSeen(msg.msgid);
    if (msg.event.external_userid) {
      await wecom.sendText(msg.event.open_kfid!, msg.event.external_userid, COPY.welcome);
    }
    return;
  }

  // origin 5 = sent by a human staff member (接待人员). If this customer was
  // waiting for a test account, the staff message IS the distribution —
  // follow up with the credits tip. Send may be rejected while the human
  // still owns the session; keep the flag so a later event retries.
  if (msg.origin === 5 && msg.external_userid && store.hasPendingTip(msg.external_userid)) {
    systemStore.markSeen(msg.msgid);
    try {
      await wecom.sendText(msg.open_kfid!, msg.external_userid, COPY.creditsTip);
      store.clearPendingTip(msg.external_userid);
      console.log(`[tip:${tenant.id}] sent credits tip to ${msg.external_userid}`);
    } catch (err) {
      console.error(`credits tip send failed for ${msg.external_userid} (will retry on next event):`, err.message);
    }
    return;
  }

  // origin 3 = sent by the customer; skip our own/system messages
  if (msg.origin !== 3 || msg.msgtype !== 'text') {
    systemStore.markSeen(msg.msgid);
    return;
  }
  const userText = msg.text?.content?.trim();
  if (!userText) {
    systemStore.markSeen(msg.msgid);
    return;
  }
  const openKfId = msg.open_kfid!;
  const externalUserId = msg.external_userid!;

  // Rate limit per customer BEFORE any downstream call (getServiceState +
  // generateReply): a spammer must not be able to burn Qwen tokens or WeCom
  // quota. markSeen so WeCom's retry doesn't reprocess the dropped message.
  // Key includes the tenant: the same person can be a customer of two tenants, and one
  // conversation shouldn't eat the other's budget.
  const gate = rateLimiter.allow(`${tenant.id}:${externalUserId}`);
  if (!gate.allowed) {
    systemStore.markSeen(msg.msgid);
    console.warn(`[ratelimit] ${externalUserId} over ${RATE_LIMIT_MAX}/${RATE_LIMIT_WINDOW_SECONDS}s`);
    if (gate.notify) {
      // One gentle notice per window. Best-effort: if a human already owns the
      // session WeCom may reject the send — that's fine, swallow it.
      try {
        await wecom.sendText(openKfId, externalUserId, COPY.rateLimit);
      } catch (err) {
        console.error(`ratelimit notice failed for ${externalUserId}:`, err.message);
      }
    }
    return;
  }

  // Who owns this conversation right now? Once it's queued for (or being
  // handled by) a human, the bot must stay silent — replying here would talk
  // over your staff. Fail open to BOT: a state-check hiccup shouldn't leave
  // the customer unanswered.
  let serviceState: number = ServiceState.BOT;
  try {
    serviceState = await wecom.getServiceState(openKfId, externalUserId);
  } catch (err) {
    console.error(`service_state check failed for ${externalUserId}:`, err.message);
  }
  if (serviceState === ServiceState.QUEUED_FOR_HUMAN || serviceState === ServiceState.HUMAN) {
    systemStore.markSeen(msg.msgid);
    return;
  }
  if (serviceState === ServiceState.NEW || serviceState === ServiceState.ENDED) {
    // Claim the session for the bot so the console shows it as 智能助手接待
    try {
      await wecom.transServiceState(openKfId, externalUserId, ServiceState.BOT);
    } catch (err) {
      console.error(`claim session failed for ${externalUserId}:`, err.message);
    }
  }

  // Explicit "转人工客服" tap. WeCom delivers it as a text message whose
  // text.menu_id equals the id we set on the menu item, so we branch on that
  // structured signal instead of running the AI or matching keywords. Placed
  // after the service-state check on purpose: if a human already owns the
  // session, the block above already returned, so a stray tap can't re-confirm.
  if (msg.text?.menu_id === HUMAN_HANDOFF_ID) {
    // Send the confirmation BEFORE the transfer — once the session moves to the
    // human queue the bot may no longer be allowed to message the customer.
    await wecom.sendText(openKfId, externalUserId, COPY.handoffReply);
    systemStore.markSeen(msg.msgid);
    // A tap is a handoff the customer asked for outright, so it goes through the same
    // handler as a model-decided one and lands in the same coverage-gap log — no second
    // copy of the logging to keep in sync.
    console.log(`[handoff:button:${tenant.id}] ${externalUserId}`);
    runAction('handoff', {
      store,
      userId: externalUserId,
      userText,
      result: {
        action: 'handoff',
        reply: COPY.handoffReply,
        bugSummary: '',
        handoffReason: 'user_request',
      },
    });
    await transferToHuman(openKfId, externalUserId);
    return;
  }

  // Daily budget gate, BEFORE the model call — the whole point is to not spend. Unlike the
  // rate limit above, an exhausted budget is the operator's problem, not the customer's, so
  // they are told and handed to a human rather than left on read. Same degradation shape as
  // an API error: this codebase never answers a customer with silence.
  const quota = checkQuota(tenant, store);
  if (!quota.allowed) {
    systemStore.markSeen(msg.msgid);
    console.error(
      `[quota:${tenant.id}] daily ${quota.exceeded} budget spent ` +
        `(${quota.usedCalls} calls / ${quota.usedTokens} tokens) — handing off to a human`,
    );
    await wecom.sendText(openKfId, externalUserId, COPY.quotaExceeded);
    runAction('handoff', {
      store,
      userId: externalUserId,
      userText,
      result: {
        action: 'handoff',
        reply: COPY.quotaExceeded,
        bugSummary: '',
        handoffReason: 'quota_exceeded',
      },
    });
    await transferToHuman(openKfId, externalUserId);
    return;
  }

  console.log(`[msg:${tenant.id}] ${externalUserId}: ${userText}`);
  const result = await generateReply(tenant, store.getHistory(externalUserId), userText);
  const { action, reply, usage } = result;
  if (usage) store.addUsage(usage); // track token spend per day

  // Whether this action ends with a human taking over, declared by the skill rather than
  // listed here. It decides two things below: whether to re-offer the 转人工 menu, and
  // whether to move the session to the human queue.
  const handsOff = tenant.actions.find((a) => a.name === action)?.handoff ?? false;

  // Send the reply BEFORE the state transfer: once the session moves to the
  // human queue the bot may no longer be allowed to message the customer.
  await wecom.sendText(openKfId, externalUserId, reply);
  // markSeen AFTER the send: a crash in between can cause one duplicate reply,
  // but marking first would turn a crash into a customer never getting answered.
  systemStore.markSeen(msg.msgid);
  store.appendHistory(externalUserId, userText, reply);
  console.log(`[reply:${tenant.id}:${action}] ${externalUserId}: ${reply.slice(0, 80)}`);

  // Re-offer a human after a normal answer, so "转人工客服" is always one tap
  // away if the bot's reply didn't satisfy. Skipped when a human is already
  // coming, since the menu would just be noise. Best-effort: the answer is
  // already sent, so a failed menu send must not throw here.
  if (!handsOff) {
    try {
      await wecom.sendMenu(openKfId, externalUserId, {
        headContent: COPY.menuHead,
        list: [{ type: 'click', click: { id: HUMAN_HANDOFF_ID, content: COPY.menuItem } }],
      });
    } catch (err) {
      console.error(`human menu send failed for ${externalUserId}:`, err.message);
    }
  }

  // Whatever this action records (bug report, coverage gap, pending credits tip) is the
  // skill's business, not the channel's — see actions.ts.
  runAction(action, { store, userId: externalUserId, userText, result });

  if (handsOff) {
    await transferToHuman(openKfId, externalUserId);
  }
}

const server = app.listen(PORT, () => console.log(`wecom-kf-bot listening on :${PORT}`));

// The platform sends SIGTERM on redeploy/restart: stop taking new callbacks,
// let the in-flight reply queue drain (bounded), then exit.
process.on('SIGTERM', async () => {
  console.log('SIGTERM — draining queue');
  server.close();
  await Promise.race([queue, new Promise((r) => setTimeout(r, 8000))]);
  process.exit(0);
});
