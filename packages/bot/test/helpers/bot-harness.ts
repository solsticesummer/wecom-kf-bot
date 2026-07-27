// Drives a REAL bot process with GENUINE WeCom callbacks.
//
// The callbacks are not stubs: WecomCrypto.encrypt/sign are the same functions the production
// decrypt path verifies against, so a payload built here is byte-for-byte what WeCom would
// deliver. That makes the crypto, signature and receive_id checks part of what's under test
// rather than something mocked away.
//
// The server is spawned as a child process because server.ts reads env and calls app.listen()
// at import time — importing it in-process would bind a port at module load and give the test
// no way to configure it per case.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WecomCrypto } from '../../src/crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOT_ROOT = path.join(__dirname, '..', '..');

// Test-only WeCom credentials. The AES key must be exactly 43 base64 chars (it decodes to the
// 32-byte key); these are throwaway values, not secrets.
export const CORP_ID = 'wwtestcorp0000001';
export const TOKEN = 'testtoken';
export const AES_KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

export const crypto = new WecomCrypto(TOKEN, AES_KEY, CORP_ID);

export interface Bot {
  url: string;
  dataDir: string;
  /** POST an encrypted callback and return the ACK body. Does NOT wait for processing. */
  postCallback: (syncToken?: string) => Promise<{ status: number; body: string }>;
  /** GET the URL-verification handshake with a correctly signed echostr. */
  verifyUrl: (plaintext: string) => Promise<{ status: number; body: string }>;
  /** Read a tenant's persisted state (undefined before its first write). */
  readState: (tenantId: string) => any;
  stop: () => Promise<void>;
}

/** Sign + encrypt a payload exactly as WeCom would. */
export function signedCallback(xmlPayload: string) {
  const encrypt = crypto.encrypt(xmlPayload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = 'nonce123';
  return {
    encrypt,
    timestamp,
    nonce,
    signature: crypto.sign(timestamp, nonce, encrypt),
    body: `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`,
  };
}

/** A message as /kf/sync_msg returns it. `send_time` defaults to now so it isn't age-gated. */
export function kfMessage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    msgid: `msg-${Math.random().toString(36).slice(2)}`,
    send_time: Math.floor(Date.now() / 1000),
    origin: 3, // 3 = sent by the customer
    msgtype: 'text',
    text: { content: 'hello' },
    ...over,
  };
}

export interface StartOptions {
  /** Where the bot should send WeCom + model traffic (the fake). */
  fakeUrl: string;
  tenantsDir: string;
  env?: Record<string, string>;
}

/**
 * Ask the OS for a free port, then release it.
 *
 * There is a small race between closing and the bot binding, but it beats picking a random
 * number in a range: a leftover process from an interrupted run would collide with that
 * roughly 1-in-500 times, which is exactly the kind of once-a-fortnight failure that teaches
 * people to re-run the suite instead of reading it.
 */
async function freePort(): Promise<number> {
  const srv = http.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address() as { port: number };
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

export async function startBot({ fakeUrl, tenantsDir, env = {} }: StartOptions): Promise<Bot> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-e2e-'));
  const port = await freePort();

  const child: ChildProcess = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(BOT_ROOT, 'src', 'server.ts')],
    {
      cwd: BOT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CORP_ID,
        KF_SECRET: 'test-secret',
        WECOM_TOKEN: TOKEN,
        WECOM_AES_KEY: AES_KEY,
        DASHSCOPE_API_KEY: 'test-key',
        WECOM_API_BASE: `${fakeUrl}/cgi-bin`,
        QWEN_API_URL: `${fakeUrl}/v1/chat/completions`,
        TENANTS_DIR: tenantsDir,
        DATA_DIR: dataDir,
        PORT: String(port),
        // Left unset on purpose: retrieval throws, ai.ts falls back to the tenant's own FAQ,
        // so every scenario also exercises the "outage is never customer-visible" invariant.
        DATABASE_URL: '',
        ...env,
      },
    },
  );

  let log = '';
  child.stdout?.on('data', (d) => (log += d));
  child.stderr?.on('data', (d) => (log += d));

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`bot exited ${child.exitCode}:\n${log}`);
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`bot did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    url,
    dataDir,
    postCallback: async (syncToken = 'sync-token-1') => {
      const payload = `<xml><Event><![CDATA[kf_msg_or_event]]></Event><Token><![CDATA[${syncToken}]]></Token></xml>`;
      const { body, signature, timestamp, nonce } = signedCallback(payload);
      const res = await fetch(
        `${url}/wecom/callback?msg_signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`,
        { method: 'POST', headers: { 'content-type': 'text/xml' }, body },
      );
      return { status: res.status, body: await res.text() };
    },
    verifyUrl: async (plaintext: string) => {
      const echostr = crypto.encrypt(plaintext);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = 'nonce123';
      const signature = crypto.sign(timestamp, nonce, echostr);
      const res = await fetch(
        `${url}/wecom/callback?msg_signature=${signature}&timestamp=${timestamp}` +
          `&nonce=${nonce}&echostr=${encodeURIComponent(echostr)}`,
      );
      return { status: res.status, body: await res.text() };
    },
    readState: (tenantId: string) => {
      const f = path.join(dataDir, 'tenants', tenantId, 'state.json');
      return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : undefined;
    },
    stop: async () => {
      child.kill('SIGKILL');
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Wait until `check()` holds, or fail loudly.
 *
 * The pipeline is deliberately asynchronous — the callback ACKs before any work happens — so
 * polling is the honest way to observe it. A fixed sleep would either be flaky or slow, and
 * would quietly hide a regression that made the pipeline slower.
 */
export async function until(check: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

/** Give the pipeline a chance to do nothing, when the assertion is that nothing happens. */
export const settle = (ms = 900): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the bot stops doing things.
 *
 * These tests share one long-lived server, and the pipeline is asynchronous on purpose — the
 * callback ACKs before any work starts. So a test that finishes as soon as ITS assertion
 * holds can leave a reply, a transfer or a state write still in flight, which then lands
 * inside the *next* test's window and fails an assertion that has nothing to do with it.
 * (Observed: "an unregistered kf account is ignored" seeing a straggler reply, and a
 * per-tenant history read racing the previous test's disk write.)
 *
 * Adaptive rather than a fixed sleep: returns as soon as two consecutive samples agree, so an
 * already-idle bot costs one interval instead of a worst-case guess.
 */
export async function quiesce(
  counters: () => number[],
  quietMs = 150,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = counters().join(',');
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, quietMs));
    const now = counters().join(',');
    if (now === last) return;
    last = now;
  }
}
