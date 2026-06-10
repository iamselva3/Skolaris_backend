"""PaddleOCR engine (HW_OCR_MODEL=paddle) — RECOMMENDED real engine.

PaddleOCR does text DETECTION + RECOGNITION in one pass (handles multi-line
pages directly), is CPU-friendly, and exposes per-line confidence. Heavy deps
(paddleocr, paddlepaddle, pdf2image, pillow) are imported lazily so the default
stub engine doesn't require them. PDF rasterization needs poppler (installed in
the Docker image).

Slice 2.3 (visual asset preservation): recognize_structured also detects
figure/diagram regions on each page via text-hole + dark-pixel scanning and
returns them as base64 PNG crops. The Node side uploads each crop to R2 and
stores the storageKey as an OcrDraftFigure row, so diagrams stop being OCR'd
into text noise and start appearing alongside the question they belong to.
"""
import base64
import os
from io import BytesIO
from typing import List, Tuple

from ..config import settings


# Slice 2.4 — garbage-cluster filter thresholds. PaddleOCR reads diagram pixels
# as low-confidence tokens (e.g. "@", "€o", "3C @ 5 c 1"). Clusters of these
# tokens that are spatially adjacent are almost certainly diagram noise rather
# than real text; we lift them out as figure crops and drop their words from
# the OCR stream so they stop leaking into question stems.
GARBAGE_CONF_THRESHOLD = float(os.environ.get("OCR_GARBAGE_CONF_THRESHOLD", "0.65"))
GARBAGE_PROXIMITY_PX = int(os.environ.get("OCR_GARBAGE_PROXIMITY_PX", "60"))
GARBAGE_MIN_CLUSTER = int(os.environ.get("OCR_GARBAGE_MIN_CLUSTER", "2"))

# Phase B (PP-Structure) — additive layout analysis. When enabled, recognize_structured
# also returns a `regions[]` array per page with typed region detections (text,
# title, list, table, figure, header, footer). Tables include extracted HTML.
# Default OFF: heavier model (~200MB), adds ~2-3x per-page latency. Node side
# consumes regions only when its own flag is also on, so this stays additive.
PP_STRUCTURE_ENABLED = os.environ.get("OCR_PP_STRUCTURE_ENABLED", "false").lower() == "true"

# Region-quality fallback thresholds. A PP-Structure region typed as TEXT or
# TITLE whose constituent words score BELOW these thresholds gets reclassified
# as FIGURE — its image crop is preserved and its words are DROPPED from the
# OCR text stream so garbage tokens like "3¢ c @ 5", "Qeoi®", "@ = @ @ oe"
# stop leaking into question stems.
REGION_MIN_QUALITY = float(os.environ.get("OCR_REGION_MIN_QUALITY", "0.55"))
REGION_MIN_ALPHA_RATIO = float(os.environ.get("OCR_REGION_MIN_ALPHA_RATIO", "0.55"))
REGION_MIN_MEAN_CONF = float(os.environ.get("OCR_REGION_MIN_MEAN_CONF", "0.70"))


def _score_region_text_quality(words_in_region: List[dict]) -> float:
    """Return 0..1 — higher = more language-like.

    Multiplicative model: `mean_conf * languageShape` where `languageShape`
    is dominated by alpha-character ratio. Physical intuition:
       "confident AND language-shaped → trust;
        either questionable → reclassify as visual content"

    An additive composite would let a high alpha-ratio mask low confidence
    (e.g. "Qeoi® 5 i CC" — mostly alphabetic but PaddleOCR's confidence is
    0.4 because it's reading a chemical structure as letters). The product
    keeps confidence as a hard ceiling: no region can score above its own
    mean confidence × ~1.0.

    The alpha-ratio is multiplied by 1.25 then capped at 1.0 — gives some
    slack for legitimate digit-heavy content like equations / formulas.
    """
    if not words_in_region:
        return 0.0
    mean_conf = sum(w.get('conf', 0.0) for w in words_in_region) / len(words_in_region)
    all_text = ''.join(w.get('text', '') for w in words_in_region)
    if not all_text:
        return 0.0
    alpha = sum(1 for c in all_text if c.isalpha())
    alpha_ratio = alpha / len(all_text)
    language_shape = 0.7 + 0.3 * min(1.0, alpha_ratio * 1.25)
    return mean_conf * language_shape


