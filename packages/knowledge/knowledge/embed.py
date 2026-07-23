"""Embeddings.

Default backend is DashScope's OpenAI-compatible /embeddings (text-embedding-v4,
dimensions pinned to match the vector column) — the same service the TS bot uses.
A deterministic "fake" backend (config.EMBEDDER=fake) lets the store/search
plumbing be exercised offline with no key and no network.
"""

from __future__ import annotations

import hashlib

import httpx

from . import config


def embed_one(text: str) -> list[float]:
    return embed_many([text])[0]


def embed_many(texts: list[str]) -> list[list[float]]:
    if config.EMBEDDER == "fake":
        return [_fake(t) for t in texts]
    return _dashscope(texts)


def _dashscope(texts: list[str]) -> list[list[float]]:
    key = config.api_key()
    if not key:
        raise RuntimeError(
            "no embedding API key — set MODELSTUDIO_API_KEY (or DASHSCOPE_API_KEY)"
        )
    resp = httpx.post(
        config.EMBEDDING_API_URL,
        headers={"authorization": f"Bearer {key}"},
        json={"model": config.EMBEDDING_MODEL, "input": texts, "dimensions": config.EMBEDDING_DIM},
        timeout=30.0,
    )
    resp.raise_for_status()
    data = resp.json()
    return [d["embedding"] for d in data["data"]]


def _fake(text: str) -> list[float]:
    """Deterministic pseudo-embedding for offline tests. NOT semantic — it only
    guarantees the same text maps to the same vector so search plumbing works."""
    dim = config.EMBEDDING_DIM
    out: list[float] = []
    counter = 0
    while len(out) < dim:
        digest = hashlib.sha256(f"{counter}:{text}".encode()).digest()
        for b in digest:
            out.append((b / 255.0) * 2 - 1)
            if len(out) >= dim:
                break
        counter += 1
    return out
