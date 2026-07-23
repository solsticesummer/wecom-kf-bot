import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { WecomCrypto } from '../src/crypto.js';

// A well-formed fake key: 43 base64 chars (32 random bytes, "=" stripped)
const KEY = crypto.randomBytes(32).toString('base64').replace(/=+$/, '');
const wx = new WecomCrypto('testToken', KEY, 'wwTestCorp');

test('encrypt → decrypt round-trip preserves the message', () => {
  const msg = '<xml><Event>kf_msg_or_event</Event><Token>abc123</Token></xml>';
  assert.equal(wx.decrypt(wx.encrypt(msg)), msg);
});

test('round-trip works for multi-byte (Chinese) content', () => {
  const msg = '<xml><Content>你好，请问怎么退款？</Content></xml>';
  assert.equal(wx.decrypt(wx.encrypt(msg)), msg);
});

test('decrypt rejects ciphertext for a different corp', () => {
  const other = new WecomCrypto('testToken', KEY, 'wwOtherCorp');
  const stolen = other.encrypt('<xml>hi</xml>');
  assert.throws(() => wx.decrypt(stolen), /receive_id mismatch/);
});

test('signature verifies regardless of parameter order (sorted internally)', () => {
  const enc = wx.encrypt('<xml>hi</xml>');
  const sig = wx.sign('1700000000', 'nonce42', enc);
  assert.ok(wx.verifySignature(sig, '1700000000', 'nonce42', enc));
});

test('tampered signature is rejected', () => {
  const enc = wx.encrypt('<xml>hi</xml>');
  const sig = wx.sign('1700000000', 'nonce42', enc);
  const bad = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0');
  assert.ok(!wx.verifySignature(bad, '1700000000', 'nonce42', enc));
  assert.ok(!wx.verifySignature('short', '1700000000', 'nonce42', enc));
});

test('verifyUrl handshake returns decrypted echostr', () => {
  const echoPlain = 'random-echo-string-1234';
  const echostr = wx.encrypt(echoPlain);
  const sig = wx.sign('1700000000', 'n1', echostr);
  assert.equal(wx.verifyUrl(sig, '1700000000', 'n1', echostr), echoPlain);
});

test('verifyUrl throws on bad signature', () => {
  const echostr = wx.encrypt('echo');
  assert.throws(() => wx.verifyUrl('deadbeef', '1700000000', 'n1', echostr), /signature/);
});
