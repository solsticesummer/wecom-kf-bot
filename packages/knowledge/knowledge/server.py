"""MCP server (stdio) exposing the knowledge layer as tools.

Point any MCP client at it — e.g. Claude Code locally — to index and search a
project's files:

    knowledge-mcp                 # after `pip install -e .`
    # or: python -m knowledge.server

Tools: kb_search, kb_ingest, kb_list_namespaces, kb_delete_namespace.
"""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP

from . import ingest as ingest_mod
from . import search as search_mod
from . import store

mcp = FastMCP("wecom-knowledge")


@mcp.tool()
def kb_search(namespace: str, query: str, k: int = 5) -> list[dict]:
    """Search a knowledge namespace; return the k most relevant chunks
    (source, section, content, score)."""
    return search_mod.search(namespace, query, k=k)


@mcp.tool()
def kb_ingest(namespace: str, path: str) -> dict:
    """Chunk, embed, and index all supported files under `path` into `namespace`
    (replaces the namespace's existing contents)."""
    return ingest_mod.ingest(namespace, path)


@mcp.tool()
def kb_list_namespaces() -> list[dict]:
    """List indexed namespaces with their chunk counts."""
    conn = store.connect()
    try:
        store.ensure_schema(conn)
        return [{"namespace": ns, "chunks": count} for ns, count in store.list_namespaces(conn)]
    finally:
        conn.close()


@mcp.tool()
def kb_delete_namespace(namespace: str) -> dict:
    """Delete all chunks in a namespace."""
    conn = store.connect()
    try:
        return {"namespace": namespace, "deleted": store.delete_namespace(conn, namespace)}
    finally:
        conn.close()


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