def _words_inside_region(words: List[dict], region_bbox: Tuple[float, float, float, float]) -> List[dict]:
    """Return the subset of words whose CENTER falls inside the region bbox."""
    x0, y0, x1, y1 = region_bbox
    out: List[dict] = []
    for w in words:
        cx = (w['x0'] + w['x1']) / 2.0
        cy = (w['y0'] + w['y1']) / 2.0
        if x0 <= cx <= x1 and y0 <= cy <= y1:
            out.append(w)
    return out
# Short tokens containing these characters are almost always diagram noise
# (circuit symbols, structure-formula fragments) rather than legitimate text.
_NOISE_CHARS = set('@©€¢[]{}<>~^|/\\¥§¶')


def _looks_like_noise_text(text: str) -> bool:
    """Short tokens dominated by symbol/junk chars (diagram pixels misread)."""
    s = text.strip()
    if not s:
        return True
    if len(s) <= 3 and any(c in _NOISE_CHARS for c in s):
        return True
    # Single-char tokens that are non-alphanumeric (e.g. lone "@", "©").
    if len(s) == 1 and not s.isalnum():
        return True
    return False


def _bbox_distance(a: dict, b: dict) -> float:
    """Bbox-to-bbox separation: 0 if they touch/overlap, else max(hgap, vgap)."""
    hgap = max(0.0, max(a['x0'], b['x0']) - min(a['x1'], b['x1']))
    vgap = max(0.0, max(a['y0'], b['y0']) - min(a['y1'], b['y1']))
    return max(hgap, vgap)


def _crop_region_to_figure(
    image, x0: float, y0: float, x1: float, y1: float, kind: str = 'figure', pad: int = 8
) -> dict | None:
    """Crop a page region to a figure dict with base64 PNG. Returns None if the
    region is below the minimum size after clamping (e.g. a cluster that turned
    out to be tiny). Mirrors the shape produced by _detect_figure_regions."""
    MIN_W = 80
    MIN_H = 60
    W, H = image.size
    cx0 = max(0, int(x0) - pad)
    cy0 = max(0, int(y0) - pad)
    cx1 = min(W, int(x1) + pad)
    cy1 = min(H, int(y1) + pad)
    if (cx1 - cx0) < MIN_W or (cy1 - cy0) < MIN_H:
        return None
    crop = image.crop((cx0, cy0, cx1, cy1))
    buf = BytesIO()
    crop.save(buf, format='PNG', optimize=True)
    return {
        'kind': kind,
        'x0': cx0,
        'y0': cy0,
        'x1': cx1,
        'y1': cy1,
        'imageB64': base64.b64encode(buf.getvalue()).decode('ascii'),
    }


