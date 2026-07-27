"""MCP server exposing the knowledge layer as tools, over stdio or HTTP.

Point any MCP client at it — e.g. Claude Code locally — to index and search a
project's files:

    knowledge-mcp                 # stdio (default), for a local client
    knowledge-mcp --http          # streamable HTTP, for hosted/remote consumers
    # or: python -m knowledge.server

Tools: kb_search, kb_ingest, kb_list_namespaces, kb_delete_namespace.

THE TWO TRANSPORTS HAVE DIFFERENT THREAT MODELS. Over stdio the client is a local process
the user already started, so kb_ingest naming any path is the feature. Over HTTP the caller
is remote, and kb_ingest — which reads a server-side path and makes its contents searchable
— becomes a way to read files off the host: ingest ~/.ssh into a namespace, then kb_search
it back. So HTTP mode requires a bearer token AND confines ingest to KNOWLEDGE_INGEST_ROOT,
and refuses to start without both.
"""

from __future__ import annotations

import hmac
import os
import sys

from mcp.server.fastmcp import FastMCP

from . import config
from . import ingest as ingest_mod
from . import search as search_mod
from . import store

mcp = FastMCP("wecom-knowledge")


def _checked_path(path: str) -> str:
    """Resolve `path`, refusing anything outside KNOWLEDGE_INGEST_ROOT when it is set.

    Resolve first, THEN compare: checking the raw string would let `root/../../etc` through,
    since it only becomes an escape after normalisation. Symlinks resolve too, so a link
    planted inside the root can't point out of it.
    """
    resolved = os.path.realpath(os.path.expanduser(path))

    # A relative path resolves against the SERVER's cwd, which over HTTP has nothing to do
    # with the caller's. Rejecting it outright beats silently indexing whatever happens to
    # sit at that name next to the server.
    if not os.path.isabs(os.path.expanduser(path)):
        raise ValueError(f"path must be absolute (it resolves on the server, not your machine): {path}")

    # os.walk on a missing directory yields nothing, so without this an ingest of a typo'd
    # path reports a cheerful "0 chunks" success and the user goes looking for why search
    # returns nothing.
    if not os.path.exists(resolved):
        raise ValueError(f"path does not exist on the server: {path}")

    if not config.INGEST_ROOT:
        return resolved
    root = os.path.realpath(os.path.expanduser(config.INGEST_ROOT))
    if os.path.commonpath([root, resolved]) != root:
        raise ValueError(f"path is outside the permitted ingest root: {path}")
    return resolved


@mcp.tool()
def kb_search(namespace: str, query: str, k: int = 5) -> list[dict]:
    """Search a knowledge namespace; return the k most relevant chunks
    (source, section, content, score)."""
    return search_mod.search(namespace, query, k=k)


@mcp.tool()
def kb_ingest(namespace: str, path: str) -> dict:
    """Chunk, embed, and index all supported files under `path` into `namespace`
    (replaces the namespace's existing contents)."""
    return ingest_mod.ingest(namespace, _checked_path(path))


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


def _http_app():
    """The MCP streamable-HTTP app, wrapped in bearer auth."""
    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.responses import JSONResponse

    token = config.HTTP_TOKEN

    class BearerAuth(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            # compare_digest rather than ==: a plain comparison short-circuits on the first
            # differing byte, which leaks the token a character at a time to anyone who can
            # time the responses.
            supplied = request.headers.get("authorization", "")
            if not hmac.compare_digest(supplied, f"Bearer {token}"):
                return JSONResponse({"error": "unauthorized"}, status_code=401)
            return await call_next(request)

    app = mcp.streamable_http_app()
    app.add_middleware(BearerAuth)
    return app


def _serve_http() -> None:
    import uvicorn

    if not config.HTTP_TOKEN:
        sys.exit(
            "refusing to start: KNOWLEDGE_HTTP_TOKEN is not set.\n"
            "An unauthenticated HTTP server exposes kb_ingest, which can read any path on "
            "this host and make it searchable."
        )
    if not config.INGEST_ROOT:
        sys.exit(
            "refusing to start: KNOWLEDGE_INGEST_ROOT is not set.\n"
            "Over HTTP, kb_ingest must be confined to a directory — otherwise a remote "
            "caller can ingest arbitrary server files and read them back via kb_search."
        )
    if config.HTTP_HOST not in ("127.0.0.1", "localhost", "::1"):
        print(
            f"WARNING: binding {config.HTTP_HOST} — reachable beyond this host. "
            "Terminate TLS in front of it; the bearer token is sent in plaintext otherwise.",
            file=sys.stderr,
        )
    print(
        f"knowledge-mcp (streamable-http) on {config.HTTP_HOST}:{config.HTTP_PORT}"
        f"{mcp.settings.streamable_http_path}  ingest root: {config.INGEST_ROOT}",
        file=sys.stderr,
    )
    uvicorn.run(_http_app(), host=config.HTTP_HOST, port=config.HTTP_PORT, log_level="warning")


def main() -> None:
    http = "--http" in sys.argv or os.environ.get("KNOWLEDGE_TRANSPORT", "").lower() == "http"
    if http:
        _serve_http()
    else:
        mcp.run()


if __name__ == "__main__":
    main()
