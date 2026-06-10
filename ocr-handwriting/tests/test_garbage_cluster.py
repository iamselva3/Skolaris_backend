"""Slice 2.4 — garbage-cluster filter logic validation.

Runs against the actual functions in paddle_engine.py without needing
paddleocr/numpy/PIL installed: the filter functions are pure-stdlib and
paddleocr is imported lazily inside methods we don't call from here.

Usage:
    cd ocr-handwriting
    pytest tests/test_garbage_cluster.py -v
"""
import os
import sys

# Ensure the app package is importable from this test file's location.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.engines.paddle_engine import (  # noqa: E402
    _looks_like_noise_text,
    _separate_garbage_clusters,
    GARBAGE_MIN_CLUSTER,
)


def _word(text: str, conf: float, x0: float, y0: float, x1: float, y1: float) -> dict:
    """Build a word record matching the shape recognize_structured emits."""
    return {'text': text, 'conf': conf, 'x0': x0, 'y0': y0, 'x1': x1, 'y1': y1}


# ─────────────────────────────────────────────────────────────────
# Noise-text detector
# ─────────────────────────────────────────────────────────────────

def test_noise_short_symbol_tokens_flagged():
    assert _looks_like_noise_text('@')
    assert _looks_like_noise_text('@)')
    assert _looks_like_noise_text('€o')
    assert _looks_like_noise_text('+')
    assert _looks_like_noise_text('&')


def test_noise_legit_short_text_not_flagged():
    assert not _looks_like_noise_text('(1)')   # option marker
    assert not _looks_like_noise_text('3)')    # option marker
    assert not _looks_like_noise_text('the')
    assert not _looks_like_noise_text('A')     # single letter
    assert not _looks_like_noise_text('B')


def test_noise_alphanumeric_short_kept():
    # 'ef' is short but pure alpha — not flagged as noise via the char rule.
    # It can still be flagged as suspect via low confidence in the cluster step.
    assert not _looks_like_noise_text('ef')


# ─────────────────────────────────────────────────────────────────
# Cluster separation
# ─────────────────────────────────────────────────────────────────

def test_empty_input():
    clean, clusters = _separate_garbage_clusters([])
    assert clean == [] and clusters == []


def test_clean_paper_no_clusters_dropped():
    """Real question with options — nothing should be flagged."""
    words = [
        _word('The', 0.96, 100, 100, 130, 120),
        _word('net', 0.97, 135, 100, 160, 120),
        _word('electric', 0.95, 165, 100, 220, 120),
        _word('flux', 0.94, 225, 100, 255, 120),
        _word('(1)', 0.93, 100, 200, 125, 220),
        _word('(2)', 0.92, 100, 230, 125, 250),
        _word('(3)', 0.94, 100, 260, 125, 280),
        _word('(4)', 0.91, 100, 290, 125, 310),
    ]
    clean, clusters = _separate_garbage_clusters(words)
    assert len(clusters) == 0
    assert len(clean) == len(words)


def test_singleton_low_conf_survives():
    """A single mangled ε₀ should NOT be dropped — singletons survive."""
    words = [
        _word('The', 0.96, 100, 100, 130, 120),
        _word('charge', 0.95, 135, 100, 200, 120),
        _word('€o', 0.55, 205, 100, 230, 120),  # lone mangled ε₀, low conf
        _word('value', 0.94, 235, 100, 280, 120),
    ]
    clean, clusters = _separate_garbage_clusters(words)
    assert len(clusters) == 0, 'singleton suspect must not form a cluster'
    assert any(w['text'] == '€o' for w in clean), 'singleton ε₀ must be kept'


