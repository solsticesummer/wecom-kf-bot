"""Source connectors: turn a file or project folder into chunked documents.

v1 handles local files (markdown/text via heading-aware chunking, code/other
text via line-window chunking). Future connectors (PDF, PPTX, a URL crawler)
plug in here behind the same ``collect(path) -> list[doc]`` shape.
"""

from __future__ import annotations

import os

from . import chunk

TEXT_EXT = {".md", ".markdown", ".txt", ".rst"}
CODE_EXT = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".yaml", ".yml",
    ".toml", ".sql", ".sh", ".html", ".css", ".go", ".rs", ".java", ".rb", ".php",
}
SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "dist", "build", "__pycache__",
             ".next", ".turbo", "coverage", ".mypy_cache", ".pytest_cache"}


def collect(root: str) -> list[dict]:
    """Walk ``root`` and return ``[{source, section, content}, ...]``.

    ``source`` is the path relative to ``root`` so results are portable.
    """
    root = os.path.abspath(root)
    if os.path.isfile(root):
        files = [root]
        base = os.path.dirname(root)
    else:
        files = []
        base = root
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for fn in filenames:
                files.append(os.path.join(dirpath, fn))

    docs: list[dict] = []
    for path in files:
        ext = os.path.splitext(path)[1].lower()
        if ext not in TEXT_EXT and ext not in CODE_EXT:
            continue
        try:
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
        except (UnicodeDecodeError, OSError):
            continue  # binary or unreadable — skip
        if not text.strip():
            continue
        rel = os.path.relpath(path, base)

        pieces: list[tuple[str, str]] = []
        if ext in TEXT_EXT:
            pieces = chunk.chunk_markdown(text)
        if not pieces:  # non-markdown, or markdown with no ## headings
            pieces = [(f"{rel}#{i}", c) for i, c in enumerate(chunk.chunk_text(text))]

        for section, content in pieces:
            docs.append({"source": rel, "section": section, "content": content})
    return docs
