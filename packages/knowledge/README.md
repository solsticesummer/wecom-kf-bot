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
- **Embeddings** (`embed.py`) — DashScope `text-embedding-v4` (1024-dim), the
  same service the bot uses. A deterministic `fake` backend enables offline tests.
- **Store** (`store.py`) — Postgres + pgvector, with a first-class `namespace`
  column (the reference schema the bot will adopt).
- **Search** (`search.py`) — dense (cosine) ∪ trigram recall, fused with
  Reciprocal Rank Fusion. A qwen3-rerank pass can slot in later.
- **MCP server** (`server.py`) — tools `kb_search`, `kb_ingest`,
  `kb_list_namespaces`, `kb_delete_namespace`.

## Setup
```bash
cd packages/knowledge
python3 -m venv .venv && . .venv/bin/activate
pip install -e . --config-settings editable_mode=compat  # compat = reliable console scripts
cp .env.example .env    # set KNOWLEDGE_DATABASE_URL + MODELSTUDIO_API_KEY
createdb knowledge_dev  # a dedicated DB (not the bot's)
```

## Use as a CLI (no MCP client needed)
```bash
knowledge ingest my-project /path/to/some/repo
knowledge search my-project "how does auth work?"
knowledge namespaces
```

## Use as an MCP server
```bash
knowledge-mcp          # stdio; point an MCP client (e.g. Claude Code) at this
```

## Tests
```bash
python -m unittest discover -s tests        # pure chunking, no infra
```
