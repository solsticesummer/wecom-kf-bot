"""Connector tests: format dispatch, and the graceful-skip contract.

The load-bearing property is that a MISSING extractor skips those files with a warning
instead of failing the ingest. Most projects have neither slides nor PDFs, and `pdftotext`
is a system binary rather than a pip install — an ingest that dies on one unreadable file
would be useless on a real folder.

Run: python tests/test_connectors.py
"""

import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from knowledge import connectors  # noqa: E402


def _write(d, name, text):
    p = os.path.join(d, name)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as fh:
        fh.write(text)
    return p


def test_markdown_splits_on_headings_and_keeps_relative_source():
    with tempfile.TemporaryDirectory() as d:
        _write(d, "docs/faq.md", "# Title\n\n## Pricing\n99 -> 2215\n\n## Refunds\nNo.\n")
        docs = connectors.collect(d)
        assert [x["section"] for x in docs] == ["Pricing", "Refunds"]
        assert all(x["source"] == "docs/faq.md" for x in docs), "source stays relative"
        # The whole reason for heading-based splitting: a table row is never cut.
        assert "99 -> 2215" in docs[0]["content"]


def test_code_falls_back_to_line_windows():
    with tempfile.TemporaryDirectory() as d:
        _write(d, "a.py", "\n".join(f"line{i}" for i in range(100)))
        docs = connectors.collect(d)
        assert len(docs) > 1, "long code file is windowed, not one blob"
        assert all(x["source"] == "a.py" for x in docs)


def test_unknown_extensions_and_skip_dirs_are_ignored():
    with tempfile.TemporaryDirectory() as d:
        _write(d, "keep.md", "## A\nbody\n")
        _write(d, "image.png", "not really a png")
        _write(d, "node_modules/dep.js", "should not be indexed")
        sources = {x["source"] for x in connectors.collect(d)}
        assert sources == {"keep.md"}


def test_pdf_is_extracted_when_pdftotext_exists_and_skipped_otherwise():
    import shutil

    with tempfile.TemporaryDirectory() as d:
        pdf = os.path.join(d, "doc.pdf")
        # Build a real PDF without any pip dependency; macOS ships cupsfilter/textutil.
        txt = _write(d, "src.txt", "PRICING TABLE\n99 yuan -> 2215 credits\n")
        made = False
        try:
            subprocess.run(
                ["cupsfilter", "-i", "text/plain", "-m", "application/pdf", txt],
                stdout=open(pdf, "wb"),
                stderr=subprocess.DEVNULL,
                check=True,
                timeout=60,
            )
            made = os.path.getsize(pdf) > 0
        except Exception:
            made = False
        os.remove(txt)  # keep the folder to just the PDF

        if not made:
            print("  skip test_pdf: could not synthesise a PDF on this machine")
            return

        docs = connectors.collect(d)
        if shutil.which("pdftotext"):
            assert docs, "pdftotext present -> the PDF should yield chunks"
            assert docs[0]["source"] == "doc.pdf"
            assert "2215" in "\n".join(x["content"] for x in docs), "table text survives -layout"
        else:
            assert docs == [], "no pdftotext -> skipped, not an exception"


def test_pptx_without_python_pptx_skips_instead_of_raising():
    try:
        import pptx  # noqa: F401

        print("  skip test_pptx_missing: python-pptx IS installed here")
        return
    except ImportError:
        pass

    with tempfile.TemporaryDirectory() as d:
        _write(d, "deck.pptx", "not a real pptx")
        _write(d, "ok.md", "## A\nbody\n")
        docs = connectors.collect(d)
        # The deck is skipped, but the markdown beside it still ingests.
        assert {x["source"] for x in docs} == {"ok.md"}


def test_a_corrupt_pptx_does_not_abort_the_whole_walk():
    try:
        import pptx  # noqa: F401
    except ImportError:
        print("  skip test_pptx_corrupt: needs python-pptx")
        return

    with tempfile.TemporaryDirectory() as d:
        _write(d, "broken.pptx", "definitely not a zip")
        _write(d, "ok.md", "## A\nbody\n")
        try:
            docs = connectors.collect(d)
        except Exception as exc:  # noqa: BLE001
            raise AssertionError(f"one bad file aborted the ingest: {exc}") from exc
        assert "ok.md" in {x["source"] for x in docs}


if __name__ == "__main__":
    passed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
            passed += 1
    print(f"{passed} passed")
