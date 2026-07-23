"""Hybrid search: dense (pgvector cosine) ∪ sparse (pg_trgm) recall, fused.

v1 fuses the two candidate lists with Reciprocal Rank Fusion (RRF) instead of a
learned reranker. RRF needs no extra model call, is robust to the two scores
being on different scales, and is a strong default for a dev-tool search engine.
A qwen3-rerank pass (as in the TS bot) can slot in later behind this same API.
"""

from __future__ import annotations

from . import embed, store

RRF_K = 60  # standard RRF damping constant


def search(namespace: str, query_text: str, k: int = 5, candidates: int = 20) -> list[dict]:
    conn = store.connect()
    try:
        store.ensure_schema(conn)
        qvec = embed.embed_one(query_text)
        dense = store.dense_search(conn, namespace, qvec, candidates)
        trg = store.trigram_search(conn, namespace, query_text, candidates)
        return _rrf(dense, trg)[:k]
    finally:
        conn.close()


def _rrf(dense: list[dict], trigram: list[dict]) -> list[dict]:
    scores: dict[int, float] = {}
    meta: dict[int, dict] = {}
    for ranked in (dense, trigram):
        for rank, row in enumerate(ranked):
            rid = row["id"]
            scores[rid] = scores.get(rid, 0.0) + 1.0 / (RRF_K + rank + 1)
            meta[rid] = row
    ordered = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    return [
        {
            "source": meta[rid]["source"],
            "section": meta[rid]["section"],
            "content": meta[rid]["content"],
            "score": round(score, 6),
        }
        for rid, score in ordered
    ]
