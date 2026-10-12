#!/usr/bin/env bash
# Quick-capture a task into Otter from the command line.
#   scripts/capture.sh "Call the customer about the renewal"
# Also handy for testing the endpoint the macOS Shortcut will call.
set -euo pipefail

TITLE="${*:-}"
if [ -z "$TITLE" ]; then
  echo "usage: $0 <task title>" >&2
  exit 1
fi

API_URL="${OTTER_API_URL:-http://localhost:8000}"

# Send the title as JSON (jq-free, so escape double quotes and backslashes).
ESCAPED=$(printf '%s' "$TITLE" | sed 's/\\/\\\\/g; s/"/\\"/g')
curl -sS -X POST "$API_URL/api/quick-capture" \
  -H "Content-Type: application/json" \
  -d "{\"title\": \"$ESCAPED\"}" \
  >/dev/null && echo "✓ captured: $TITLE"
