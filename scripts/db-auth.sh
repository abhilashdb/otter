#!/usr/bin/env bash
# Keep Otter's Databricks workspace logins fresh.
#
# Otter mints tokens on demand from your Databricks CLI logins:
#   • LLM / FMAPI + Slack → the DATABRICKS_HOST workspace
#   • MLflow tracing       → your MLflow workspace
#   • Genie One MCP        → the GENIE_HOST workspace
# List the CLI profiles for these in .env as OTTER_DB_PROFILES="p1 p2 p3".
# All use OAuth (auth_type = databricks-cli). Access tokens auto-refresh, but the
# OAuth *session* expires periodically (your SSO policy, ~daily), which needs a
# browser re-login. This script checks each profile and re-logs-in only the ones
# whose session has lapsed. Run it whenever Otter reports an auth error, or daily.
#
#   ./scripts/db-auth.sh            # check all; re-login only the expired ones
#   ./scripts/db-auth.sh --force    # re-login all regardless
#   ./scripts/db-auth.sh p1 p2 …    # operate on specific profiles instead
set -uo pipefail

# Profile names live in .env (OTTER_DB_PROFILES), not in the repo.
if [ -z "${OTTER_DB_PROFILES:-}" ] && [ -f "$(dirname "$0")/../.env" ]; then
  OTTER_DB_PROFILES="$(sed -n 's/^OTTER_DB_PROFILES=//p' "$(dirname "$0")/../.env" | tail -1 | tr -d "\"'")"
fi

# The profiles Otter depends on (override by passing profile names as args).
read -r -a PROFILES <<<"${OTTER_DB_PROFILES:-}"
FORCE=0
args=()
for a in "$@"; do
  case "$a" in
    --force | -f) FORCE=1 ;;
    -h | --help)
      sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) args+=("$a") ;;
  esac
done
[ ${#args[@]} -gt 0 ] && PROFILES=("${args[@]}")
if [ ${#PROFILES[@]} -eq 0 ]; then
  echo "No profiles given — set OTTER_DB_PROFILES in .env or pass profile names as arguments."
  exit 1
fi

command -v databricks >/dev/null || {
  echo "✗ databricks CLI not found on PATH — install it first"
  exit 1
}

refresh_one() {
  local p="$1"
  # `databricks auth token` refreshes the access token from the stored OAuth
  # session without a browser; it only fails once the session itself expired.
  if [ "$FORCE" -eq 0 ] && databricks auth token -p "$p" >/dev/null 2>&1; then
    echo "✓ $p — session valid (access token refreshed)"
    return 0
  fi
  echo "→ $p — session expired or --force; opening browser to log in…"
  if databricks auth login -p "$p"; then
    echo "✓ $p — logged in"
  else
    echo "✗ $p — login failed"
    return 1
  fi
}

echo "Refreshing Databricks logins for: ${PROFILES[*]}"
echo
rc=0
for p in "${PROFILES[@]}"; do
  refresh_one "$p" || rc=1
  echo
done
[ $rc -eq 0 ] && echo "All set." || echo "Some profiles need attention (see above)."
exit $rc
