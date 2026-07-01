r"""READ-ONLY probe: isolate WHERE /cleanup spends its time (fetch vs CV stack).

Runs the SAME code the sidecar runs (app.storage.fetch_object + app.cleanup.
clean_document) but standalone, so the edited cleanup.py emits its per-stage
[cleanup-timing] logs. Downloads via the Node read-proxy; never writes anything.

Usage (from repo root, venv python):
  $env:STORAGE_READ_BASE_URL='http://localhost:3000/api'; $env:AWS_S3_BUCKET='skolaris'; `
  $env:CLEANUP_ENGINE='cv'; .\ocr-cleanup\.venv\Scripts\python.exe ocr-cleanup\diag_cleanup_time.py "<storageKey>"
"""
import asyncio
import logging
import sys
import time

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")


def main() -> None:
    key = sys.argv[1] if len(sys.argv) > 1 else ""
    if not key:
        print("usage: diag_cleanup_time.py <storageKey>")
        return

    t = time.perf_counter()
    import fitz  # noqa: F401
    import numpy  # noqa: F401
    import cv2  # noqa: F401
    print(f"[probe] CV import           : {(time.perf_counter() - t) * 1000:.0f} ms  "
          f"(fitz={fitz.__doc__.splitlines()[0] if fitz.__doc__ else 'ok'}, cv2={cv2.__version__}, np={numpy.__version__})")

    from app.storage import fetch_object
    from app.cleanup import clean_document

    t = time.perf_counter()
    content, mime = asyncio.run(fetch_object(key))
    print(f"[probe] fetch_object (proxy): {(time.perf_counter() - t) * 1000:.0f} ms  "
          f"bytes={len(content) / 1024 / 1024:.2f} MB mime={mime}")

    t = time.perf_counter()
    out, changed = clean_document(content, mime, "python")
    print(f"[probe] clean_document      : {(time.perf_counter() - t) * 1000:.0f} ms  "
          f"changed={changed} in={len(content) / 1024 / 1024:.2f}MB out={len(out) / 1024 / 1024:.2f}MB")
    print(f"[probe] DONE — fetch + CV total drives the sidecar's /cleanup duration "
          f"(Node aborts it at CLEANUP_ENGINE_TIMEOUT_MS=120000).")


if __name__ == "__main__":
    main()
