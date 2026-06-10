"""Phase B — PP-Structure region pipeline validation.

Tests the pure-stdlib helpers added to paddle_engine.py for Phase B:
  - type normalization (raw PP-Structure → 6 supported types)
  - header/footer word masking
  - region dict shape

Uses no ML deps (numpy/paddleocr/PIL are lazy-imported only inside engine
methods). The integration with real PP-Structure is covered by the
benchmark script, not by these unit tests.

Usage:
    cd ocr-handwriting
    pytest tests/test_pp_structure_regions.py -v
"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.engines.paddle_engine import (  # noqa: E402
    _PP_STRUCTURE_TYPE_MAP,
    _extend_bbox_with_adjacent_text,
    _score_region_text_quality,
    _word_inside_bbox,
    _words_inside_region,
    REGION_MIN_QUALITY,
)


# ─────────────────────────────────────────────────────────────────
# Type normalization — every PP-Structure raw type maps to one of
# the 6 initial supported types (or TEXT as the safe default).
# ─────────────────────────────────────────────────────────────────

def test_supported_types_normalize_to_uppercase():
    assert _PP_STRUCTURE_TYPE_MAP['text'] == 'TEXT'
    assert _PP_STRUCTURE_TYPE_MAP['title'] == 'TITLE'
    assert _PP_STRUCTURE_TYPE_MAP['table'] == 'TABLE'
    assert _PP_STRUCTURE_TYPE_MAP['figure'] == 'FIGURE'
    assert _PP_STRUCTURE_TYPE_MAP['header'] == 'HEADER'
    assert _PP_STRUCTURE_TYPE_MAP['footer'] == 'FOOTER'


def test_list_and_equation_collapse_to_text():
    """Phase B's initial union has only 6 types — list/equation surface as
    TEXT for now so content is preserved without inventing new wire types.
    Phase C may promote them to FORMULA/OPTION."""
    assert _PP_STRUCTURE_TYPE_MAP['list'] == 'TEXT'
    assert _PP_STRUCTURE_TYPE_MAP['equation'] == 'TEXT'
    assert _PP_STRUCTURE_TYPE_MAP['reference'] == 'TEXT'


def test_no_unsupported_type_leaks():
    """All entries in the map must hit the 6 supported types — no junk values."""
    supported = {'TEXT', 'TITLE', 'TABLE', 'FIGURE', 'HEADER', 'FOOTER'}
    for raw, norm in _PP_STRUCTURE_TYPE_MAP.items():
        assert norm in supported, f"raw type {raw!r} mapped to unsupported {norm!r}"


# ─────────────────────────────────────────────────────────────────
# Header/Footer word masking — the helper that removes contamination
# from the text stream before parseDrafts sees it.
# ─────────────────────────────────────────────────────────────────

def _word(text: str, x0: float, y0: float, x1: float, y1: float) -> dict:
    return {'text': text, 'conf': 0.95, 'x0': x0, 'y0': y0, 'x1': x1, 'y1': y1}


def test_word_inside_bbox_by_center():
    bbox = (100.0, 50.0, 500.0, 100.0)  # header band
    inside = _word('CC-315', 200, 60, 260, 90)
    outside = _word('Question', 200, 200, 280, 220)
    assert _word_inside_bbox(inside, bbox) is True
    assert _word_inside_bbox(outside, bbox) is False


def test_header_mask_drops_only_header_words():
    """Real masking shape — a HEADER band at the top of the page should drop
    words whose centers fall inside it, leaving body words intact."""
    header_bbox = (0.0, 0.0, 1000.0, 80.0)
    words = [
        _word('CC-315', 100, 30, 180, 60),       # header — drop
        _word('Aakash', 400, 35, 480, 60),       # header — drop
        _word('Page', 850, 30, 900, 60),         # header — drop
        _word('Question', 50, 200, 150, 220),    # body — keep
        _word('text', 155, 200, 200, 220),       # body — keep
    ]
    masked = [w for w in words if not _word_inside_bbox(w, header_bbox)]
    kept_texts = {w['text'] for w in masked}
    assert kept_texts == {'Question', 'text'}


def test_footer_mask_drops_only_footer_words():
    footer_bbox = (0.0, 1100.0, 1000.0, 1200.0)
    words = [
        _word('Question', 50, 200, 150, 220),    # body — keep
        _word('Page', 480, 1130, 540, 1160),     # footer — drop
        _word('2/15', 550, 1130, 600, 1160),     # footer — drop
    ]
    masked = [w for w in words if not _word_inside_bbox(w, footer_bbox)]
    assert {w['text'] for w in masked} == {'Question'}


def test_multiple_header_footer_bands_mask_correctly():
    """Two bands at once — the realistic case (recurring header + page footer)."""
    bbox_header = (0.0, 0.0, 1000.0, 80.0)
    bbox_footer = (0.0, 1100.0, 1000.0, 1200.0)
    words = [
        _word('CC-315', 100, 30, 180, 60),       # header
        _word('Question', 50, 200, 150, 220),    # body
        _word('text', 155, 200, 200, 220),       # body
        _word('Page', 480, 1130, 540, 1160),     # footer
    ]
    masked = [
        w for w in words
        if not any(_word_inside_bbox(w, b) for b in (bbox_header, bbox_footer))
    ]
    assert {w['text'] for w in masked} == {'Question', 'text'}


# ─────────────────────────────────────────────────────────────────
# Region-quality scoring — the fallback that stops "3¢ c @ 5" leaks
# ─────────────────────────────────────────────────────────────────

def _wq(text: str, conf: float, x0: float, y0: float, x1: float, y1: float) -> dict:
    """Word with explicit confidence — for the quality scorer tests."""
    return {'text': text, 'conf': conf, 'x0': x0, 'y0': y0, 'x1': x1, 'y1': y1}


def test_region_quality_scores_clean_english_high():
    """Real question stem with normal confidence → score well above the gate."""
    words = [
        _wq('The', 0.96, 100, 100, 130, 120),
        _wq('equivalent', 0.95, 135, 100, 220, 120),
        _wq('capacitance', 0.94, 225, 100, 310, 120),
        _wq('of', 0.97, 315, 100, 335, 120),
        _wq('the', 0.96, 340, 100, 370, 120),
        _wq('combination', 0.93, 375, 100, 470, 120),
    ]
    score = _score_region_text_quality(words)
    assert score >= REGION_MIN_QUALITY, f'clean english scored {score:.3f}'


def test_region_quality_scores_diagram_garbage_low():
    """The exact failure tokens from the user's validation — must score below gate."""
    words = [
        _wq('3¢', 0.45, 100, 100, 120, 120),
        _wq('c', 0.40, 125, 100, 135, 120),
        _wq('@', 0.35, 140, 100, 150, 120),
        _wq('5', 0.50, 155, 100, 165, 120),
        _wq('5', 0.48, 100, 140, 110, 160),
        _wq('c', 0.42, 115, 140, 125, 160),
        _wq('1', 0.44, 130, 140, 140, 160),
    ]
    score = _score_region_text_quality(words)
    assert score < REGION_MIN_QUALITY, f'diagram garbage scored {score:.3f}'


