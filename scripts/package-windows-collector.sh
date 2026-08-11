#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source_dir="$repo_root/collector/windows"
output_dir="$repo_root/downloads"
archive="$output_dir/Elistly-Windows-Device-Intake-v1.0.2.zip"
staging=$(mktemp -d "${TMPDIR:-/tmp}/elistly-windows-collector.XXXXXX")
trap 'rm -rf "$staging"' EXIT

mkdir -p "$output_dir" "$staging/bin"
cp -p "$source_dir/README.txt" "$staging/README.txt"
cp -p "$source_dir/Start Elistly Device Collector.bat" "$staging/bin/Start Elistly Device Collector.bat"
cp -p "$source_dir/Collect-ElistlyDevice.ps1" "$staging/bin/Collect-ElistlyDevice.ps1"
cp -p "$repo_root/favicon.ico" "$staging/bin/Elistly.ico"

node "$repo_root/scripts/build-windows-shortcut.js" \
  "$staging/Elistly Device Collector.lnk" \
  'bin\Start Elistly Device Collector.bat' \
  'bin\Elistly.ico' \
  'Collect this Windows computer for Elistly'
touch -r "$source_dir/Start Elistly Device Collector.bat" "$staging/Elistly Device Collector.lnk"

rm -f "$archive"
(
  cd "$staging"
  zip -X -q "$archive" \
    'Elistly Device Collector.lnk' \
    README.txt \
    'bin/Start Elistly Device Collector.bat' \
    bin/Collect-ElistlyDevice.ps1 \
    bin/Elistly.ico
)
sha256sum "$archive"
