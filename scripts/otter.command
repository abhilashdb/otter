#!/usr/bin/env bash
# Double-click this file in Finder (or add it to the Dock) to launch Otter.
# It starts the full local stack and opens the app in your browser — no need to
# remember any port numbers.
set -euo pipefail
cd "$(dirname "$0")/.."

APP_URL="http://localhost:5173"

# Open the browser as soon as the frontend is actually serving.
(
  for _ in $(seq 1 60); do
    if curl -s -o /dev/null "$APP_URL"; then
      open "$APP_URL"
      break
    fi
    sleep 1
  done
) &

# Hand off to the dev script (Postgres + Electric + backend + frontend).
exec ./scripts/dev.sh
