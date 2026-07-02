#!/bin/sh
set -e

# Container entrypoint: Node (primary, public) + the internal Python Cleanup Engine
# (private) in ONE container — one deploy, one log stream, one restart unit.
#
# The cleanup engine is PRIVATE: bound to loopback (127.0.0.1) only, never exposed.
# It is started in the BACKGROUND when enabled; Node is exec'd as the foreground
# process so the container's lifecycle == Node's. If uvicorn dies, Node keeps
# serving and the cleanup HTTP client circuit-breaks to the ORIGINAL bytes.
if [ "${CLEANUP_ENGINE_ENABLED}" = "true" ] && [ -x /opt/cleanup-venv/bin/uvicorn ]; then
  echo "[start] internal cleanup engine -> 127.0.0.1:${CLEANUP_PORT:-8002} (engine=${CLEANUP_ENGINE:-identity})"
  (
    cd /app/ocr-cleanup
    # Memory tuning for small containers (e.g. Render 512MB). The engine runs CV work
    # in a THREAD pool; glibc otherwise creates a malloc arena PER thread and numpy/
    # OpenCV spawn a math thread pool PER thread, inflating RSS with NO throughput gain
    # on Render's <1 vCPU. Capping both is pure runtime tuning — identical output, less
    # RAM. Override by setting these in the environment if you ever scale up CPU.
    export MALLOC_ARENA_MAX="${MALLOC_ARENA_MAX:-2}"
    export OMP_NUM_THREADS="${OMP_NUM_THREADS:-1}"
    export OPENBLAS_NUM_THREADS="${OPENBLAS_NUM_THREADS:-1}"
    export MKL_NUM_THREADS="${MKL_NUM_THREADS:-1}"
    export NUMEXPR_NUM_THREADS="${NUMEXPR_NUM_THREADS:-1}"
    exec /opt/cleanup-venv/bin/uvicorn app.main:app \
      --host 127.0.0.1 --port "${CLEANUP_PORT:-8002}"
  ) &
fi

# Migrations are applied best-effort. A failure here (e.g. a transient Neon
# advisory-lock timeout, or a lock left by a previously crashed deploy) must NOT
# block the web process from starting. If it did, the container would exit before
# binding a port -> Render reports "no open ports" and kills it -> that crash
# leaves another stuck advisory lock that fails the NEXT deploy too (crash loop).
# The schema is managed via baselined migrations, so skipping a run is safe; the
# API boots either way and a healthy DB applies pending migrations on the next try.
npx prisma migrate deploy || echo "[start] prisma migrate deploy failed (non-fatal) -- continuing to boot API"
exec node dist/main.js
