# SKOLARIS handwriting OCR microservice.
#   Default build = lean, stub-capable (no ML stack) for contract testing.
#   Real engines: build with --build-arg INSTALL_ML=paddle (recommended) or trocr.
FROM python:3.11-slim AS base
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Optional ML stack. INSTALL_ML ∈ {none|paddle|trocr}. poppler-utils is needed
# for PDF rasterization (pdf2image) in the real engines only.
ARG INSTALL_ML=none
COPY requirements-ml.txt requirements-paddle.txt requirements-trocr.txt ./
RUN if [ "$INSTALL_ML" != "none" ]; then \
        apt-get update && apt-get install -y --no-install-recommends \
            poppler-utils \
            libgomp1 \
            libglib2.0-0 libsm6 libxext6 libxrender1 libgl1 && \
        rm -rf /var/lib/apt/lists/* && \
        pip install --no-cache-dir -r requirements-ml.txt; \
    fi
RUN if [ "$INSTALL_ML" = "paddle" ]; then pip install --no-cache-dir -r requirements-paddle.txt; fi
RUN if [ "$INSTALL_ML" = "trocr" ]; then pip install --no-cache-dir -r requirements-trocr.txt; fi

COPY app ./app

EXPOSE 8001
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
