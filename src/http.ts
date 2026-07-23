// Shared JSON-over-HTTP POST with retry/backoff.
//
// Extracted from two byte-for-byte-equivalent copies that used to live in
// ai.ts (callModel) and retrieval.ts (postJson): every DashScope call — chat,
// embeddings, rerank — wants the same transient-failure policy, and keeping one
// copy means a fix can't silently drift between them.
//
// Policy: 429 + 5xx are transient (retry with exponential backoff); network
// errors / timeouts are retryable too; everything else (401/400) is permanent
// and fails fast — retrying just wastes time and quota.

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const DEFAULT_MAX_RETRIES = 2; // 3 attempts total
const DEFAULT_TIMEOUT_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Exponential backoff with full jitter: 400·2^attempt ms + up to 200ms random.
const backoffMs = (attempt: number) => 400 * 2 ** attempt + Math.random() * 200;

export interface PostJsonOptions {
  /** Object (serialized here) or an already-serialized JSON string. */
  body: unknown;
  apiKey: string | undefined;
  timeoutMs?: number;
  maxRetries?: number;
}

/**
 * POST JSON and return the parsed body. Throws after exhausting retries, or
 * immediately on a non-retryable status.
 */
export async function postJson<T = any>(
  url: string,
  { body, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS, maxRetries = DEFAULT_MAX_RETRIES }: PostJsonOptions,
): Promise<T> {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastErr = err; // network error / timeout — retryable
      if (attempt === maxRetries) throw lastErr;
      await sleep(backoffMs(attempt));
      continue;
    }
    const data: any = await res.json();
    if (res.ok) return data as T;
    lastErr = new Error(`${res.status} ${data?.error?.message || data?.message || ''}`);
    if (!RETRYABLE_STATUS.has(res.status) || attempt === maxRetries) throw lastErr;
    await sleep(backoffMs(attempt));
  }
  throw lastErr; // unreachable, but keeps the type honest
}
