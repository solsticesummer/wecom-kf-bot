"""Pure chunking tests — no DB, no network, always runnable.

Mirrors the intent of the TS bot's chunk tests: the ## section split must keep a
pricing-table row intact and drop the title/preamble.
"""

import unittest

from knowledge.chunk import chunk_markdown, chunk_text


class ChunkMarkdown(unittest.TestCase):
    def test_one_chunk_per_section_preamble_dropped_table_intact(self):
        md = "\n".join(
            [
                "# Title",           # H1 — dropped
                "",
                "> author note",     # preamble — dropped
                "",
                "## Alpha",
                "- body a",
                "",
                "## Pricing",
                "| tier | credits |",
                "| --- | --- |",
                "| 99 | 2215 |",
            ]
        )
        chunks = chunk_markdown(md)
        self.assertEqual(len(chunks), 2)
        self.assertEqual(chunks[0][0], "Alpha")
        self.assertTrue(chunks[0][1].startswith("## Alpha"))
        joined = "\n".join(c for _, c in chunks)
        self.assertNotIn("author note", joined)
        self.assertNotIn("# Title", joined)
        self.assertIn("| 99 | 2215 |", chunks[1][1])  # table row not split

    def test_no_headings_returns_empty(self):
        self.assertEqual(chunk_markdown("just some text\nmore text"), [])


class ChunkText(unittest.TestCase):
    def test_windows_are_nonempty_and_cover(self):
        text = "\n".join(f"line {i}" for i in range(100))
        chunks = chunk_text(text, max_lines=40, overlap=5)
        self.assertGreaterEqual(len(chunks), 3)
        self.assertTrue(all(c.strip() for c in chunks))
        self.assertIn("line 0", chunks[0])

    def test_empty_input(self):
        self.assertEqual(chunk_text(""), [])


if __name__ == "__main__":
    unittest.main()
