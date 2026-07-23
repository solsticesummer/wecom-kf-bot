"""Postgres + pgvector store, organised by ``namespace``.

This is the reference schema the TS bot will later adopt: unlike the bot's
current single-corpus ``chunks`` table, ``kb_chunks`` carries a first-class
``namespace`` column so one store can hold many projects' corpora side by side.

Vectors are passed as pgvector's text literal ``'[0.1,0.2,...]'::vector`` — the
same trick the TS side uses — so no pgvector Python adapter is required.
"""

from __future__ import annotations

import psycopg
from psycopg.rows import dict_row

from . import config

TABLE = "kb_chunks"


def connect() -> psycopg.Connection:
    if not config.DATABASE_URL:
        raise RuntimeError("DATABASE_URL (or KNOWLEDGE_DATABASE_URL) is not set")
    return psycopg.connect(config.DATABASE_URL)


def to_vector_literal(vec: list[float]) -> str:
    return "[" + ",".join(str(float(x)) for x in vec) + "]"


def ensure_schema(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
        cur.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
        cur.execute(
            f"""CREATE TABLE IF NOT EXISTS {TABLE} (
                id          BIGSERIAL PRIMARY KEY,
                namespace   TEXT NOT NULL,
                source      TEXT NOT NULL,
                section     TEXT,
                content     TEXT NOT NULL,
                embedding   VECTOR({config.EMBEDDING_DIM}),
                created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
            )"""
        )
        cur.execute(
            f"CREATE INDEX IF NOT EXISTS kb_chunks_embedding_hnsw "
            f"ON {TABLE} USING hnsw (embedding vector_cosine_ops)"
        )
        cur.execute(
            f"CREATE INDEX IF NOT EXISTS kb_chunks_content_trgm "
            f"ON {TABLE} USING gin (content gin_trgm_ops)"
        )
        cur.execute(f"CREATE INDEX IF NOT EXISTS kb_chunks_namespace ON {TABLE} (namespace)")
    conn.commit()


def replace_namespace(conn: psycopg.Connection, namespace: str, rows: list[dict]) -> int:
    """Reload one namespace atomically: delete its rows, insert the new ones.

    Each row is ``{source, section, content, embedding: list[float]}``.
    """
    with conn.cursor() as cur:
        cur.execute(f"DELETE FROM {TABLE} WHERE namespace = %s", (namespace,))
        for r in rows:
            cur.execute(
                f"INSERT INTO {TABLE} (namespace, source, section, content, embedding) "
                f"VALUES (%s, %s, %s, %s, %s::vector)",
                (namespace, r["source"], r["section"], r["content"], to_vector_literal(r["embedding"])),
            )
    conn.commit()
    return len(rows)


def dense_search(conn: psycopg.Connection, namespace: str, qvec: list[float], limit: int) -> list[dict]:
    lit = to_vector_literal(qvec)
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            f"SELECT id, source, section, content, 1 - (embedding <=> %s::vector) AS score "
            f"FROM {TABLE} WHERE namespace = %s "
            f"ORDER BY embedding <=> %s::vector LIMIT %s",
            (lit, namespace, lit, limit),
        )
        return cur.fetchall()


def trigram_search(conn: psycopg.Connection, namespace: str, qtext: str, limit: int) -> list[dict]:
    with conn.cursor(row_factory=dict_row) as cur:
        # `%%` is a literal % (the pg_trgm match operator) under psycopg's %s params.
        cur.execute(
            f"SELECT id, source, section, content, similarity(content, %s) AS score "
            f"FROM {TABLE} WHERE namespace = %s AND content %% %s "
            f"ORDER BY similarity(content, %s) DESC LIMIT %s",
            (qtext, namespace, qtext, qtext, limit),
        )
        return cur.fetchall()


def list_namespaces(conn: psycopg.Connection) -> list[tuple[str, int]]:
    with conn.cursor() as cur:
        cur.execute(f"SELECT namespace, count(*) FROM {TABLE} GROUP BY namespace ORDER BY namespace")
        return cur.fetchall()


def delete_namespace(conn: psycopg.Connection, namespace: str) -> int:
    with conn.cursor() as cur:
        cur.execute(f"DELETE FROM {TABLE} WHERE namespace = %s", (namespace,))
        n = cur.rowcount
    conn.commit()
    return n
