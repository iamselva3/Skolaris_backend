# SKOLARIS Document Cleanup microservice (internal localhost sidecar).
#   Default build = lean identity pass-through (no CV stack) — proves the wiring
#   end-to-end with zero content risk.
#   Real engine: build with --build-arg INSTALL_CV=1 to add the PyMuPDF / OpenCV /
#   scikit-image protect-mask stack (only once that algorithm is validated).
FROM python:3.11-slim AS base
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

ARG INSTALL_CV=0
COPY requirements-cv.txt .
RUN if [ "$INSTALL_CV" = "1" ]; then \
        apt-get update && apt-get install -y --no-install-recommends \
            libglib2.0-0 libsm6 libxext6 libxrender1 libgl1 && \
        rm -rf /var/lib/apt/lists/* && \
        pip install --no-cache-dir -r requirements-cv.txt; \
    fi

COPY app ./app

EXPOSE 8002
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8002"]