def test_region_quality_scores_qeoi_pattern_low():
    """Single-token noise pattern ('Qeoi®') — short alphabetic but low conf."""
    words = [
        _wq('Qeoi®', 0.40, 100, 100, 150, 120),
        _wq('5', 0.45, 155, 100, 165, 120),
        _wq('i', 0.38, 170, 100, 175, 120),
        _wq('CC', 0.42, 180, 100, 200, 120),
    ]
    score = _score_region_text_quality(words)
    assert score < REGION_MIN_QUALITY


def test_region_quality_empty_input_returns_zero():
    assert _score_region_text_quality([]) == 0.0


def test_words_inside_region_partitions_by_center():
    """Words whose CENTERS fall inside the bbox are selected; edge cases excluded."""
    bbox = (100.0, 100.0, 300.0, 200.0)
    words = [
        _word('inside', 110, 110, 180, 130),       # center (145,120) → in
        _word('outside-right', 350, 110, 420, 130),  # center way past right edge
        _word('outside-top', 110, 50, 180, 70),    # above bbox
        _word('inside-edge', 280, 180, 320, 195),  # center (300,187) → on right edge → in
    ]
    inside = _words_inside_region(words, bbox)
    assert {w['text'] for w in inside} == {'inside', 'inside-edge'}


def test_region_quality_low_conf_high_alpha_still_borderline():
    """A region whose words are real English but ALL low confidence — still
    drops below the gate via the mean-conf weight. Real text gets re-OCR
    elsewhere; this is the safe-fallback behavior."""
    words = [
        _wq('the', 0.40, 100, 100, 130, 120),
        _wq('quick', 0.45, 135, 100, 180, 120),
        _wq('brown', 0.42, 185, 100, 230, 120),
        _wq('fox', 0.38, 235, 100, 260, 120),
    ]
    score = _score_region_text_quality(words)
    # NOT asserting strict pass/fail — confirming the score is meaningfully
    # below clean-english scores so the threshold can choose either side.
    assert score < 0.75


