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
}
