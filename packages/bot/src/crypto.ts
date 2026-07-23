// WeCom callback message crypto (the "接收消息" encryption scheme).
//
// WeCom encrypts every callback payload with AES-256-CBC and signs it with
// SHA1. The EncodingAESKey you enter in the admin console is a 43-char
// base64 string; appending "=" decodes it to exactly 32 bytes (the AES key).
// The IV is the first 16 bytes of that same key.
//
// Decrypted plaintext layout (defined by WeCom, not negotiable):
//   [16 random bytes][4-byte big-endian msg length][msg][receive_id]
// where receive_id must equal your corpid — checking it prevents replaying
// ciphertext that was encrypted for a different corp.

import crypto from 'node:crypto';

const BLOCK_SIZE = 32; // WeCom uses PKCS#7 padding with a 32-byte block

export class WecomCrypto {
  token: string;
  corpId: string;
  aesKey: Buffer;
  iv: Buffer;

  constructor(token: string, encodingAesKey: string, corpId: string) {
    if (!token || !encodingAesKey || !corpId) {
      throw new Error('WecomCrypto requires token, encodingAesKey and corpId');
    }
    if (encodingAesKey.length !== 43) {
      throw new Error('EncodingAESKey must be exactly 43 characters');
    }
    this.token = token;
    this.corpId = corpId;
    this.aesKey = Buffer.from(encodingAesKey + '=', 'base64');
    this.iv = this.aesKey.subarray(0, 16);
  }

  // Signature = sha1(sort([token, timestamp, nonce, encrypted]).join(''))
  sign(timestamp: string, nonce: string, encrypted: string): string {
    const raw = [this.token, timestamp, nonce, encrypted].sort().join('');
    return crypto.createHash('sha1').update(raw).digest('hex');
  }

  verifySignature(signature: string, timestamp: string, nonce: string, encrypted: string): boolean {
    const expected = this.sign(timestamp, nonce, encrypted);
    // timingSafeEqual requires equal lengths; a wrong-length sig is invalid anyway
    if (!signature || signature.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }

  decrypt(encryptedB64: string): string {
    const decipher = crypto.createDecipheriv('aes-256-cbc', this.aesKey, this.iv);
    decipher.setAutoPadding(false); // WeCom's 32-byte-block PKCS#7 — strip manually
    let plain = Buffer.concat([
      decipher.update(Buffer.from(encryptedB64, 'base64')),
      decipher.final(),
    ]);

    const pad = plain[plain.length - 1];
    if (pad < 1 || pad > BLOCK_SIZE) throw new Error('Invalid padding');
    plain = plain.subarray(0, plain.length - pad);

    const msgLen = plain.readUInt32BE(16);
    const msg = plain.subarray(20, 20 + msgLen).toString('utf8');
    const receiveId = plain.subarray(20 + msgLen).toString('utf8');

    if (receiveId !== this.corpId) {
      throw new Error(`receive_id mismatch: got "${receiveId}"`);
    }
    return msg;
  }

  encrypt(msg: string): string {
    const random = crypto.randomBytes(16);
    const msgBuf = Buffer.from(msg, 'utf8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(msgBuf.length);
    const corpBuf = Buffer.from(this.corpId, 'utf8');

    let plain = Buffer.concat([random, lenBuf, msgBuf, corpBuf]);
    const padLen = BLOCK_SIZE - (plain.length % BLOCK_SIZE) || BLOCK_SIZE;
    plain = Buffer.concat([plain, Buffer.alloc(padLen, padLen)]);

    const cipher = crypto.createCipheriv('aes-256-cbc', this.aesKey, this.iv);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64');
  }

  // GET verification handshake: check the signature over echostr, then return
  // the decrypted plaintext — WeCom expects it as the raw response body.
  verifyUrl(signature: string, timestamp: string, nonce: string, echostr: string): string {
    if (!this.verifySignature(signature, timestamp, nonce, echostr)) {
      throw new Error('URL verification signature mismatch');
    }
    return this.decrypt(echostr);
  }
}
