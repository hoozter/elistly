#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source_dir="$repo_root/collector/windows"
output_dir="$repo_root/downloads"
archive="$output_dir/Elistly-Windows-Device-Intake-v1.0.0.zip"

mkdir -p "$output_dir"
rm -f "$archive"
(cd "$source_dir" && zip -X -q "$archive" Collect-ElistlyDevice.ps1 README.txt)
sha256sum "$archive"
