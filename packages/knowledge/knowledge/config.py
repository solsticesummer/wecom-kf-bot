"""Environment-driven configuration.

Mirrors the TypeScript side's env names so a single .env can serve both:
DashScope embeddings need the STANDARD (sk-ws) key — MODELSTUDIO_API_KEY first,
falling back to DASHSCOPE_API_KEY for single-key setups.
"""

import os

# The store's Postgres. Prefer a dedicated URL so the dev tool never shares the
# live bot's database by accident; fall back to DATABASE_URL for convenience.
DATABASE_URL = os.environ.get("KNOWLEDGE_DATABASE_URL") or os.environ.get("DATABASE_URL")

EMBEDDING_API_URL = os.environ.get(
    "EMBEDDING_API_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings"
)
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "text-embedding-v4")
EMBEDDING_DIM = int(os.environ.get("EMBEDDING_DIM", "1024"))

# "dashscope" (real embeddings) or "fake" (deterministic hash embeddings for
# offline tests — no network, no key). The fake embedder is NOT semantic; it
# only exercises the store/search plumbing.
EMBEDDER = os.environ.get("KNOWLEDGE_EMBEDDER", "dashscope")


def api_key() -> str | None:
    return os.environ.get("MODELSTUDIO_API_KEY") or os.environ.get("DASHSCOPE_API_KEY")
