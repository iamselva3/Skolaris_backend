"""Direct PaddleEngine benchmark — bypasses HTTP / storage entirely.

Mounts a PDF, calls PaddleEngine.recognize_structured() in-process, prints
metrics in the exact format requested by the Slice 2.4 validation prompt:
- Total questions
- Total figures
- Per-page word/figure counts
- First-20 stem audit with CORRUPT flag
- Validation checklist

Usage (inside the docker container):
    python scripts/_bench_neet_direct.py /pdf/input.pdf
"""
import json
import os
import re
import sys
import time

# Make `app.engines.paddle_engine` importable.
sys.path.insert(0, '/app')

from app.engines.paddle_engine import PaddleEngine  # noqa: E402


GARBAGE_PATTERNS = [
    re.compile(r'€o\b'), re.compile(r'\s@\s'), re.compile(r'\s@\)'),
    re.compile(r'\s\+\s\&\s'), re.compile(r'"@\s'), re.compile(r'\bef3C\b'),
    re.compile(r'3C @ 5 c 1'), re.compile(r'[©¥§¶]'), re.compile(r'\s@\s@\s'),
]


def looks_corrupted(text: str) -> bool:
    return any(p.search(text) for p in GARBAGE_PATTERNS)


def main():
    if len(sys.argv) != 2:
        print('usage: _bench_neet_direct.py <pdf-path>', file=sys.stderr)
        sys.exit(1)
    pdf_path = sys.argv[1]
    with open(pdf_path, 'rb') as f:
        pdf_bytes = f.read()
    print(f'[bench] loaded {len(pdf_bytes) / 1024 / 1024:.1f} MB from {pdf_path}', flush=True)

    engine = PaddleEngine()
    print('[bench] warming PaddleOCR (first run downloads models)…', flush=True)
    t_warm = time.time()
    engine.warm()
    print(f'[bench] warm-up took {time.time() - t_warm:.1f}s', flush=True)

    t0 = time.time()
    pages, provider = engine.recognize_structured(pdf_bytes, 'application/pdf')
    elapsed = time.time() - t0

    # ─── Aggregate metrics ─────────────────────────────────────────
    total_pages = len(pages)
    total_words = sum(len(p['words']) for p in pages)
    total_figures = sum(len(p['figures']) for p in pages)
    pages_with_figures = sum(1 for p in pages if len(p['figures']) > 0)
    avg_conf = sum(p['confidence'] for p in pages) / max(total_pages, 1)

    # parseDrafts equivalent is on the Node side, so we report PAGE-level
    # metrics here (a "draft" is approximately a paragraph of clean words on
    # a question page; for raw correctness we want stem-cleanliness).
    corrupted_pages = [p for p in pages if looks_corrupted(p['text'])]

    print()
    print('=' * 60)
    print('BENCHMARK METRICS  (Slice 2.4 — PaddleEngine direct)')
    print('=' * 60)
    print(f'PDF                       : {pdf_path}')
    print(f'Pages                     : {total_pages}')
    print(f'Total clean words         : {total_words}')
    print(f'Total figures             : {total_figures}')
    print(f'Pages with figure(s)      : {pages_with_figures}')
    print(f'Average page confidence   : {avg_conf * 100:.1f}%')
    print(f'Provider                  : {provider}')
    print(f'Processing time           : {elapsed:.1f}s')
    print(f'Corrupted pages (regex)   : {len(corrupted_pages)}')

    # ─── Per-page audit (first 20 pages — every page contains multiple Qs) ─
    print()
    print('=' * 60)
    print('FIRST 20 PAGES — STEM AUDIT')
    print('=' * 60)
    print(f"{'page':>4}  {'words':>5}  {'figs':>4}  {'conf':>5}  {'corrupt':>7}  stem_head")
    for p in pages[:20]:
        head = p['text'][:140].replace('\n', ' ')
        flag = 'CORRUPT' if looks_corrupted(p['text']) else ''
        print(
            f"{p['pageNumber']:>4}  "
            f"{len(p['words']):>5}  "
            f"{len(p['figures']):>4}  "
            f"{p['confidence'] * 100:>4.0f}%  "
            f"{flag:>7}  "
            f"{head}"
        )

    # ─── Page 1 detail — the specific user-flagged contamination case ──
    print()
    print('=' * 60)
    print('PAGE 1 DETAIL — "electric flux" contamination test')
    print('=' * 60)
    page1 = pages[0] if pages else None
    if page1:
        print('Full stem text:')
        print('  ' + page1['text'].replace('\n', '\n  '))
        print()
        print(f"Figures on page 1: {len(page1['figures'])}")
        for i, fig in enumerate(page1['figures']):
            b64_len = len(fig.get('imageB64', ''))
            print(
                f"  fig#{i}: bbox=({fig['x0']:.0f}, {fig['y0']:.0f}) -> "
                f"({fig['x1']:.0f}, {fig['y1']:.0f}) "
                f"size={fig['x1'] - fig['x0']:.0f}×{fig['y1'] - fig['y0']:.0f}px  "
                f"png_b64_len={b64_len}"
            )

    # ─── Validation checklist ──────────────────────────────────────
    print()
    print('=' * 60)
    print('VALIDATION CHECKLIST')
    print('=' * 60)
    checks = [
        ('Stem cleanliness (no €o/@/3C garbage)',
         len(corrupted_pages) == 0,
         f'{len(corrupted_pages)} pages corrupted' if corrupted_pages else 'no corruption detected'),
        ('Figures extracted',
         total_figures > 0,
         f'{total_figures} figures across {pages_with_figures} pages'),
        ('Average confidence ≥ 85%',
         avg_conf >= 0.85,
         f'avg={avg_conf * 100:.1f}%'),
        ('Provider is paddle (not stub)',
         provider.startswith('paddle'),
         f'provider={provider}'),
        ('Page 1 figure detected',
         page1 and len(page1['figures']) > 0,
         f"page 1 figures={len(page1['figures']) if page1 else 0}"),
        ('Page 1 stem clean of contamination',
         page1 and not looks_corrupted(page1['text']),
         'check above'),
    ]
    for label, passed, note in checks:
        sym = '✓' if passed else '✗'
        print(f'  {sym} {label:<45} {note}')

    # Persist raw output for follow-up inspection (truncating base64 to keep size sane).
    out = {
        'provider': provider,
        'elapsedSec': elapsed,
        'pages': [
            {
                'pageNumber': p['pageNumber'],
                'text': p['text'],
                'confidence': p['confidence'],
                'wordCount': len(p['words']),
                'figureCount': len(p['figures']),
                'figureBboxes': [
                    {'x0': f['x0'], 'y0': f['y0'], 'x1': f['x1'], 'y1': f['y1']}
                    for f in p['figures']
                ],
                'pageWidth': p.get('pageWidth'),
                'pageHeight': p.get('pageHeight'),
            }
            for p in pages
        ],
    }
    with open('/out/bench_result.json', 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print()
    print(f'[bench] wrote bench_result.json ({total_pages} pages)')


if __name__ == '__main__':
    main()
