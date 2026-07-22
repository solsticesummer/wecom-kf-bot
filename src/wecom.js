// Thin client for the WeCom 微信客服 (Customer Service) HTTP API.
//
// Two things matter here:
// 1. access_token is valid for 7200s and WeCom rate-limits gettoken —
//    fetch it lazily and cache it until ~200s before expiry.
// 2. Message content is PULLED, not pushed: the callback only delivers a
//    sync token; syncMessages() exchanges (token, cursor) for actual messages.

const BASE = 'https://qyapi.weixin.qq.com/cgi-bin';

// WeCom rejects text messages over 2048 BYTES (not chars — Chinese is 3
// bytes/char in UTF-8). Trim on a character boundary so we never split a
// multi-byte sequence and never get the whole send rejected.
export function truncateUtf8(str, maxBytes) {
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str;
  const ellipsisBytes = Buffer.byteLength('…', 'utf8'); // 3, not 1!
  let out = str;
  while (Buffer.byteLength(out, 'utf8') > maxBytes - ellipsisBytes) {
    out = out.slice(0, -1);
  }
  return out + '…';
}

export class WecomClient {
  constructor(corpId, secret) {
    this.corpId = corpId;
    this.secret = secret;
    this._token = null;
    this._tokenExpiresAt = 0;
  }

  async getAccessToken() {
    if (this._token && Date.now() < this._tokenExpiresAt) return this._token;
    const res = await fetch(
      `${BASE}/gettoken?corpid=${encodeURIComponent(this.corpId)}&corpsecret=${encodeURIComponent(this.secret)}`
    );
    const data = await res.json();
    if (data.errcode !== 0) {
      throw new Error(`gettoken failed: ${data.errcode} ${data.errmsg}`);
    }
    this._token = data.access_token;
    // refresh 200s early so a token never expires mid-request
    this._tokenExpiresAt = Date.now() + (data.expires_in - 200) * 1000;
    return this._token;
  }

  async _post(path, body) {
    const token = await this.getAccessToken();
    const res = await fetch(`${BASE}${path}?access_token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.errcode !== 0) {
      // 40014/42001 = invalid/expired token — drop cache so the next call refreshes
      if (data.errcode === 40014 || data.errcode === 42001) this._token = null;
      throw new Error(`${path} failed: ${data.errcode} ${data.errmsg}`);
    }
    return data;
  }

  // Pull all pending messages. `syncToken` comes from the decrypted callback
  // event; `cursor` is our persisted position in the message stream.
  // Returns { messages, cursor } with the new cursor to persist.
  async syncMessages(syncToken, cursor) {
    const messages = [];
    let hasMore = true;
    let nextCursor = cursor;
    while (hasMore) {
      const data = await this._post('/kf/sync_msg', {
        token: syncToken,
        cursor: nextCursor || '',
        limit: 1000,
      });
      messages.push(...(data.msg_list || []));
      nextCursor = data.next_cursor;
      hasMore = data.has_more === 1;
    }
    return { messages, cursor: nextCursor };
  }

  async sendText(openKfId, externalUserId, content) {
    return this._post('/kf/send_msg', {
      touser: externalUserId,
      open_kfid: openKfId,
      msgtype: 'text',
      text: { content: truncateUtf8(content, 2000) },
    });
  }

  // Send a menu message (菜单消息): a set of tappable rows shown inline in the
  // chat. We use it for the "转人工客服" option. `list` items are WeCom's raw
  // shape, e.g. { type: 'click', click: { id, content } }; head/tail are
  // optional plain-text lines above/below the options.
  async sendMenu(openKfId, externalUserId, { headContent = '', list = [], tailContent = '' }) {
    const msgmenu = { list };
    if (headContent) msgmenu.head_content = headContent;
    if (tailContent) msgmenu.tail_content = tailContent;
    return this._post('/kf/send_msg', {
      touser: externalUserId,
      open_kfid: openKfId,
      msgtype: 'msgmenu',
      msgmenu,
    });
  }

  // WeCom 微信客服 session states — who currently "owns" the conversation:
  //   0 new/untreated  1 bot (智能助手)  2 waiting for a human (待接入池)
  //   3 human serving  4 ended
  // The bot must only speak in states 0/1; replying during 2/3 would talk
  // over (or race with) your human staff.
  async getServiceState(openKfId, externalUserId) {
    const data = await this._post('/kf/service_state/get', {
      open_kfid: openKfId,
      external_userid: externalUserId,
    });
    return data.service_state;
  }

  async transServiceState(openKfId, externalUserId, state) {
    return this._post('/kf/service_state/trans', {
      open_kfid: openKfId,
      external_userid: externalUserId,
      service_state: state,
    });
  }

  // List the enterprise's 微信客服 accounts. Used to look up a kf account's
  // open_kfid (e.g. to fill ALLOWED_KF_IDS) — it isn't shown in the console UI.
  // Returns the raw account_list: [{ open_kfid, name, avatar, ... }].
  async listKfAccounts() {
    const data = await this._post('/kf/account/list', { offset: 0, limit: 100 });
    return data.account_list || [];
  }
}

export const ServiceState = {
  NEW: 0,
  BOT: 1,
  QUEUED_FOR_HUMAN: 2,
  HUMAN: 3,
  ENDED: 4,
};
