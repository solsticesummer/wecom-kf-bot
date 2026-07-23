-- Knowledge-base retrieval schema (Phase 1: hybrid vector + trigram).
-- Applied by scripts/migrate.js. Idempotent — safe to run repeatedly.

CREATE EXTENSION IF NOT EXISTS vector;    -- pgvector: the `vector` column type + `<=>` distance
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- trigram similarity for the keyword half (Chinese-friendly, no build)

CREATE TABLE IF NOT EXISTS chunks (
  id          BIGSERIAL PRIMARY KEY,
  source      TEXT NOT NULL DEFAULT 'faq.md',  -- which corpus: 'faq.md' | 'manual' | 'whitepaper' (also a future tenant axis)
  section     TEXT,                            -- heading / heading-path, kept as retrieval context
  content     TEXT NOT NULL,                   -- the chunk text that gets embedded + injected
  embedding   VECTOR(1024),                    -- text-embedding-v4 with dimensions pinned to 1024
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dense recall: approximate-nearest-neighbour over cosine distance.
-- HNSW (vs ivfflat) needs no training step and stays accurate as rows grow — better fit for an
-- incrementally-rebuilt KB. `vector_cosine_ops` must match the `<=>` operator used at query time.
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw
  ON chunks USING hnsw (embedding vector_cosine_ops);

-- Keyword recall: GIN trigram index so `content % $query` / `similarity(content, $query)` is fast.
CREATE INDEX IF NOT EXISTS chunks_content_trgm
  ON chunks USING gin (content gin_trgm_ops);

-- Per-source re-indexing (DELETE ... WHERE source = $1) hits this.
CREATE INDEX IF NOT EXISTS chunks_source ON chunks (source);
