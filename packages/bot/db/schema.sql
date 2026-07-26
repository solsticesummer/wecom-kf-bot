-- Knowledge-base retrieval schema (Phase 1: hybrid vector + trigram).
-- Applied by scripts/migrate.js. Idempotent — safe to run repeatedly.

CREATE EXTENSION IF NOT EXISTS vector;    -- pgvector: the `vector` column type + `<=>` distance
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- trigram similarity for the keyword half (Chinese-friendly, no build)

CREATE TABLE IF NOT EXISTS chunks (
  id          BIGSERIAL PRIMARY KEY,
  namespace   TEXT NOT NULL DEFAULT 'dramaclaw', -- which tenant/project this chunk belongs to
  source      TEXT NOT NULL DEFAULT 'faq.md',  -- which document within the namespace: 'faq.md' | 'manual' | 'whitepaper'
  section     TEXT,                            -- heading / heading-path, kept as retrieval context
  content     TEXT NOT NULL,                   -- the chunk text that gets embedded + injected
  embedding   VECTOR(1024),                    -- text-embedding-v4 with dimensions pinned to 1024
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The CREATE TABLE above only runs on a FRESH database. On the live one the table already
-- exists, so IF NOT EXISTS makes it a no-op and editing its body changes nothing — every
-- column added after the first deploy needs its own ALTER. This one is safe to run against
-- a serving bot: the DEFAULT backfills existing rows in place, so retrieval keeps working
-- through the migration instead of briefly seeing NULL namespaces.
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS namespace TEXT NOT NULL DEFAULT 'dramaclaw';

-- Dense recall: approximate-nearest-neighbour over cosine distance.
-- HNSW (vs ivfflat) needs no training step and stays accurate as rows grow — better fit for an
-- incrementally-rebuilt KB. `vector_cosine_ops` must match the `<=>` operator used at query time.
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw
  ON chunks USING hnsw (embedding vector_cosine_ops);

-- Keyword recall: GIN trigram index so `content % $query` / `similarity(content, $query)` is fast.
CREATE INDEX IF NOT EXISTS chunks_content_trgm
  ON chunks USING gin (content gin_trgm_ops);

-- Per-source re-indexing (DELETE ... WHERE namespace = $1 AND source = $2) hits this, as does
-- the namespace filter on both recall CTEs in src/retrieval.ts.
CREATE INDEX IF NOT EXISTS chunks_namespace_source ON chunks (namespace, source);

-- Superseded by the composite above: nothing filters on `source` alone anymore, and a
-- (namespace, source) index can't serve a source-only lookup, so the old one is dead weight
-- rather than a fallback. Dropping it here keeps a re-applied schema.sql converging on one
-- shape instead of accumulating every index this table has ever had.
DROP INDEX IF EXISTS chunks_source;
