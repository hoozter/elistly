#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NOTES_FILE="$ROOT_DIR/neon/neon-stuff.txt"
WORKER_DIR="$ROOT_DIR/worker"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "CLOUDFLARE_API_TOKEN is not set in this shell." >&2
  exit 1
fi

if [[ ! -f "$NOTES_FILE" ]]; then
  echo "Missing $NOTES_FILE" >&2
  exit 1
fi

read_next_line_after() {
  awk -v label="$1" '$0 == label { getline; print; exit }' "$NOTES_FILE"
}

NEON_AUTH_URL="${NEON_AUTH_URL:-$(read_next_line_after "Auth URL")}"
NEON_AUTH_JWKS_URL="${NEON_AUTH_JWKS_URL:-$(read_next_line_after "JWKS URL")}"
NEON_DATABASE_URL="${NEON_DATABASE_URL:-$(read_next_line_after "Connection string")}"
ELISTLY_API_URL="${ELISTLY_API_URL:-https://elistly-api.royal-poetry-e390.workers.dev}"

if [[ -z "$NEON_AUTH_URL" || -z "$NEON_AUTH_JWKS_URL" || -z "$NEON_DATABASE_URL" ]]; then
  echo "Could not read Neon values from $NOTES_FILE" >&2
  exit 1
fi

put_worker_secret() {
  local key="$1"
  local value="$2"
  printf '%s' "$value" | (cd "$WORKER_DIR" && npx wrangler secret put "$key")
}

put_pages_secret() {
  local key="$1"
  local value="$2"
  local project="$3"
  printf '%s' "$value" | (cd "$ROOT_DIR" && npx wrangler pages secret put "$key" --project-name "$project")
}

detect_pages_project() {
  if [[ -n "${PAGES_PROJECT_NAME:-}" ]]; then
    if [[ "$PAGES_PROJECT_NAME" == "your-pages-project-name" ]]; then
      echo "PAGES_PROJECT_NAME is still the placeholder value. Leave it unset or set it to a real Cloudflare Pages project name." >&2
      return 1
    fi
    printf '%s\n' "$PAGES_PROJECT_NAME"
    return 0
  fi

  local projects
  projects="$(cd "$ROOT_DIR" && npx wrangler pages project list 2>/dev/null || true)"
  local matches
  matches="$(printf '%s\n' "$projects" | awk 'tolower($0) ~ /elistly/ { print $1 }' | sed '/^$/d' | sort -u)"
  local count
  count="$(printf '%s\n' "$matches" | sed '/^$/d' | wc -l | tr -d ' ')"

  if [[ "$count" == "1" ]]; then
    printf '%s\n' "$matches"
    return 0
  fi

  echo "Could not safely auto-detect the Cloudflare Pages project." >&2
  echo "Run this to see project names:" >&2
  echo "  npx wrangler pages project list" >&2
  echo "Then rerun with:" >&2
  echo "  PAGES_PROJECT_NAME=<real-project-name> bash scripts/deploy-cloudflare-neon.sh" >&2
  return 1
}

echo "Setting Worker secrets..."
put_worker_secret NEON_DATABASE_URL "$NEON_DATABASE_URL"
put_worker_secret NEON_AUTH_URL "$NEON_AUTH_URL"
put_worker_secret NEON_AUTH_JWKS_URL "$NEON_AUTH_JWKS_URL"

if [[ -n "${ELISTLY_ADMIN_EMAILS:-}" ]]; then
  put_worker_secret ELISTLY_ADMIN_EMAILS "$ELISTLY_ADMIN_EMAILS"
fi

echo "Deploying Worker..."
(cd "$WORKER_DIR" && npx wrangler deploy)

PAGES_PROJECT="$(detect_pages_project)"
echo "Setting Pages environment values for $PAGES_PROJECT..."
put_pages_secret ELISTLY_API_URL "$ELISTLY_API_URL" "$PAGES_PROJECT"
put_pages_secret NEON_AUTH_URL "$NEON_AUTH_URL" "$PAGES_PROJECT"
echo "Pages env updated. Trigger a Pages redeploy if Cloudflare does not do it automatically."

echo "Done."
