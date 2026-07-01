# --- build (JS) ---
FROM node:20-alpine AS build
WORKDIR /app

# OpenSSL must be present BEFORE `prisma generate` so Prisma detects OpenSSL 3.0
# and emits the linux-musl-openssl-3.0.x query engine (not the 1.1 fallback).
RUN apk add --no-cache openssl

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

COPY . .
RUN npx prisma generate
RUN npm run build

# --- runtime: Node (primary, public) + internal Python Cleanup Engine sidecar ---
# Debian slim (glibc) so the OpenCV / PyMuPDF / scikit-image wheels install — the
# musl/alpine base cannot run the CV stack. ONE image, ONE container: Node is the
# public app; Python runs privately on loopback INSIDE the same container.
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# OpenSSL for the Prisma engine + a Python runtime for the internal cleanup engine.
RUN apt-get update && apt-get install -y --no-install-recommends \
  openssl python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma

# Internal Python Cleanup Engine (private). Lean deps ALWAYS (the identity engine,
# proving the in-container wiring). The CV protect-mask stack installs only behind
# --build-arg INSTALL_CLEANUP_CV=1 — enable that ONLY after validating cleanup
# against real papers in this runtime.
#
# SCANNED OCR (RapidOCR): installs ONLY behind --build-arg FEASIBLE_RAM=true, and
# ONLY makes sense on a >=1GB instance — its onnxruntime inference peaks ~485MB, so
# on a 512MB box it would OOM (the runtime mem-guard would then abort scanned jobs).
# Build-time ARG (NOT a runtime .env) because pip runs during the image build. When
# absent, the Python side no-ops the scanned re-OCR gracefully (rapid_reocr.available()).
ARG INSTALL_CLEANUP_CV=1
ARG FEASIBLE_RAM=true
COPY ocr-cleanup ./ocr-cleanup
RUN python3 -m venv /opt/cleanup-venv \
  && /opt/cleanup-venv/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/cleanup-venv/bin/pip install --no-cache-dir -r ocr-cleanup/requirements.txt \
  && if [ "$INSTALL_CLEANUP_CV" = "1" ]; then \
  apt-get update && apt-get install -y --no-install-recommends \
  libglib2.0-0 libgl1 libsm6 libxext6 libxrender1 && \
  rm -rf /var/lib/apt/lists/* && \
  /opt/cleanup-venv/bin/pip install --no-cache-dir -r ocr-cleanup/requirements-cv.txt; \
  fi \
  && if [ "$FEASIBLE_RAM" = "true" ]; then \
  apt-get update && apt-get install -y --no-install-recommends \
  libglib2.0-0 libgl1 libsm6 libxext6 libxrender1 && \
  rm -rf /var/lib/apt/lists/* && \
  /opt/cleanup-venv/bin/pip install --no-cache-dir -r ocr-cleanup/requirements-ocr.txt; \
  fi

COPY scripts/start.sh ./scripts/start.sh
RUN chmod +x ./scripts/start.sh

EXPOSE 3000
CMD ["./scripts/start.sh"]
