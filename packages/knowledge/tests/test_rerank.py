"""Rerank behaviour, with no network: the degradation paths are the point.

Run: python tests/test_rerank.py
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from knowledge import rerank  # noqa: E402


def rows(*texts):
    return [{"source": "s", "section": "x", "content": t} for t in texts]


def test_disabled_is_a_passthrough():
    rerank.config.RERANK = "off"
    r = rows("a", "b", "c")
    assert rerank.rerank("q", r) == r
    assert not rerank.enabled()


def test_auto_stays_off_without_a_real_embedder_or_key():
    # 'auto' must not fire a doomed network call on every offline search.
    rerank.config.RERANK = "auto"
    rerank.config.EMBEDDER = "fake"
    assert not rerank.enabled()

    rerank.config.EMBEDDER = "dashscope"
    saved = (os.environ.pop("MODELSTUDIO_API_KEY", None), os.environ.pop("DASHSCOPE_API_KEY", None))
    try:
        assert not rerank.enabled()
        os.environ["MODELSTUDIO_API_KEY"] = "sk-test"
        assert rerank.enabled()
    finally:
        os.environ.pop("MODELSTUDIO_API_KEY", None)
        for name, val in zip(("MODELSTUDIO_API_KEY", "DASHSCOPE_API_KEY"), saved):
            if val is not None:
                os.environ[name] = val


def test_api_failure_keeps_the_fused_order():
    # A dev tool must still answer when the reranker is down — degrade, never raise.
    rerank.config.RERANK = "on"
    original = rerank._dashscope
    rerank._dashscope = lambda *_: (_ for _ in ()).throw(RuntimeError("boom"))
    try:
        r = rows("a", "b", "c")
        assert rerank.rerank("q", r) == r
    finally:
        rerank._dashscope = original


def test_reorders_by_score_and_tags_it():
    rerank.config.RERANK = "on"
    original = rerank._dashscope
    rerank._dashscope = lambda *_: [
        {"index": 0, "relevance_score": 0.1},
        {"index": 1, "relevance_score": 0.9},
        {"index": 2, "relevance_score": 0.5},
    ]
    try:
        out = rerank.rerank("q", rows("a", "b", "c"))
        assert [d["content"] for d in out] == ["b", "c", "a"]
        assert out[0]["rerank_score"] == 0.9
    finally:
        rerank._dashscope = original


def test_out_of_range_index_falls_back_instead_of_crashing():
    # A malformed response must not IndexError out of a search that already has results.
    rerank.config.RERANK = "on"
    original = rerank._dashscope
    rerank._dashscope = lambda *_: [{"index": 99, "relevance_score": 0.9}]
    try:
        r = rows("a", "b")
        assert rerank.rerank("q", r) == r
    finally:
        rerank._dashscope = original


def test_empty_input_is_safe():
    rerank.config.RERANK = "on"
    assert rerank.rerank("q", []) == []


if __name__ == "__main__":
    passed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
            passed += 1
    print(f"{passed} passed")
