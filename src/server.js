// Express server exposing the WeCom callback endpoint.
//
// The load-bearing pattern here is ACK-THEN-PROCESS: WeCom expects a response
// within ~5 seconds and will retry (duplicate!) the callback if we're slow.
// A Claude call can take longer than that, so the POST handler decrypts,
// responds 200 immediately, and does sync → dedupe → AI → reply afterwards.

import express from 'express';
import { XMLParser } from 'fast-xml-parser';
import { WecomCrypto } from './crypto.js';
import { WecomClient } from './wecom.js';
import { StateStore } from './state.js';
import { generateReply } from './ai.js';

const {
  CORP_ID,
  KF_SECRET,
  WECOM_TOKEN,
  WECOM_AES_KEY,
  ANTHROPIC_API_KEY,
  WELCOME_MSG,
  DATA_DIR = './data',
  PORT = 3000,
} = process.env;

for (const [name, val] of Object.entries({
  CORP_ID,
  KF_SECRET,
  WECOM_TOKEN,
  WECOM_AES_KEY,
  ANTHROPIC_API_KEY,
})) {
  if (!val) {
    console.error(`Missing required env var ${name} — see .env.example`);
    process.exit(1);
  }
}

// Ignore anything older than this on sync — prevents replying to a backlog of
// stale messages on first deploy (empty cursor returns history, not just new).
const MAX_MSG_AGE_SECONDS = 300;

const wxCrypto = new WecomCrypto(WECOM_TOKEN, WECOM_AES_KEY, CORP_ID);
const wecom = new WecomClient(CORP_ID, KF_SECRET);
const store = new StateStore(DATA_DIR);
// parseTagValue:false keeps every value a string — the default would coerce a
// purely-numeric sync Token into a JS number and corrupt it.
const xml = new XMLParser({ parseTagValue: false });

const app = express();
// WeCom posts raw XML — capture the body as text, not JSON
app.use(express.text({ type: '*/*' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

// Step 1: URL verification handshake (fires when you click save in the console)
app.get('/wecom/callback', (req, res) => {
  const { msg_signature, timestamp, nonce, echostr } = req.query;
  try {
    const plain = wxCrypto.verifyUrl(msg_signature, timestamp, nonce, echostr);
    res.send(plain); // raw decrypted echostr — nothing else
  } catch (err) {
    console.error('URL verification failed:', err.message);
    res.status(403).send('forbidden');
  }
});

// Step 2: encrypted event notifications
app.post('/wecom/callback', (req, res) => {
  try {
    const { msg_signature, timestamp, nonce } = req.query;
    const encrypted = xml.parse(req.body)?.xml?.Encrypt;
    if (!encrypted || !wxCrypto.verifySignature(msg_signature, timestamp, nonce, String(encrypted))) {
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
let queue = Promise.resolve();
function handleSyncEvent(syncToken) {
  // log-and-continue: one failed sync must not wedge the queue for later events
  queue = queue
    .then(() => processMessages(syncToken))
    .catch((err) => console.error('processMessages error:', err.message));
}

async function processMessages(syncToken) {
  const { messages, cursor } = await wecom.syncMessages(syncToken, store.cursor);

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
  store.setCursor(cursor);
}

async function handleOneMessage(msg) {
  if (store.hasSeen(msg.msgid)) return;

  const ageSeconds = Date.now() / 1000 - (msg.send_time || 0);
  if (msg.send_time && ageSeconds > MAX_MSG_AGE_SECONDS) {
    store.markSeen(msg.msgid); // too old — swallow silently, don't reply
    return;
  }

  // Greet users who just opened the chat (event arrives via the same sync)
  if (msg.msgtype === 'event' && msg.event?.event_type === 'enter_session') {
    store.markSeen(msg.msgid);
    if (WELCOME_MSG && msg.event.external_userid) {
      await wecom.sendText(msg.event.open_kfid, msg.event.external_userid, WELCOME_MSG);
    }
    return;
  }

  // origin 3 = sent by the customer; skip our own/system messages
  if (msg.origin !== 3 || msg.msgtype !== 'text') {
    store.markSeen(msg.msgid);
    return;
  }
  const userText = msg.text?.content?.trim();
  if (!userText) {
    store.markSeen(msg.msgid);
    return;
  }

  console.log(`[msg] ${msg.external_userid}: ${userText}`);
  const reply = await generateReply(store.getHistory(msg.external_userid), userText);
  await wecom.sendText(msg.open_kfid, msg.external_userid, reply);
  // markSeen AFTER the send: a crash in between can cause one duplicate reply,
  // but marking first would turn a crash into a customer never getting answered.
  store.markSeen(msg.msgid);
  store.appendHistory(msg.external_userid, userText, reply);
  console.log(`[reply] ${msg.external_userid}: ${reply.slice(0, 80)}`);
}

const server = app.listen(PORT, () => console.log(`wecom-kf-bot listening on :${PORT}`));

// Railway sends SIGTERM on redeploy: stop taking new callbacks, let the
// in-flight reply queue drain (bounded), then exit.
process.on('SIGTERM', async () => {
  console.log('SIGTERM — draining queue');
  server.close();
  await Promise.race([queue, new Promise((r) => setTimeout(r, 8000))]);
  process.exit(0);
});
