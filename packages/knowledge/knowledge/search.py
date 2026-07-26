"""Hybrid search: dense (pgvector cosine) ∪ sparse (pg_trgm) recall, fused, then reranked.

Two stages, doing different jobs:

1. **RRF fusion** merges the two candidate lists. It needs no model call and is robust to
   the two scores living on different scales, but it never looks at the query and a document
   together — it only knows both retrievers liked something.
2. **Cross-encoder rerank** (qwen3-rerank, as in the TS bot) then scores each candidate
   against the query directly, which is what demotes the lexically-similar-but-irrelevant
   chunk that RRF happily promotes.

Rerank is applied to the fused candidates and only then truncated to ``k``: reranking after
the cut would just reorder a list the weaker signal already chose, which is the whole thing
the rerank pass exists to prevent. It degrades to the fused order if unavailable — see
rerank.py for why this layer degrades where the bot's retrieval.ts throws.
"""

from __future__ import annotations

from . import embed, rerank as rerank_mod, store

RRF_K = 60  # standard RRF damping constant


def search(namespace: str, query_text: str, k: int = 5, candidates: int = 20) -> list[dict]:
    conn = store.connect()
    try:
        store.ensure_schema(conn)
        qvec = embed.embed_one(query_text)
        dense = store.dense_search(conn, namespace, qvec, candidates)
        trg = store.trigram_search(conn, namespace, query_text, candidates)
        fused = _rrf(dense, trg)
        return rerank_mod.rerank(query_text, fused)[:k]
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
