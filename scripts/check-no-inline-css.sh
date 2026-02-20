#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

FILES=("app.html" "app.js" "index.html" "refresh.html")
PATTERN='[[:space:]]style=["'"'"']'

failed=0
for file in "${FILES[@]}"; do
  if rg -n "$PATTERN" "$file" >/tmp/elistly-inline-style-check.out 2>/dev/null; then
    echo "Inline CSS found in $file:"
    cat /tmp/elistly-inline-style-check.out
    failed=1
  fi
done

rm -f /tmp/elistly-inline-style-check.out

if [[ "$failed" -ne 0 ]]; then
  echo "No-inline-CSS check failed."
  exit 1
fi

echo "No-inline-CSS check passed."
