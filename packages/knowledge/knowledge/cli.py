"""Convenience CLI (no MCP client needed) for ingesting and searching.

    knowledge ingest <namespace> <path>
    knowledge search <namespace> "<query>" [-k N]
    knowledge namespaces
    knowledge delete <namespace>
"""

from __future__ import annotations

import argparse
import json

from . import ingest as ingest_mod
from . import search as search_mod
from . import store


def main() -> None:
    p = argparse.ArgumentParser(prog="knowledge")
    sub = p.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("ingest", help="index a file or folder into a namespace")
    pi.add_argument("namespace")
    pi.add_argument("path")

    ps = sub.add_parser("search", help="search a namespace")
    ps.add_argument("namespace")
    ps.add_argument("query")
    ps.add_argument("-k", type=int, default=5)

    sub.add_parser("namespaces", help="list namespaces and chunk counts")

    pd = sub.add_parser("delete", help="delete a namespace")
    pd.add_argument("namespace")

    args = p.parse_args()

    if args.cmd == "ingest":
        print(json.dumps(ingest_mod.ingest(args.namespace, args.path), ensure_ascii=False, indent=2))
    elif args.cmd == "search":
        for r in search_mod.search(args.namespace, args.query, k=args.k):
            snippet = r["content"][:160].replace("\n", " ")
            ellipsis = "…" if len(r["content"]) > 160 else ""
            print(f"[{r['score']}] {r['source']} — {r['section']}")
            print(f"   {snippet}{ellipsis}")
    elif args.cmd == "namespaces":
        conn = store.connect()
        try:
            store.ensure_schema(conn)
            for ns, count in store.list_namespaces(conn):
                print(f"{ns}\t{count}")
        finally:
            conn.close()
    elif args.cmd == "delete":
        conn = store.connect()
        try:
            print(f"deleted {store.delete_namespace(conn, args.namespace)} chunks from {args.namespace}")
        finally:
            conn.close()


if __name__ == "__main__":
    main()
