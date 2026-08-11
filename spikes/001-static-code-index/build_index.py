#!/usr/bin/env python3
"""Build a small deterministic structural map of tracked repository text files."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import time
from collections import Counter
from pathlib import Path, PurePosixPath

VERSION = "0.1.0-spike"
MAX_FILE_BYTES = 512 * 1024
ALLOWED_SUFFIXES = {
    ".css", ".html", ".js", ".json", ".md", ".ps1", ".sh", ".sql",
    ".toml", ".yaml", ".yml",
}
EXCLUDED_PARTS = {
    ".git", ".hermes", ".cache", ".venv", "venv", "node_modules", "coverage",
    "dist", "build", "target", "transcripts", "browser-state",
}
EXCLUDED_NAMES = {
    ".env", ".env.local", ".env.production", "auth.json", "credentials.json",
    "secrets.json",
}
KEYWORD_STOPWORDS = {
    "async", "await", "break", "case", "catch", "class", "const", "continue",
    "default", "else", "export", "false", "finally", "for", "from", "function",
    "if", "import", "let", "new", "null", "return", "static", "switch", "this",
    "throw", "true", "try", "typeof", "undefined", "var", "while", "with",
}


def git_output(root: Path, *args: str) -> bytes:
    return subprocess.run(
        ["git", "-C", str(root), *args], check=True, stdout=subprocess.PIPE
    ).stdout


def tracked_paths(root: Path) -> list[str]:
    raw = git_output(root, "ls-files", "-z")
    return sorted(item.decode("utf-8") for item in raw.split(b"\0") if item)


def admitted(relative: str) -> bool:
    path = PurePosixPath(relative)
    lowered = {part.lower() for part in path.parts}
    if lowered & EXCLUDED_PARTS:
        return False
    name = path.name.lower()
    if name in EXCLUDED_NAMES or name.startswith(".env."):
        return False
    if any(token in name for token in ("credential", "secret", "private-key")):
        return False
    return path.suffix.lower() in ALLOWED_SUFFIXES


def line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def item_line(item: dict[str, object]) -> int:
    value = item.get("line")
    return value if isinstance(value, int) else 0


def add_matches(result: list[dict[str, object]], text: str, kind: str, pattern: str) -> None:
    for match in re.finditer(pattern, text, re.MULTILINE):
        name = next((group for group in match.groups() if group), "")
        result.append({"kind": kind, "name": name, "line": line_number(text, match.start())})


def extract_symbols(relative: str, text: str) -> list[dict[str, object]]:
    suffix = PurePosixPath(relative).suffix.lower()
    result: list[dict[str, object]] = []
    if suffix == ".js":
        add_matches(result, text, "function", r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(")
        add_matches(result, text, "class", r"^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b")
        add_matches(result, text, "binding", r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=")
        add_matches(result, text, "method", r"^\s{4,}([A-Za-z_$][\w$]*)\s*\([^\n]*\)\s*\{")
    elif suffix == ".ps1":
        add_matches(result, text, "function", r"^\s*function\s+([A-Za-z_][\w-]*)\b")
    elif suffix == ".sh":
        add_matches(result, text, "function", r"^\s*([A-Za-z_][\w]*)\s*\(\)\s*\{")
    elif suffix == ".md":
        for match in re.finditer(r"^(#{1,6})\s+(.+?)\s*$", text, re.MULTILINE):
            result.append({"kind": f"heading-{len(match.group(1))}", "name": match.group(2), "line": line_number(text, match.start())})
    elif suffix == ".sql":
        add_matches(result, text, "table", r"^\s*CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([\w.\"]+)")
    return sorted(result, key=lambda item: (item_line(item), str(item["kind"]), str(item["name"])))


def extract_refs(relative: str, text: str) -> list[dict[str, object]]:
    refs: list[dict[str, object]] = []
    patterns = [
        ("module", r"(?:import\s+.*?\s+from\s+|require\s*\()\s*['\"]([^'\"]+)['\"]"),
        ("script", r"<script[^>]+src=['\"]([^'\"]+)['\"]"),
        ("style", r"<link[^>]+href=['\"]([^'\"]+)['\"]"),
        ("worker-cache", r"['\"]([^'\"]+\.(?:js|html|css|zip)(?:\?[^'\"]*)?)['\"]"),
    ]
    for kind, pattern in patterns:
        for match in re.finditer(pattern, text, re.IGNORECASE | re.MULTILINE):
            refs.append({"kind": kind, "target": match.group(1), "line": line_number(text, match.start())})
    seen: set[tuple[str, str, int]] = set()
    unique = []
    for ref in sorted(refs, key=lambda item: (item_line(item), str(item["kind"]), str(item["target"]))):
        key = (str(ref["kind"]), str(ref["target"]), item_line(ref))
        if key not in seen:
            seen.add(key)
            unique.append(ref)
    return unique


def classify(relative: str) -> list[str]:
    name = PurePosixPath(relative).name.lower()
    tags = []
    if relative.startswith("tests/") or name.endswith((".test.js", ".spec.js")):
        tags.append("test")
    if name in {"package.json", "wrangler.toml"}:
        tags.append("manifest")
    if name in {"app.js", "worker.js", "index.js", "app.html", "index.html"}:
        tags.append("entrypoint-candidate")
    if relative.startswith("worker/"):
        tags.append("worker")
    if relative.startswith("collector/") or relative.startswith("downloads/"):
        tags.append("collector")
    return tags


def extract_keywords(text: str) -> list[list[object]]:
    counts = Counter(
        token.casefold()
        for token in re.findall(r"[A-Za-z_$][A-Za-z0-9_$-]{2,}", text)
        if token.casefold() not in KEYWORD_STOPWORDS
    )
    return [
        [token, count]
        for token, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:80]
    ]


def build(root: Path, output: Path) -> dict[str, object]:
    started = time.perf_counter()
    commit = git_output(root, "rev-parse", "HEAD").decode().strip()
    records = []
    skipped = []
    for relative in tracked_paths(root):
        if not admitted(relative):
            skipped.append(relative)
            continue
        path = root / relative
        size = path.stat().st_size
        if size > MAX_FILE_BYTES:
            skipped.append(relative)
            continue
        raw = path.read_bytes()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            skipped.append(relative)
            continue
        records.append({
            "path": relative,
            "bytes": size,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "lines": text.count("\n") + (0 if not text or text.endswith("\n") else 1),
            "suffix": path.suffix.lower(),
            "tags": classify(relative),
            "keywords": extract_keywords(text),
            "symbols": extract_symbols(relative, text),
            "refs": extract_refs(relative, text),
        })
    output.mkdir(parents=True, exist_ok=True)
    files_path = output / "files.jsonl"
    files_path.write_text("".join(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n" for record in records), encoding="utf-8")
    lines = [f"CODEBASE INDEX {VERSION}", f"source_commit {commit}", f"files {len(records)}", ""]
    for record in records:
        tags = f" [{','.join(record['tags'])}]" if record["tags"] else ""
        lines.append(f"FILE {record['path']}:{record['lines']} {record['sha256'][:12]}{tags}")
        for symbol in record["symbols"]:
            lines.append(f"  {symbol['line']:>5} {symbol['kind']} {symbol['name']}")
        for ref in record["refs"]:
            lines.append(f"  {ref['line']:>5} ->{ref['kind']} {ref['target']}")
    (output / "CODEBASE_INDEX.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
    metadata = {
        "version": VERSION,
        "sourceCommit": commit,
        "trackedFiles": len(tracked_paths(root)),
        "indexedFiles": len(records),
        "skippedFiles": len(skipped),
        "maxFileBytes": MAX_FILE_BYTES,
        "elapsedMs": elapsed_ms,
        "outputs": {
            "files.jsonl": files_path.stat().st_size,
            "CODEBASE_INDEX.txt": (output / "CODEBASE_INDEX.txt").stat().st_size,
        },
    }
    (output / "metadata.json").write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return metadata


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    print(json.dumps(build(args.root.resolve(), args.output.resolve()), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
