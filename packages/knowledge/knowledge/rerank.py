"""Cross-encoder reranking via DashScope's native rerank API (qwen3-rerank).

RRF (see search.py) fuses two ranked lists without ever looking at the query and a
document *together* — it only knows "both retrievers liked this". A cross-encoder scores
each candidate against the query directly, which is what fixes the common failure where a
lexically-similar-but-irrelevant chunk outranks the one that actually answers the question.

DEGRADATION DIFFERS FROM THE TS BOT ON PURPOSE. `retrieval.ts` throws when rerank fails, so
`generateReply` can fall back to inlining the whole FAQ — the bot must never produce a
customer-visible outage. This layer serves a developer at a CLI or an agent over MCP, where
RRF-ordered results are a perfectly good answer and a hard failure would be the worse
outcome. So a rerank outage here logs and returns the fused order untouched.
"""

from __future__ import annotations

import logging

import httpx

from . import config

log = logging.getLogger(__name__)


def enabled() -> bool:
    """Whether to attempt a rerank pass at all.

    'auto' (the default) means "on when it can actually work": a real embedder and a key.
    That keeps offline runs (KNOWLEDGE_EMBEDDER=fake) and unconfigured checkouts from making
    a doomed network call on every search.
    """
    setting = config.RERANK.lower()
    if setting in ("off", "false", "0", "none"):
        return False
    if setting == "auto":
        return config.EMBEDDER != "fake" and bool(config.api_key())
    return True


def rerank(query_text: str, rows: list[dict]) -> list[dict]:
    """Reorder ``rows`` (each with ``content``) by cross-encoder relevance to the query.

    Returns the input reordered, with a ``rerank_score`` added. Falls back to the input
    order — unchanged — if reranking is disabled or fails.
    """
    if not rows or not enabled():
        return rows
    try:
        results = _dashscope(query_text, [r["content"] for r in rows])
    except Exception as exc:  # noqa: BLE001 — any failure degrades to the fused order
        log.warning("rerank failed, keeping fused order: %s", exc)
        return rows

    out: list[dict] = []
    for r in sorted(results, key=lambda x: x["relevance_score"], reverse=True):
        idx = r["index"]
        # The API echoes indexes into the list we sent; a malformed response must not
        # IndexError its way out of a search that already has usable results.
        if not isinstance(idx, int) or not 0 <= idx < len(rows):
            log.warning("rerank returned out-of-range index %r, keeping fused order", idx)
            return rows
        out.append({**rows[idx], "rerank_score": round(float(r["relevance_score"]), 6)})
    return out


def _dashscope(query_text: str, docs: list[str]) -> list[dict]:
    key = config.api_key()
    if not key:
        raise RuntimeError("no rerank API key — set MODELSTUDIO_API_KEY (or DASHSCOPE_API_KEY)")
    resp = httpx.post(
        config.RERANK_API_URL,
        headers={"authorization": f"Bearer {key}"},
        json={
            "model": config.RERANK_MODEL,
            "input": {"query": query_text, "documents": docs},
            "parameters": {"return_documents": False, "top_n": len(docs)},
        },
        timeout=30.0,
    )
    resp.raise_for_status()
    results = resp.json().get("output", {}).get("results")
    if not isinstance(results, list):
        raise RuntimeError("rerank: unexpected response shape")
    return results
