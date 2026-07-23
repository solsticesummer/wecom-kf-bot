"""High-level ingestion: collect → embed → store, per namespace."""

from __future__ import annotations

from . import connectors, embed, store


def ingest(namespace: str, path: str) -> dict:
    """Chunk, embed, and (re)index everything under ``path`` into ``namespace``.

    Replaces the namespace wholesale — re-running is how you refresh a corpus.
    Embeds sequentially to stay comfortably under DashScope rate limits.
    """
    docs = connectors.collect(path)
    if not docs:
        return {"namespace": namespace, "ingested": 0, "note": "no supported files found"}

    for d in docs:
        d["embedding"] = embed.embed_one(d["content"])

    conn = store.connect()
    try:
        store.ensure_schema(conn)
        n = store.replace_namespace(conn, namespace, docs)
    finally:
        conn.close()
    return {"namespace": namespace, "ingested": n}
