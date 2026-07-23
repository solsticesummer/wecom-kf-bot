"""Pure chunking — no I/O, no DB, no network — so it's trivially unit-testable.

Design rule (shared with the TS bot's chunk.ts): for structured docs, split on
*headings*, never on a fixed character/token count, so a pricing/permission
table is never cut mid-row. Unstructured files fall back to a line-window split.
"""

from __future__ import annotations


def chunk_markdown(text: str) -> list[tuple[str, str]]:
    """One chunk per top-level ``## `` section, heading kept with its body.

    Returns a list of ``(section, content)``. Content before the first ``## ``
    (an ``# H1`` title, a ``>`` preamble) is dropped — it's meta, not knowledge.
    A document with no ``## `` headings yields ``[]`` (the caller can fall back
    to :func:`chunk_text`).
    """
    lines = text.split("\n")
    chunks: list[tuple[str, str]] = []
    current: list[str] | None = None  # None until the first `## ` heading
    heading = ""

    for line in lines:
        if line.startswith("## "):
            if current is not None:
                chunks.append((heading, "\n".join(current).strip()))
            heading = line.lstrip("#").strip()  # `## Pricing` -> `Pricing`
            current = [line]  # keep the heading line inside the chunk
        elif current is not None:
            current.append(line)
        # lines before the first `## ` fall through and are dropped

    if current is not None:
        chunks.append((heading, "\n".join(current).strip()))

    return [(h, c) for (h, c) in chunks if c]


def chunk_text(text: str, max_lines: int = 40, overlap: int = 5) -> list[str]:
    """Generic fallback for code / plain text: overlapping line windows.

    A small overlap keeps a definition and its first use in the same chunk more
    often. Empty windows are skipped.
    """
    lines = text.split("\n")
    n = len(lines)
    if n == 0:
        return []
    step = max(1, max_lines - overlap)
    chunks: list[str] = []
    i = 0
    while i < n:
        content = "\n".join(lines[i : i + max_lines]).strip()
        if content:
            chunks.append(content)
        i += step
    return chunks
