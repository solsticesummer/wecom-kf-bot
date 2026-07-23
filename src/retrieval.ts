// Hybrid retrieval: dense (pgvector) ∪ sparse (pg_trgm) candidate recall, fused, then
// reranked by qwen3-rerank. search() throws on any failure so generateReply() can fall
// back to the full FAQ — a retrieval outage must never become a handoff.
//
// NOTE: embeddings + rerank are Model Studio (百炼) services on dashscope.aliyuncs.com,
// which need a STANDARD DashScope key — NOT the Coding-Plan chat key. We read
// MODELSTUDIO_API_KEY first, falling back to DASHSCOPE_API_KEY for single-key setups.
import { query } from './db.js';
import { postJson } from './http.js';

const EMBEDDING_API_URL =
  process.env.EMBEDDING_API_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-v4';
const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM || 1024);
const RERANK_API_URL =
  process.env.RERANK_API_URL ||
  'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank';
const RERANK_MODEL = process.env.RERANK_MODEL || 'qwen3-rerank';

const apiKey = (): string | undefined => process.env.MODELSTUDIO_API_KEY || process.env.DASHSCOPE_API_KEY;

export interface RerankResult {
  index: number;
  relevance_score: number;
}

export interface Chunk {
  id?: number;
  source: string;
  section: string;
  content: string;
  score: number;
}

// Embed one string → number[] of length EMBEDDING_DIM (OpenAI-compatible /embeddings).
// dimensions is pinned so the vector always matches the vector(1024) column.
export async function embed(text: string): Promise<number[]> {
  const data = await postJson(EMBEDDING_API_URL, {
    body: { model: EMBEDDING_MODEL, input: [text], dimensions: EMBEDDING_DIM },
    apiKey: apiKey(),
  });
  const vec = data?.data?.[0]?.embedding;
  if (!Array.isArray(vec)) throw new Error('embed: unexpected response shape');
  return vec;
}

// Rerank docs against the query → [{ index, relevance_score }] (native DashScope rerank).
export async function rerank(queryText: string, docs: string[]): Promise<RerankResult[]> {
  const data = await postJson(RERANK_API_URL, {
    body: {
      model: RERANK_MODEL,
      input: { query: queryText, documents: docs },
      parameters: { return_documents: false, top_n: docs.length },
    },
    apiKey: apiKey(),
  });
  const results = data?.output?.results;
  if (!Array.isArray(results)) throw new Error('rerank: unexpected response shape');
  return results;
}

// pgvector accepts a bracketed text literal: '[0.1,0.2,...]'.
export const toVectorLiteral = (vec: number[]): string => `[${vec.join(',')}]`;

// Cosine similarity of two equal-length vectors, in [-1, 1]. pgvector handles the *search*
// similarity in SQL; this pure-JS version decides whether two already-retrieved chunks are
// near-duplicates (the dedup pass below). Guard against a zero-magnitude vector.
export function cosineSim(a: number[], b: number[]): number {
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
const parseVec = (v: unknown): number[] => (typeof v === 'string' ? JSON.parse(v) : (v as number[]));

// Two retrieved chunks with cosine ≥ this are treated as duplicates; the lower-ranked one
// is dropped so its slot goes to more diverse info. High enough (0.92) to keep genuinely
// *complementary* same-topic chunks (manual how-to vs faq short-answer), low enough to
// catch the same fact restated across sources. Tunable via env.
const DEDUP_SIM = Number(process.env.RETRIEVAL_DEDUP_SIM || 0.92);

/**
 * Hybrid recall (dense ∪ trigram) → qwen3-rerank → greedy top-k with near-duplicate
 * suppression. Throws on embed/DB/rerank failure — the caller degrades to the full FAQ.
 */
export async function search(
  queryText: string,
  {
    k = Number(process.env.RETRIEVAL_TOP_K || 5),
    candidates = Number(process.env.RETRIEVAL_CANDIDATES || 20),
  }: { k?: number; candidates?: number } = {},
): Promise<Chunk[]> {
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

  const picked: Chunk[] = [];
  const pickedVecs: number[][] = [];
  for (const r of ranked) {
    if (picked.length >= k) break;
    const row = rows[r.index];
    const vec = parseVec(row.embedding);
    if (pickedVecs.some((v) => cosineSim(v, vec) >= DEDUP_SIM)) continue; // drop the dup
    const { embedding, ...rest } = row; // don't leak the 1024-dim vector to callers
    picked.push({ ...rest, score: r.relevance_score } as Chunk);
    pickedVecs.push(vec);
  }
  return picked;
}
