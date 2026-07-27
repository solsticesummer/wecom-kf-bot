# knowledge (Python)

The reusable **knowledge + MCP layer** for the framework: chunk, embed, and
hybrid-search arbitrary project corpora, organised by `namespace`. Runs as a
standalone **MCP server** so any agent (Claude Code locally, or a hosted service)
can index and query files — including a completely unrelated project's source.

This is the Python half of the TS-bot + Python-knowledge split. It's being
proven as a **local dev tool first**; the live bot keeps its in-process TS
retrieval until this service earns the cutover.

## What it does
- **Chunking** (`chunk.py`) — heading-aware for markdown (never splits a table
  row), line-window fallback for code/text. Same design as the bot's `chunk.ts`.
- **Connectors** (`connectors.py`) — walk a folder: markdown/text, code, **PDF**
  (via `pdftotext -layout`) and **PPTX** (one chunk per slide). Both binary
  extractors are optional — a missing one skips those files with a warning
  instead of failing the ingest.
- **Embeddings** (`embed.py`) — DashScope `text-embedding-v4` (1024-dim), the
  same service the bot uses. A deterministic `fake` backend enables offline tests.
- **Store** (`store.py`) — Postgres + pgvector, with a first-class `namespace`
  column (the reference schema the bot will adopt).
- **Search** (`search.py`) — dense (cosine) ∪ trigram recall, fused with
  Reciprocal Rank Fusion, then a **qwen3-rerank** cross-encoder pass
  (`rerank.py`). Rerank runs on the fused candidates *before* the top-`k` cut, and
  degrades to the fused order if it's unavailable — unlike the bot's
  `retrieval.ts`, which throws so the bot can fall back to its whole FAQ.
- **MCP server** (`server.py`) — tools `kb_search`, `kb_ingest`,
  `kb_list_namespaces`, `kb_delete_namespace`.

## Setup
```bash
cd packages/knowledge
python3 -m venv .venv && . .venv/bin/activate
pip install -e '.[docs]' --config-settings editable_mode=compat  # compat = reliable console scripts
cp .env.example .env    # set KNOWLEDGE_DATABASE_URL + MODELSTUDIO_API_KEY
createdb knowledge_dev  # a dedicated DB (not the bot's)
```

`[docs]` pulls in `python-pptx` for slides. PDF support needs the `pdftotext`
binary, which is not a pip package: `brew install poppler`.

Set `KNOWLEDGE_RERANK=off` to skip the rerank pass. The default, `auto`, enables
it only when it can work (a real embedder and an API key), so offline runs don't
make a doomed network call on every search.

## Use as a CLI (no MCP client needed)
```bash
knowledge ingest my-project /path/to/some/repo
knowledge search my-project "how does auth work?"
knowledge namespaces
```

## Use as an MCP server

```bash
knowledge-mcp          # stdio; point an MCP client (e.g. Claude Code) at this
knowledge-mcp --http   # streamable HTTP, for hosted/remote consumers
```

**The two transports have different threat models.** Over stdio the client is a local
process you started, so `kb_ingest` naming any path is the feature. Over HTTP the caller is
remote, and `kb_ingest` — which reads a server-side path and makes it searchable — becomes a
file-read primitive: ingest `~/.ssh` into a namespace, then `kb_search` it back. So HTTP mode
**refuses to start** without both:

```bash
export KNOWLEDGE_HTTP_TOKEN=$(openssl rand -hex 32)   # bearer token, required
export KNOWLEDGE_INGEST_ROOT=/srv/corpora             # ingest confined here, required
knowledge-mcp --http                                  # binds 127.0.0.1:8765/mcp
```

`KNOWLEDGE_INGEST_ROOT` also applies to stdio when set; unset + stdio is unrestricted.
Paths must be absolute and must exist — a relative path would resolve against the *server's*
cwd, and a missing one would otherwise ingest 0 chunks and look like success.

Binding anything other than loopback warns: the bearer token travels in plaintext, so
terminate TLS in front of it.

## Tests
No DB, no network, no API key — each file is runnable on its own:
```bash
python tests/test_chunk.py         # chunking
python tests/test_rerank.py        # rerank ordering + every degradation path
python tests/test_connectors.py    # format dispatch + graceful skips
python tests/test_server_paths.py  # ingest path confinement (traversal, symlink, prefix)
```
They bootstrap `sys.path` to the source tree rather than relying on the editable
install, whose strict `.pth` finder doesn't auto-load on every machine.
