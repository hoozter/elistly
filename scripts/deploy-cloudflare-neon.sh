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

echo "Setting Worker secrets..."
put_worker_secret NEON_DATABASE_URL "$NEON_DATABASE_URL"
put_worker_secret NEON_AUTH_URL "$NEON_AUTH_URL"
put_worker_secret NEON_AUTH_JWKS_URL "$NEON_AUTH_JWKS_URL"

if [[ -n "${ELISTLY_ADMIN_EMAILS:-}" ]]; then
  put_worker_secret ELISTLY_ADMIN_EMAILS "$ELISTLY_ADMIN_EMAILS"
fi

echo "Deploying Worker..."
(cd "$WORKER_DIR" && npx wrangler deploy)

if [[ -n "${PAGES_PROJECT_NAME:-}" ]]; then
  echo "Setting Pages environment values for $PAGES_PROJECT_NAME..."
  put_pages_secret ELISTLY_API_URL "$ELISTLY_API_URL" "$PAGES_PROJECT_NAME"
  put_pages_secret NEON_AUTH_URL "$NEON_AUTH_URL" "$PAGES_PROJECT_NAME"
  echo "Pages env updated. Trigger a Pages redeploy if Cloudflare does not do it automatically."
else
  echo "Skipping Pages env update because PAGES_PROJECT_NAME is not set."
  echo "Set Pages env manually: ELISTLY_API_URL and NEON_AUTH_URL."
fi

echo "Done."