def _separate_garbage_clusters(words: List[dict]) -> Tuple[List[dict], List[dict]]:
    """Identify clusters of low-confidence / noise-text adjacent words.

    Returns (clean_words, garbage_clusters_bboxes) where each cluster is
    `{x0, y0, x1, y1}`. Singletons are kept as clean words — a single
    low-conf token (e.g. an ε₀ that PaddleOCR mangled) is not enough signal
    to call a region a diagram. Clusters of MIN_CLUSTER+ adjacent suspects
    are the smoking gun for diagram leakage.
    """
    if not words:
        return [], []

    suspect_idxs = [
        i for i, w in enumerate(words)
        if (w.get('conf', 1.0) < GARBAGE_CONF_THRESHOLD or _looks_like_noise_text(w.get('text', '')))
    ]
    if len(suspect_idxs) < GARBAGE_MIN_CLUSTER:
        return list(words), []

    # Union-find by proximity over the suspect subset.
    parent = list(range(len(suspect_idxs)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        a, b = find(i), find(j)
        if a != b:
            parent[a] = b

    for ii in range(len(suspect_idxs)):
        for jj in range(ii + 1, len(suspect_idxs)):
            if _bbox_distance(words[suspect_idxs[ii]], words[suspect_idxs[jj]]) <= GARBAGE_PROXIMITY_PX:
                union(ii, jj)

    members_by_root: dict = {}
    for local, gi in enumerate(suspect_idxs):
        root = find(local)
        members_by_root.setdefault(root, []).append(gi)

    drop_set = set()
    clusters: List[dict] = []
    for members in members_by_root.values():
        if len(members) < GARBAGE_MIN_CLUSTER:
            continue
        member_words = [words[i] for i in members]
        x0 = min(w['x0'] for w in member_words)
        y0 = min(w['y0'] for w in member_words)
        x1 = max(w['x1'] for w in member_words)
        y1 = max(w['y1'] for w in member_words)
        clusters.append({'x0': x0, 'y0': y0, 'x1': x1, 'y1': y1})
        drop_set.update(members)

    clean_words = [w for i, w in enumerate(words) if i not in drop_set]
    return clean_words, clusters


def _detect_figure_regions(image, word_boxes: List[dict]) -> List[dict]:
    """Detect figure/diagram regions on a page via text-hole + dark-pixel scan.

    Algorithm (pure numpy, no ML deps):
      1. Build a per-row boolean mask: True where any word box covers row y.
      2. Walk rows top-to-bottom; identify vertical 'gaps' of >=MIN_GAP_PX
         non-text rows in a row.
      3. Within each gap, tighten to the bounding box of dark pixels (the
         actual figure ink — strips out white margins above/below).
      4. Reject gaps that are essentially blank (figure detector returning
         nothing is better than uploading a 600KB white square).

    Output: list of { kind, x0, y0, x1, y1, imageB64 }. kind='figure' for now
    (a future PP-Structure pass can refine to 'table'/'graph'/etc).
    """
    import numpy as np

    arr = np.array(image.convert('L'))
    H, W = arr.shape

    MIN_GAP_PX = 90               # gaps below this are paragraph spacing, not figures
    MIN_FIGURE_W = 80             # px
    MIN_FIGURE_H = 60             # px
    DARK_THRESHOLD = 200          # pixel intensity < this counts as ink
    MIN_DARK_PIXELS = 200         # below this, the region is essentially blank
    PADDING_PX = 8                # crop a few px of margin around detected ink

    # 1. Per-row text indicator (does any word box cover row y?)
    text_rows = np.zeros(H, dtype=bool)
    for box in word_boxes:
        y0 = max(0, int(box['y0']))
        y1 = min(H, int(box['y1']) + 1)
        if y0 < y1:
            text_rows[y0:y1] = True

    figures: List[dict] = []

    def _emit_region(band_y0: int, band_y1: int) -> None:
        """Crop dark-pixel bbox within [band_y0, band_y1) and emit if real."""
        if band_y1 - band_y0 < MIN_GAP_PX:
            return
        band = arr[band_y0:band_y1, :]
        dark = band < DARK_THRESHOLD
        if int(dark.sum()) < MIN_DARK_PIXELS:
            return  # essentially blank vertical band
        rows = np.any(dark, axis=1)
        cols = np.any(dark, axis=0)
        if not rows.any() or not cols.any():
            return
        yy = np.where(rows)[0]
        xx = np.where(cols)[0]
        x0 = max(0, int(xx[0]) - PADDING_PX)
        y0 = max(0, band_y0 + int(yy[0]) - PADDING_PX)
        x1 = min(W, int(xx[-1]) + 1 + PADDING_PX)
        y1 = min(H, band_y0 + int(yy[-1]) + 1 + PADDING_PX)
        if (x1 - x0) < MIN_FIGURE_W or (y1 - y0) < MIN_FIGURE_H:
            return
        crop = image.crop((x0, y0, x1, y1))
        buf = BytesIO()
        crop.save(buf, format='PNG', optimize=True)
        figures.append({
            'kind': 'figure',
            'x0': int(x0),
            'y0': int(y0),
            'x1': int(x1),
            'y1': int(y1),
            'imageB64': base64.b64encode(buf.getvalue()).decode('ascii'),
        })

    # 2. Walk rows, segment into text-free bands, emit one figure per band.
    in_gap = False
    gap_start = 0
    for y in range(H):
        if not text_rows[y]:
            if not in_gap:
                in_gap = True
                gap_start = y
        elif in_gap:
            in_gap = False
            _emit_region(gap_start, y)
    if in_gap:
        _emit_region(gap_start, H)

    return figures


# Phase B — PP-Structure region types. Initial set is exactly the 6 the Node
# side knows about; future-reserved types live in the contract so adding them
# never breaks the wire shape. Anything PP-Structure emits outside this set is
# normalized to TEXT (safe default — content is kept, just typed generically).
_PP_STRUCTURE_TYPE_MAP = {
    'text': 'TEXT',
    'title': 'TITLE',
    'list': 'TEXT',
    'table': 'TABLE',
    'figure': 'FIGURE',
    'header': 'HEADER',
    'footer': 'FOOTER',
    'equation': 'TEXT',
    'reference': 'TEXT',
}


def _pil_to_b64(img) -> str | None:
    """Crop image (PIL or numpy ndarray) → base64 PNG string. None on failure."""
    try:
        from PIL import Image
        if hasattr(img, 'save'):
            pil = img
        else:
            pil = Image.fromarray(img)
        buf = BytesIO()
        pil.save(buf, format='PNG', optimize=True)
        return base64.b64encode(buf.getvalue()).decode('ascii')
    except Exception:  # noqa: BLE001
        return None


def _word_inside_bbox(word: dict, bbox: Tuple[float, float, float, float]) -> bool:
    """True iff word's center sits inside the bbox (used for header/footer masking)."""
    cx = (word['x0'] + word['x1']) / 2.0
    cy = (word['y0'] + word['y1']) / 2.0
    return bbox[0] <= cx <= bbox[2] and bbox[1] <= cy <= bbox[3]


def _extend_bbox_with_adjacent_text(
    source_region: dict,
    page_regions: List[dict],
    proximity_px: float = 100.0,
    image_width: int | None = None,
    image_height: int | None = None,
) -> Tuple[int, int, int, int]:
    """Union the source region's bbox with adjacent non-reclassified TEXT/TITLE
    regions on the same page within `proximity_px` vertically.

    Used by the "question snapshot" pass: when a TEXT region has been
    reclassified as low-quality FIGURE, we want the visual fallback crop to
    include the surrounding stem text so reviewers see the full question, not
    just the noisy diagram cluster.

    Args:
        source_region: the reclassified region whose bbox is the starting point.
        page_regions: ALL regions on the page (the source itself is skipped).
        proximity_px: min vertical distance between bboxes to count as adjacent.
        image_width / image_height: optional clamps; when provided the returned
            bbox is clipped to [0, W] x [0, H].

    Returns: (x0, y0, x1, y1) ints — the extended (and optionally clamped) bbox.
    """
    sx0, sy0, sx1, sy1 = source_region['bbox']
    ex0, ey0, ex1, ey1 = float(sx0), float(sy0), float(sx1), float(sy1)
    for other in page_regions:
        if other is source_region:
            continue
        if other.get('type') not in ('TEXT', 'TITLE'):
            continue
        # Skip regions that were themselves reclassified — only true text
        # neighbors contribute to the question's source bbox.
        if (other.get('metadata') or {}).get('reclassifiedFrom') == 'TEXT':
            continue
        ob = other.get('bbox')
        if not ob or len(ob) != 4:
            continue
        ox0, oy0, ox1, oy1 = ob
        # Minimum vertical distance between the two y-ranges. 0 if they overlap.
        vgap = max(0.0, max(sy0, oy0) - min(sy1, oy1))
        if vgap <= proximity_px:
            ex0 = min(ex0, float(ox0))
            ey0 = min(ey0, float(oy0))
            ex1 = max(ex1, float(ox1))
            ey1 = max(ey1, float(oy1))
    if image_width is not None:
        ex0 = max(0.0, ex0)
        ex1 = min(float(image_width), ex1)
    if image_height is not None:
        ey0 = max(0.0, ey0)
        ey1 = min(float(image_height), ey1)
    return int(ex0), int(ey0), int(ex1), int(ey1)


class PaddleEngine:
    name = "paddle-hw"

    def __init__(self) -> None:
        self._ocr = None
        # Phase B — PP-Structure handle. Lazily loaded ONLY when the flag is
        # on, so the default deployment doesn't pay the ~200MB model download
        # or ~2-3x per-page latency.
        self._pp_structure = None

    def warm(self) -> None:
        if self._ocr is None:
            from paddleocr import PaddleOCR

            self._ocr = PaddleOCR(
                use_angle_cls=True,
                lang="en",
                show_log=False,
                use_gpu=(settings.device == "cuda"),
            )

    def _warm_pp_structure(self) -> bool:
        """Lazy-init PP-Structure. Returns True if it is usable, False if the
        import or model init failed. Failures are LOGGED but never raise — Phase B
        is additive; falling back to the existing pipeline must always work."""
        if self._pp_structure is not None:
            return True
        try:
            from paddleocr import PPStructure
            self._pp_structure = PPStructure(
                table=True,
                ocr=False,        # We already ran PaddleOCR; PP-Structure only does layout + tables.
                show_log=False,
                lang="en",
            )
            return True
        except Exception:  # noqa: BLE001
            import logging
            logging.getLogger("paddle-engine").exception(
                "PP-Structure unavailable; falling back to text+figures only"
            )
            self._pp_structure = None
            return False

    def _detect_pp_structure_regions(self, image, page_number: int) -> List[dict]:
        """Run PP-Structure on a page, return a list of normalized region dicts.

        Each region: {
          type: TEXT | TITLE | TABLE | FIGURE | HEADER | FOOTER,
          pageNumber: int,
          bbox: [x0, y0, x1, y1] (ints),
          confidence: float (0..1),
          content: str | None,      # for TEXT/TITLE
          tableHtml: str | None,    # for TABLE
          imageB64: str | None,     # for FIGURE/TABLE (PNG crop)
          metadata: dict,           # reserved for Phase C
        }

        Empty list on any failure — caller MUST treat regions as additive.
        """
        if not self._warm_pp_structure():
            return []
        try:
            import numpy as np
            arr = np.array(image)
            raw = self._pp_structure(arr)
        except Exception:  # noqa: BLE001
            import logging
            logging.getLogger("paddle-engine").exception(
                "PP-Structure failed for page %d", page_number
            )
            return []

        out: List[dict] = []
        for r in raw or []:
            try:
                raw_type = str(r.get('type', 'text')).lower()
                norm_type = _PP_STRUCTURE_TYPE_MAP.get(raw_type, 'TEXT')
                bbox = r.get('bbox') or [0, 0, 0, 0]
                if len(bbox) != 4:
                    continue
                x0, y0, x1, y1 = (int(v) for v in bbox)
                conf = float(r.get('confidence', 0.0))

                content: str | None = None
                table_html: str | None = None
                image_b64: str | None = None

                if norm_type == 'TABLE':
                    res = r.get('res') or {}
                    if isinstance(res, dict):
                        table_html = res.get('html')
                    image_b64 = _pil_to_b64(r.get('img'))
                elif norm_type == 'FIGURE':
                    image_b64 = _pil_to_b64(r.get('img'))
                else:
                    # TEXT/TITLE/HEADER/FOOTER carry their OCR'd content.
                    res = r.get('res')
                    if isinstance(res, list):
                        parts: List[str] = []
                        for item in res:
                            if isinstance(item, dict):
                                t = item.get('text')
                                if t:
                                    parts.append(t)
                        content = "\n".join(parts) if parts else None
                    elif isinstance(res, dict):
                        t = res.get('text')
                        content = t if isinstance(t, str) else None

                out.append({
                    'type': norm_type,
                    'pageNumber': page_number,
                    'bbox': [x0, y0, x1, y1],
                    'confidence': conf,
                    'content': content,
                    'tableHtml': table_html,
                    'imageB64': image_b64,
                    'metadata': {},
                })
            except Exception:  # noqa: BLE001
                import logging
                logging.getLogger("paddle-engine").exception(
                    "PP-Structure region parse failed (page %d)", page_number
                )
                continue
        return out

    def _pages(self, content: bytes, mime: str) -> List:
        from PIL import Image

        if mime == "application/pdf":
            from pdf2image import convert_from_bytes

            return convert_from_bytes(content, dpi=settings.pdf_dpi)
        return [Image.open(BytesIO(content)).convert("RGB")]

    def recognize(self, content: bytes, mime: str) -> Tuple[str, float, str]:
        self.warm()
        import numpy as np

        pages = self._pages(content, mime)
        lines: List[str] = []
        confs: List[float] = []
        for img in pages:
            result = self._ocr.ocr(np.array(img), cls=True)
            for block in result or []:
                for line in block or []:
                    # line == [box, (text, confidence)]
                    try:
                        text, conf = line[1][0], float(line[1][1])
                    except (IndexError, TypeError, ValueError):
                        continue
                    if text:
                        lines.append(text)
                        confs.append(conf)
            lines.append("")  # blank line == page break for the parser
        text = "\n".join(lines)
        overall = sum(confs) / len(confs) if confs else 0.0
        provider = f"paddle-hw:pdf({len(pages)}p)" if mime == "application/pdf" else "paddle-hw"
        return text, overall, provider

    def recognize_structured(self, content: bytes, mime: str):
        """Per-page output with per-word bounding boxes — Slice 2.2 path.

        PaddleOCR returns `[[ [box4pt], (text, conf) ], ...]` per page. We
        flatten each detected line into individual 'word' records (PaddleOCR
        emits line-level boxes, not word-level — close enough for the Node
        column-reorder which clusters by x-center; the parseDrafts logic on
        the Node side then splits NEET-style options inline within each line).

        Returns (pages, provider_used) matching base.HandwritingEngine.
        """
        self.warm()
        import numpy as np

        pdf_pages = self._pages(content, mime)
        pages = []
        for idx, img in enumerate(pdf_pages):
            result = self._ocr.ocr(np.array(img), cls=True)
            words = []
            line_texts = []
            line_confs = []
            for block in result or []:
                for line in block or []:
                    try:
                        box = line[0]  # 4 corner points
                        text, conf = line[1][0], float(line[1][1])
                    except (IndexError, TypeError, ValueError):
                        continue
                    if not text:
                        continue
                    # Compute axis-aligned bbox from the 4 corner points.
                    xs = [float(p[0]) for p in box]
                    ys = [float(p[1]) for p in box]
                    x0, x1 = min(xs), max(xs)
                    y0, y1 = min(ys), max(ys)
                    words.append({
                        "text": text,
                        "x0": x0,
                        "y0": y0,
                        "x1": x1,
                        "y1": y1,
                        "conf": conf,
                    })
                    line_texts.append(text)
                    line_confs.append(conf)

            # Slice 2.4 — garbage-cluster filter (BEFORE figure detection +
            # BEFORE Node sees the words). Clusters of low-confidence /
            # noise-text tokens that sit adjacent on the page are almost
            # certainly diagram pixels OCR'd as text (e.g. circuit symbols
            # producing "@", "€o", "3C @ 5 c 1"). We lift the cluster bbox
            # as a figure crop and drop those tokens from the word stream so
            # they STOP leaking into question stems.
            clean_words, garbage_bboxes = _separate_garbage_clusters(words)
            garbage_figures: List[dict] = []
            for box in garbage_bboxes:
                try:
                    fig = _crop_region_to_figure(img, box['x0'], box['y0'], box['x1'], box['y1'], kind='figure')
                except Exception:  # noqa: BLE001
                    continue
                if fig:
                    garbage_figures.append(fig)

            # Phase B — PP-Structure layout pass (additive, flag-gated). When
            # enabled, this discovers TEXT/TITLE/TABLE/FIGURE/HEADER/FOOTER
            # regions on the page. HEADER/FOOTER bboxes are used to mask their
            # words out of clean_words BEFORE rebuilding page text, so the
            # existing Node parseDrafts gets header/footer-free text WITHOUT
            # any logic change on the Node side. The regions list is also
            # surfaced to the response top-level (main.py flattens) so the
            # Node side can consume typed regions when its own flag is on.
            page_regions: List[dict] = []
            pp_figures: List[dict] = []
            if PP_STRUCTURE_ENABLED:
                page_regions = self._detect_pp_structure_regions(img, idx + 1)
                # Mask: drop words whose center sits inside any HEADER/FOOTER region.
                header_footer_bboxes = [
                    (r['bbox'][0], r['bbox'][1], r['bbox'][2], r['bbox'][3])
                    for r in page_regions
                    if r['type'] in ('HEADER', 'FOOTER')
                ]
                if header_footer_bboxes:
                    clean_words = [
                        w for w in clean_words
                        if not any(_word_inside_bbox(w, b) for b in header_footer_bboxes)
                    ]
                # Region-quality fallback — for each TEXT/TITLE region, score
                # the language quality of the words inside it. If the score
                # falls below threshold (or any individual gate fails), the
                # region is too noisy to OCR safely: reclassify as FIGURE,
                # preserve the crop, and STRIP its words from clean_words so
                # they never enter the text stream. This is what stops tokens
                # like "3¢ c @ 5" / "Qeoi®" / "@ = @ @ oe" from leaking into
                # question stems.
                reclassified_drop_bboxes: List[Tuple[float, float, float, float]] = []
                for r in page_regions:
                    if r['type'] not in ('TEXT', 'TITLE'):
                        continue
                    bbox = (r['bbox'][0], r['bbox'][1], r['bbox'][2], r['bbox'][3])
                    inside = _words_inside_region(clean_words, bbox)
                    if not inside:
                        continue
                    score = _score_region_text_quality(inside)
                    mean_conf = sum(w.get('conf', 0.0) for w in inside) / len(inside)
                    all_txt = ''.join(w.get('text', '') for w in inside)
                    alpha_ratio = (
                        sum(1 for c in all_txt if c.isalpha()) / len(all_txt)
                        if all_txt else 0.0
                    )
                    is_garbage = (
                        score < REGION_MIN_QUALITY
                        or mean_conf < REGION_MIN_MEAN_CONF
                        or alpha_ratio < REGION_MIN_ALPHA_RATIO
                    )
                    if not is_garbage:
                        continue
                    # Reclassify the region in place — Node still sees the
                    # region, just typed as FIGURE with the crop preserved
                    # for visual review. Old content is moved to metadata
                    # so reviewers can audit what was filtered.
                    cropped_b64: str | None = None
                    try:
                        cropped_b64 = _pil_to_b64(img.crop((
                            max(0, bbox[0]),
                            max(0, bbox[1]),
                            min(img.width, bbox[2]),
                            min(img.height, bbox[3]),
                        )))
                    except Exception:  # noqa: BLE001
                        cropped_b64 = None
                    r['type'] = 'FIGURE'
                    r['metadata'] = {
                        **(r.get('metadata') or {}),
                        'reclassifiedFrom': 'TEXT',
                        'qualityScore': round(score, 3),
                        'meanConfidence': round(mean_conf, 3),
                        'alphaRatio': round(alpha_ratio, 3),
                        'droppedText': (r.get('content') or '')[:200],
                    }
                    r['content'] = None
                    if cropped_b64:
                        r['imageB64'] = cropped_b64
                    reclassified_drop_bboxes.append(bbox)
                if reclassified_drop_bboxes:
                    clean_words = [
                        w for w in clean_words
                        if not any(_word_inside_bbox(w, b) for b in reclassified_drop_bboxes)
                    ]
                # Question-snapshot pass — for each reclassified-as-FIGURE TEXT
                # region, emit a NEW FIGURE region whose bbox is extended to
                # include adjacent TEXT/TITLE neighbors within 100px vertical.
                # The crop captures the full question's source area so the FE
                # can show a visual fallback when the OCR'd text is missing.
                # Snapshot only the source bbox list FIRST so we don't iterate
                # over regions we're about to append.
                snapshot_sources = [
                    r for r in page_regions
                    if (r.get('metadata') or {}).get('reclassifiedFrom') == 'TEXT'
                ]
                for r in snapshot_sources:
                    ex0, ey0, ex1, ey1 = _extend_bbox_with_adjacent_text(
                        r,
                        page_regions,
                        proximity_px=100.0,
                        image_width=img.width,
                        image_height=img.height,
                    )
                    if ex1 <= ex0 or ey1 <= ey0:
                        continue
                    snapshot_b64: str | None = None
                    try:
                        snapshot_b64 = _pil_to_b64(img.crop((ex0, ey0, ex1, ey1)))
                    except Exception:  # noqa: BLE001
                        snapshot_b64 = None
                    page_regions.append({
                        'type': 'FIGURE',
                        'pageNumber': idx + 1,
                        'bbox': [int(ex0), int(ey0), int(ex1), int(ey1)],
                        'confidence': 0.0,
                        'content': None,
                        'tableHtml': None,
                        'imageB64': snapshot_b64,
                        'metadata': {
                            'role': 'question_snapshot',
                            'sourceBbox': r['bbox'],
                            'reasonReclassified': 'low_quality_text',
                        },
                    })
                # Lift FIGURE/TABLE regions into the legacy `figures` field for
                # backward compat (existing Node consumers keep working). When
                # PP-Structure is on these REPLACE the text-hole heuristic — its
                # job is now redundant. Garbage-cluster pass stays (catches
                # symbol noise inside text bands that PP-Structure may keep
                # classifying as TEXT).
                for r in page_regions:
                    if r['type'] not in ('FIGURE', 'TABLE'):
                        continue
                    if not r.get('imageB64'):
                        continue
                    x0, y0, x1, y1 = r['bbox']
                    pp_figures.append({
                        'kind': 'table' if r['type'] == 'TABLE' else 'figure',
                        'x0': x0, 'y0': y0, 'x1': x1, 'y1': y1,
                        'imageB64': r['imageB64'],
                        # PP-Structure FIGURE kind isn't refined to chart/diagram
                        # yet — Phase C will use the dedicated reserved types
                        # (CHEM_STRUCTURE, CIRCUIT, GRAPH, etc.).
                    })

            # Rebuild per-line text from clean words ONLY (preserves order).
            clean_line_texts = [w['text'] for w in clean_words]
            clean_line_confs = [w['conf'] for w in clean_words]
            page_text = "\n".join(clean_line_texts)
            page_conf = sum(clean_line_confs) / len(clean_line_confs) if clean_line_confs else 0.0

            # Slice 2.3 text-hole pass — runs ONLY when PP-Structure is off.
            # With PP-Structure on, layout regions provide a stronger signal,
            # so the heuristic pass becomes redundant (and risks double-counting).
            if PP_STRUCTURE_ENABLED:
                text_hole_figures: List[dict] = []
            else:
                try:
                    text_hole_figures = _detect_figure_regions(img, clean_words)
                except Exception:  # noqa: BLE001 — figure detection failure must not break OCR
                    text_hole_figures = []

            # Merge figure sources. With PP-Structure on, PP-Structure figures
            # are the canonical source; garbage-cluster crops still come along
            # (they catch in-band noise that PP-Structure can miss). Without
            # PP-Structure, behavior is byte-identical to today.
            figures = garbage_figures + pp_figures + text_hole_figures

            pages.append({
                "pageNumber": idx + 1,
                "text": page_text,
                "confidence": page_conf,
                "words": clean_words,
                "figures": figures,
                "pageWidth": img.width,
                "pageHeight": img.height,
                # Phase B — typed regions for the new contract. main.py
                # flattens these into a top-level regions[] with global
                # readingOrder. Empty when the flag is off.
                "regions": page_regions,
            })
        provider = f"paddle:pdf({len(pdf_pages)}p)" if mime == "application/pdf" else "paddle"
        return pages, provider
