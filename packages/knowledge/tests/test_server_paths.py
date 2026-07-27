"""Ingest path confinement — the guard that makes HTTP mode safe to expose.

kb_ingest reads a server-side path and makes its contents searchable, so over HTTP an
unconfined path is a file-read primitive: ingest ~/.ssh into a namespace, kb_search it back.
These tests cover the escapes that a naive string-prefix check would let through.

Run: python tests/test_server_paths.py
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from knowledge import config, server  # noqa: E402


def test_unset_root_is_unrestricted():
    # stdio dev-tool behaviour: the caller is a local process indexing its own files.
    config.INGEST_ROOT = None
    assert server._checked_path("/etc") == os.path.realpath("/etc")


def test_relative_paths_are_refused():
    # They resolve against the SERVER's cwd, which over HTTP is unrelated to the caller's.
    config.INGEST_ROOT = None
    for attempt in ("packages/bot", "./docs", "docs"):
        try:
            server._checked_path(attempt)
        except ValueError as exc:
            assert "absolute" in str(exc)
            continue
        raise AssertionError(f"relative path accepted: {attempt}")


def test_missing_path_is_refused_rather_than_silently_empty():
    # os.walk on a missing dir yields nothing, so without this an ingest of a typo'd path
    # reports a cheerful "0 chunks" success.
    config.INGEST_ROOT = None
    try:
        server._checked_path("/definitely/not/here/at/all")
    except ValueError as exc:
        assert "does not exist" in str(exc)
        return
    raise AssertionError("missing path accepted")


def test_paths_inside_the_root_are_allowed():
    with tempfile.TemporaryDirectory() as d:
        config.INGEST_ROOT = d
        inner = os.path.join(d, "project", "docs")
        os.makedirs(inner)
        assert server._checked_path(inner) == os.path.realpath(inner)
        assert server._checked_path(d) == os.path.realpath(d)


def test_dotdot_traversal_is_refused():
    # The escape only appears after normalisation — a raw string prefix check passes this.
    with tempfile.TemporaryDirectory() as d:
        config.INGEST_ROOT = d
        for attempt in (os.path.join(d, "..", ".."), os.path.join(d, "..", "elsewhere"), "/etc"):
            try:
                server._checked_path(attempt)
            except ValueError:
                continue
            raise AssertionError(f"escaped the root: {attempt}")


def test_symlink_out_of_the_root_is_refused():
    # A link planted inside the root must not become a way out of it.
    with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
        config.INGEST_ROOT = root
        link = os.path.join(root, "escape")
        os.symlink(outside, link)
        try:
            server._checked_path(link)
        except ValueError:
            return
        raise AssertionError("symlink escaped the root")


def test_sibling_directory_with_a_shared_prefix_is_refused():
    # /tmp/root-evil must not pass because it starts with /tmp/root. commonpath catches
    # this; `resolved.startswith(root)` would not.
    with tempfile.TemporaryDirectory() as d:
        root = os.path.join(d, "root")
        sibling = os.path.join(d, "root-evil")
        os.makedirs(root)
        os.makedirs(sibling)
        config.INGEST_ROOT = root
        try:
            server._checked_path(sibling)
        except ValueError:
            return
        raise AssertionError("shared-prefix sibling escaped the root")


if __name__ == "__main__":
    saved = config.INGEST_ROOT
    passed = 0
    try:
        for name, fn in sorted(globals().items()):
            if name.startswith("test_") and callable(fn):
                fn()
                print(f"  ok  {name}")
                passed += 1
    finally:
        config.INGEST_ROOT = saved
    print(f"{passed} passed")