def test_aakash_page1_garbage_cluster_dropped():
    """The exact garbage shape from the user's reported leak.

    The reported corrupt stem ended with:
      "(1) €o @ a @) 3) + & "@ ef3C @ 5 c 1"

    PaddleOCR emits these as separate detected lines inside the circuit
    diagram region. We model them as adjacent low-conf tokens. Expected:
    one cluster covering the diagram bbox, suspects removed from clean_words.
    """
    # Real-text tokens BEFORE the diagram (the actual question stem)
    stem_words = [
        _word('positive', 0.94, 100, 100, 160, 120),
        _word('charge', 0.95, 165, 100, 220, 120),
        _word('is', 0.92, 225, 100, 240, 120),
        _word('(in', 0.93, 245, 100, 270, 120),
        _word('SI', 0.91, 275, 100, 295, 120),
        _word('unit)', 0.93, 300, 100, 340, 120),
        _word('(1)', 0.95, 100, 140, 125, 160),  # legit option marker
    ]
    # Diagram region tokens (the garbage). All in same vertical band.
    garbage_words = [
        _word('€o', 0.55, 130, 140, 155, 160),
        _word('@', 0.40, 160, 145, 175, 165),
        _word('@)', 0.45, 180, 145, 200, 165),
        _word('+', 0.50, 205, 145, 215, 165),
        _word('&', 0.55, 220, 145, 235, 165),
        _word('"@', 0.50, 240, 145, 260, 165),
        _word('3C', 0.45, 130, 180, 155, 200),
        _word('@', 0.40, 160, 180, 175, 200),
        _word('5', 0.55, 180, 180, 195, 200),
        _word('c', 0.50, 200, 180, 215, 200),
        _word('1', 0.55, 220, 180, 235, 200),
    ]
    all_words = stem_words + garbage_words

    clean, clusters = _separate_garbage_clusters(all_words)

    # 1. Exactly one cluster should be formed.
    assert len(clusters) == 1, f'expected 1 cluster, got {len(clusters)}'

    # 2. The cluster's bbox should cover the diagram region.
    cluster = clusters[0]
    assert 130 <= cluster['x0'] <= 155, f"cluster x0={cluster['x0']} should align to diagram left"
    assert 260 <= cluster['x1'] <= 280, f"cluster x1={cluster['x1']} should align to diagram right"
    assert 140 <= cluster['y0'] <= 160
    assert 195 <= cluster['y1'] <= 205

    # 3. Real stem words and legit option marker preserved.
    clean_texts = {w['text'] for w in clean}
    for legit in ['positive', 'charge', 'is', '(in', 'SI', 'unit)', '(1)']:
        assert legit in clean_texts, f'legit token "{legit}" was wrongly dropped'

    # 4. Garbage tokens removed.
    for garbage in ['€o', '@', '@)', '+', '&', '"@', '3C', 'c']:
        assert garbage not in clean_texts, f'garbage token "{garbage}" should have been dropped'

    # 5. clean_words count = stem_words count (all garbage gone).
    assert len(clean) == len(stem_words), (
        f'expected {len(stem_words)} clean words, got {len(clean)} — '
        f'leftover: {[w["text"] for w in clean]}'
    )


def test_garbage_spaced_apart_stays_singletons():
    """Two garbage tokens 200px apart should NOT cluster — too far apart."""
    words = [
        _word('@', 0.40, 100, 100, 115, 120),
        _word('@', 0.40, 500, 100, 515, 120),  # 385px away horizontally
    ]
    clean, clusters = _separate_garbage_clusters(words)
    assert len(clusters) == 0, 'tokens too far apart should not form a cluster'
    # They're still suspects but singletons; they should remain in clean_words.
    assert len(clean) == 2


def test_min_cluster_threshold_respected():
    """With MIN_CLUSTER=2, exactly 2 adjacent suspects form a cluster."""
    assert GARBAGE_MIN_CLUSTER == 2
    words = [
        _word('@', 0.40, 100, 100, 115, 120),
        _word('@', 0.40, 130, 100, 145, 120),  # 15px away — adjacent
    ]
    clean, clusters = _separate_garbage_clusters(words)
    assert len(clusters) == 1
    assert len(clean) == 0


def test_high_conf_words_with_noise_chars_dropped_if_clustered():
    """High-conf but noise-shape tokens still cluster if adjacent."""
    # Two `@` symbols high-conf but flagged via _looks_like_noise_text.
    words = [
        _word('@', 0.95, 100, 100, 115, 120),
        _word('@', 0.95, 130, 100, 145, 120),
    ]
    clean, clusters = _separate_garbage_clusters(words)
    # _looks_like_noise_text catches them on the char rule regardless of conf.
    assert len(clusters) == 1
    assert len(clean) == 0


def test_mixed_real_text_and_garbage_partition_correctly():
    """A page with both a real text region AND a separate diagram region.

    The real region's words stay intact; the diagram region's garbage
    collapses to ONE cluster.
    """
    real_words = [
        _word('Question', 0.95, 50, 50, 110, 70),
        _word('text', 0.94, 115, 50, 145, 70),
        _word('here.', 0.96, 150, 50, 185, 70),
    ]
    # Far away on the page, the garbage cluster.
    garbage_words = [
        _word('@', 0.40, 600, 400, 615, 420),
        _word('©', 0.45, 620, 400, 635, 420),
        _word('+', 0.50, 640, 400, 650, 420),
    ]
    clean, clusters = _separate_garbage_clusters(real_words + garbage_words)
    assert len(clusters) == 1
    cluster = clusters[0]
    # Cluster should bound the diagram region only.
    assert cluster['x0'] >= 600 and cluster['x1'] <= 660
    assert cluster['y0'] >= 400 and cluster['y1'] <= 420
    # Real words preserved.
    clean_texts = {w['text'] for w in clean}
    assert clean_texts == {'Question', 'text', 'here.'}
