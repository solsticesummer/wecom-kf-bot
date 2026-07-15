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
  DATA_DIR = './data',
  PORT = 3000,
} = process.env;

for (const [name, val] of Object.entries({ CORP_ID, KF_SECRET, WECOM_TOKEN, WECOM_AES_KEY })) {
  if (!val) {
    console.error(`Missing required env var ${name} — see .env.example`);
    process.exit(1);
  }
}

const wxCrypto = new WecomCrypto(WECOM_TOKEN, WECOM_AES_KEY, CORP_ID);
const wecom = new WecomClient(CORP_ID, KF_SECRET);
const store = new StateStore(DATA_DIR);
const xml = new XMLParser();

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
  store.setCursor(cursor);

  for (const msg of messages) {
    // origin 3 = sent by the customer; skip our own/system messages
    if (msg.origin !== 3 || msg.msgtype !== 'text') continue;
    if (store.hasSeen(msg.msgid)) continue;
    store.markSeen(msg.msgid);

    const userText = msg.text?.content?.trim();
    if (!userText) continue;

    console.log(`[msg] ${msg.external_userid}: ${userText}`);
    const reply = await generateReply(store.getHistory(msg.external_userid), userText);
    await wecom.sendText(msg.open_kfid, msg.external_userid, reply);
    store.appendHistory(msg.external_userid, userText, reply);
    console.log(`[reply] ${msg.external_userid}: ${reply.slice(0, 80)}...`);
  }
}

app.listen(PORT, () => console.log(`wecom-kf-bot listening on :${PORT}`));
