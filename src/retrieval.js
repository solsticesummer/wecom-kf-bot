// Hybrid retrieval: dense (pgvector) ∪ sparse (pg_trgm) candidate recall, fused, then
// reranked by qwen3-rerank. search() throws on any failure so generateReply() can fall
// back to the full FAQ — a retrieval outage must never become a handoff.
//
// NOTE: embeddings + rerank are Model Studio (百炼) services on dashscope.aliyuncs.com,
// which need a STANDARD DashScope key — NOT the Coding-Plan chat key. We read
// MODELSTUDIO_API_KEY first, falling back to DASHSCOPE_API_KEY for single-key setups.
import { query } from './db.js';

const EMBEDDING_API_URL =
  process.env.EMBEDDING_API_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-v4';
const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM || 1024);
const RERANK_API_URL =
  process.env.RERANK_API_URL ||
  'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank';
const RERANK_MODEL = process.env.RERANK_MODEL || 'qwen3-rerank';

const apiKey = () => process.env.MODELSTUDIO_API_KEY || process.env.DASHSCOPE_API_KEY;

// Same transient-failure policy as ai.js callModel, but decoupled from URL/body so both
// the /embeddings and /rerank calls can share it.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postJson(url, body) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey()}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      lastErr = err; // network error / timeout — retryable
      if (attempt === MAX_RETRIES) throw lastErr;
      await sleep(400 * 2 ** attempt + Math.random() * 200);
      continue;
    }
    const data = await res.json();
    if (res.ok) return data;
    lastErr = new Error(`${res.status} ${data?.error?.message || data?.message || ''}`);
    if (!RETRYABLE_STATUS.has(res.status) || attempt === MAX_RETRIES) throw lastErr;
    await sleep(400 * 2 ** attempt + Math.random() * 200);
  }
  throw lastErr;
}

// Embed one string → number[] of length EMBEDDING_DIM (OpenAI-compatible /embeddings).
// dimensions is pinned so the vector always matches the vector(1024) column.
export async function embed(text) {
  const data = await postJson(EMBEDDING_API_URL, {
    model: EMBEDDING_MODEL,
    input: [text],
    dimensions: EMBEDDING_DIM,
  });
  const vec = data?.data?.[0]?.embedding;
  if (!Array.isArray(vec)) throw new Error('embed: unexpected response shape');
  return vec;
}

// Rerank docs against the query → [{ index, relevance_score }] (native DashScope rerank).
export async function rerank(queryText, docs) {
  const data = await postJson(RERANK_API_URL, {
    model: RERANK_MODEL,
    input: { query: queryText, documents: docs },
    parameters: { return_documents: false, top_n: docs.length },
  });
  const results = data?.output?.results;
  if (!Array.isArray(results)) throw new Error('rerank: unexpected response shape');
  return results;
}

// pgvector accepts a bracketed text literal: '[0.1,0.2,...]'.
export const toVectorLiteral = (vec) => `[${vec.join(',')}]`;

// Cosine similarity of two equal-length vectors, in [-1, 1]. pgvector handles the *search*
// similarity in SQL; this pure-JS version decides whether two already-retrieved chunks are
// near-duplicates (the dedup pass below). Guard against a zero-magnitude vector.
export function cosineSim(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// pgvector returns an embedding as the text literal '[0.1,0.2,...]', which is valid JSON.
const parseVec = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

// Two retrieved chunks with cosine ≥ this are treated as duplicates; the lower-ranked one
// is dropped so its slot goes to more diverse info. High enough (0.92) to keep genuinely
// *complementary* same-topic chunks (manual how-to vs faq short-answer), low enough to
// catch the same fact restated across sources. Tunable via env.
const DEDUP_SIM = Number(process.env.RETRIEVAL_DEDUP_SIM || 0.92);

/**
 * search(queryText, { k, candidates }) → [{ content, section, source, score }]
 * Hybrid recall (dense ∪ trigram) → qwen3-rerank → greedy top-k with near-duplicate
 * suppression. Throws on embed/DB/rerank failure — the caller degrades to the full FAQ.
 */
export async function search(
  queryText,
  {
    k = Number(process.env.RETRIEVAL_TOP_K || 5),
    candidates = Number(process.env.RETRIEVAL_CANDIDATES || 20),
  } = {},
) {
  const qvec = toVectorLiteral(await embed(queryText));

  // Dense (cosine <=>) ∪ keyword (trigram % + similarity) recall; UNION de-dupes by row.
  const { rows } = await query(
    `WITH dense AS (
        SELECT id, source, section, content, embedding
        FROM chunks
        ORDER BY embedding <=> $1::vector
        LIMIT $2
     ),
     kw AS (
        SELECT id, source, section, content, embedding
        FROM chunks
        WHERE content % $3
        ORDER BY similarity(content, $3) DESC
        LIMIT $2
     )
     SELECT * FROM dense
     UNION
     SELECT * FROM kw`,
    [qvec, candidates, queryText],
  );

  if (rows.length === 0) return [];

  // Rerank, then walk candidates best-first, keeping a chunk only if it isn't a near-
  // duplicate (cosine ≥ DEDUP_SIM) of one already picked. This spends the k slots on
  // diverse info instead of the same fact restated across faq/manual/whitepaper.
  const ranked = (await rerank(queryText, rows.map((r) => r.content))).sort(
    (a, b) => b.relevance_score - a.relevance_score,
  );

  const picked = [];
  const pickedVecs = [];
  for (const r of ranked) {
    if (picked.length >= k) break;
    const row = rows[r.index];
    const vec = parseVec(row.embedding);
    if (pickedVecs.some((v) => cosineSim(v, vec) >= DEDUP_SIM)) continue; // drop the dup
    const { embedding, ...rest } = row; // don't leak the 1024-dim vector to callers
    picked.push({ ...rest, score: r.relevance_score });
    pickedVecs.push(vec);
  }
  return picked;
}