# ─────────────────────────────────────────────────────────────────
# Question-snapshot bbox extension — unions reclassified region with
# nearby TEXT/TITLE neighbors so the visual fallback crop captures
# the full question, not just the noisy diagram cluster.
# ─────────────────────────────────────────────────────────────────

def _region(
    rtype: str,
    bbox,
    *,
    reclassified: bool = False,
) -> dict:
    md = {'reclassifiedFrom': 'TEXT'} if reclassified else {}
    return {
        'type': rtype,
        'pageNumber': 1,
        'bbox': list(bbox),
        'confidence': 0.9,
        'content': None,
        'tableHtml': None,
        'imageB64': None,
        'metadata': md,
    }


def test_extend_bbox_unions_adjacent_text_above_and_below():
    """Reclassified FIGURE in the middle, TEXT stem above and TITLE below —
    both within 100px vertically — should all be unioned into the snapshot."""
    source = _region('FIGURE', (200, 300, 500, 400), reclassified=True)
    above = _region('TEXT', (100, 220, 600, 290))  # ends at y=290, source y0=300, gap=10
    below = _region('TITLE', (150, 450, 550, 500))  # starts y=450, source y1=400, gap=50
    far = _region('TEXT', (100, 700, 600, 750))  # gap = 300 → outside
    regions = [source, above, below, far]
    ex0, ey0, ex1, ey1 = _extend_bbox_with_adjacent_text(
        source, regions, proximity_px=100.0, image_width=1000, image_height=1500
    )
    # x range unions to widest of [100, 600]; y range unions to [220, 500].
    assert (ex0, ey0, ex1, ey1) == (100, 220, 600, 500)


def test_extend_bbox_no_adjacent_returns_source_bbox():
    """When no TEXT/TITLE neighbors are within 100px, the returned bbox equals
    the source region's bbox (clamped to image dims)."""
    source = _region('FIGURE', (200, 300, 500, 400), reclassified=True)
    far_above = _region('TEXT', (100, 50, 600, 150))   # gap = 150 → out
    far_below = _region('TEXT', (100, 600, 600, 700))  # gap = 200 → out
    regions = [source, far_above, far_below]
    ex0, ey0, ex1, ey1 = _extend_bbox_with_adjacent_text(
        source, regions, proximity_px=100.0, image_width=1000, image_height=1500
    )
    assert (ex0, ey0, ex1, ey1) == (200, 300, 500, 400)


def test_extend_bbox_skips_other_reclassified_regions():
    """Another reclassified region within range MUST NOT be unioned — only
    true text neighbors contribute to the question's source bbox."""
    source = _region('FIGURE', (200, 300, 500, 400), reclassified=True)
    other_reclassified = _region('FIGURE', (100, 420, 600, 480), reclassified=True)
    regions = [source, other_reclassified]
    ex0, ey0, ex1, ey1 = _extend_bbox_with_adjacent_text(
        source, regions, proximity_px=100.0, image_width=1000, image_height=1500
    )
    assert (ex0, ey0, ex1, ey1) == (200, 300, 500, 400)


def test_extend_bbox_clamps_to_image_dimensions():
    """Extended bbox must be clamped to [0, W] x [0, H] so the PIL crop call
    never receives out-of-bounds coordinates."""
    source = _region('FIGURE', (50, 50, 200, 150), reclassified=True)
    huge_neighbor = _region('TEXT', (-100, 200, 9999, 220))  # within 100px below
    regions = [source, huge_neighbor]
    ex0, ey0, ex1, ey1 = _extend_bbox_with_adjacent_text(
        source, regions, proximity_px=100.0, image_width=800, image_height=1000
    )
    assert ex0 == 0
    assert ex1 == 800
    assert ey0 == 50
    assert ey1 == 220


def test_extend_bbox_ignores_non_text_types():
    """A TABLE/HEADER/FOOTER neighbor within range MUST NOT extend the bbox —
    only TEXT and TITLE regions count as question-stem context."""
    source = _region('FIGURE', (200, 300, 500, 400), reclassified=True)
    table_nearby = _region('TABLE', (100, 420, 600, 480))
    header_nearby = _region('HEADER', (0, 250, 700, 290))
    regions = [source, table_nearby, header_nearby]
    ex0, ey0, ex1, ey1 = _extend_bbox_with_adjacent_text(
        source, regions, proximity_px=100.0, image_width=1000, image_height=1500
    )
    assert (ex0, ey0, ex1, ey1) == (200, 300, 500, 400)
