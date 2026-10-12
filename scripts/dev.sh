#!/usr/bin/env bash
# Boot the full local stack: Postgres + Electric (containers), then the FastAPI
# backend (:8000) and the Vite frontend (:5173) on the host. Ctrl-C stops all.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# Pre-flight: Otter mints tokens from your Databricks CLI logins (profiles listed
# in .env as OTTER_DB_PROFILES). Warn — but don't block — if a session has lapsed.
OTTER_DB_PROFILES="${OTTER_DB_PROFILES:-$(sed -n 's/^OTTER_DB_PROFILES=//p' .env 2>/dev/null | tail -1 | tr -d "\"'")}"
if command -v databricks >/dev/null 2>&1; then
  for p in $OTTER_DB_PROFILES; do
    databricks auth token -p "$p" >/dev/null 2>&1 ||
      echo "⚠ Databricks '$p' session expired — run ./scripts/db-auth.sh to re-login"
  done
fi

echo "▶ Starting Postgres + Electric (docker compose)…"
docker compose up -d

echo "▶ Waiting for Postgres to be healthy…"
until docker compose exec -T postgres pg_isready -U otter -d otter >/dev/null 2>&1; do
  sleep 1
done
echo "  Postgres ready."

echo "▶ Applying migrations (if any)…"
( cd backend && uv run alembic upgrade head ) 2>/dev/null || echo "  (no migrations yet — added in M1)"

cleanup() {
  echo
  echo "▶ Stopping backend + frontend (containers keep running; 'docker compose down' to stop them)…"
  kill "${BACK_PID:-}" "${FRONT_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "▶ Backend → http://localhost:8000"
( cd backend && uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 ) &
BACK_PID=$!

echo "▶ Frontend → http://localhost:5173"
( cd frontend && npm run dev ) &
FRONT_PID=$!

wait
