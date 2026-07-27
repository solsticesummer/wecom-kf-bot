// A stand-in for everything the bot talks to: WeCom's HTTP API and the Qwen chat endpoint.
//
// The bot is pointed here with WECOM_API_BASE + QWEN_API_URL, so the pipeline tests can
// assert on WHAT THE BOT TRIED TO SEND — the reply text, whether the 转人工 menu followed,
// whether the session moved to the human queue. That is the only part a customer experiences,
// and it is exactly the half that cannot be reached without a real WeCom tenancy.
//
// Deliberately dumb: it records calls and replays queued responses. Any cleverness here would
// be a second implementation of WeCom's semantics that could drift from the real one and
// quietly make the tests lie.

import http from 'node:http';
import { ServiceState } from '../../src/wecom.js';

export interface SentMessage {
  touser: string;
  open_kfid: string;
  msgtype: string;
  text?: { content: string };
  msgmenu?: { head_content?: string; list: { click?: { id: string; content: string } }[] };
}

export interface ModelCall {
  system: string;
  messages: { role: string; content: string }[];
  model: string;
}

export interface FakeWecom {
  url: string;
  /** Messages the bot sent to customers, in order. */
  sent: SentMessage[];
  /** service_state/trans calls: who was moved where. */
  transfers: { externalUserId: string; state: number }[];
  /** Chat-completion calls the bot made. Length 0 proves the model was never consulted. */
  modelCalls: ModelCall[];
  /** Messages /kf/sync_msg hands over on the next call. */
  queueMessages: (msgs: unknown[]) => void;
  /** What service_state/get reports (default BOT, i.e. the bot may speak). */
  setServiceState: (state: number) => void;
  /** The decision the fake model returns next. A string is sent as a raw body. */
  setModelReply: (reply: Record<string, unknown> | string) => void;
  /** Make the next model call fail, to exercise the api_error degradation. */
  failModel: (status?: number) => void;
  reset: () => void;
  close: () => Promise<void>;
}

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });

export async function startFakeWecom(): Promise<FakeWecom> {
  const sent: SentMessage[] = [];
  const transfers: { externalUserId: string; state: number }[] = [];
  const modelCalls: ModelCall[] = [];
  let pending: unknown[] = [];
  let serviceState: number = ServiceState.BOT;
  let modelReply: Record<string, unknown> | string = { action: 'answer', reply: 'ok' };
  let modelFailStatus = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const body = await readBody(req);
    const json = (data: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    // --- Qwen chat completions -----------------------------------------------------------
    if (url.pathname === '/v1/chat/completions') {
      const parsed = JSON.parse(body);
      modelCalls.push({
        system: parsed.messages.find((m: any) => m.role === 'system')?.content ?? '',
        messages: parsed.messages,
        model: parsed.model,
      });
      if (modelFailStatus) {
        // 4xx so the shared retry client gives up immediately instead of backing off
        // through its full schedule and stalling the test.
        const status = modelFailStatus;
        modelFailStatus = 0;
        return json({ error: 'induced failure' }, status);
      }
      const content = typeof modelReply === 'string' ? modelReply : JSON.stringify(modelReply);
      return json({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      });
    }

    // --- WeCom -------------------------------------------------------------------------
    if (url.pathname.endsWith('/gettoken')) {
      return json({ errcode: 0, errmsg: 'ok', access_token: 'fake-token', expires_in: 7200 });
    }
    if (url.pathname.endsWith('/kf/sync_msg')) {
      const msgs = pending;
      pending = [];
      return json({ errcode: 0, errmsg: 'ok', msg_list: msgs, next_cursor: 'cursor-1', has_more: 0 });
    }
    if (url.pathname.endsWith('/kf/send_msg')) {
      sent.push(JSON.parse(body));
      return json({ errcode: 0, errmsg: 'ok', msgid: `sent-${sent.length}` });
    }
    if (url.pathname.endsWith('/kf/service_state/get')) {
      return json({ errcode: 0, errmsg: 'ok', service_state: serviceState });
    }
    if (url.pathname.endsWith('/kf/service_state/trans')) {
      const b = JSON.parse(body);
      transfers.push({ externalUserId: b.external_userid, state: b.service_state });
      return json({ errcode: 0, errmsg: 'ok' });
    }
    return json({ errcode: 404, errmsg: `unexpected ${url.pathname}` }, 404);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}`,
    sent,
    transfers,
    modelCalls,
    queueMessages: (msgs) => {
      pending = msgs;
    },
    setServiceState: (s) => {
      serviceState = s;
    },
    setModelReply: (r) => {
      modelReply = r;
    },
    failModel: (status = 400) => {
      modelFailStatus = status;
    },
    reset: () => {
      sent.length = 0;
      transfers.length = 0;
      modelCalls.length = 0;
      pending = [];
      serviceState = ServiceState.BOT;
      modelReply = { action: 'answer', reply: 'ok' };
      modelFailStatus = 0;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
