"""Knowledge + MCP layer for the wecom-kf-bot framework.

Chunk, embed, and hybrid-search arbitrary project corpora, organised by
`namespace`. Runs as a standalone MCP server (stdio) so any agent — Claude Code
locally, or a hosted service — can index and query documents. The design mirrors
the TypeScript bot's retrieval (heading-aware chunking, dense + trigram hybrid,
DashScope embeddings) so the two stay conceptually aligned as the bot later
adopts this as its knowledge backend.
"""

__version__ = "0.1.0"
