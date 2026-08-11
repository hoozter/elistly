#!/usr/bin/env python3
"""Query the deterministic spike index and return source-linked navigation hints."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


def terms(query: str) -> list[str]:
    return sorted(set(re.findall(r"[a-z0-9_.-]+", query.casefold())))


def text(value: object) -> str:
    return str(value).casefold()


def items(value: object) -> list[dict[str, object]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def item_line(item: dict[str, object]) -> int:
    value = item.get("line")
    return value if isinstance(value, int) else 0


def keyword_counts(value: object) -> dict[str, int]:
    result: dict[str, int] = {}
    if not isinstance(value, list):
        return result
    for item in value:
        if not isinstance(item, list) or len(item) != 2:
            continue
        word, count = item
        if isinstance(word, str) and isinstance(count, int):
            result[word.casefold()] = count
    return result


def record_contains(record: dict[str, object], needle: str) -> bool:
    haystacks = [text(record.get("path", ""))]
    tag_values = record.get("tags", [])
    if isinstance(tag_values, list):
        haystacks.extend(text(item) for item in tag_values)
    haystacks.extend(keyword_counts(record.get("keywords", [])).keys())
    haystacks.extend(text(item.get("name", "")) for item in items(record.get("symbols", [])))
    haystacks.extend(text(item.get("target", "")) for item in items(record.get("refs", [])))
    return any(needle in value for value in haystacks)


def score(record: dict[str, object], needles: list[str], weights: dict[str, int]) -> tuple[int, list[str]]:
    path = text(record.get("path", ""))
    tag_values = record.get("tags", [])
    tags = " ".join(text(item) for item in tag_values) if isinstance(tag_values, list) else ""
    symbols = items(record.get("symbols", []))
    refs = items(record.get("refs", []))
    keywords = keyword_counts(record.get("keywords", []))
    total = 0
    reasons: list[str] = []
    for needle in needles:
        points = 0
        if needle in path:
            points += 12
        if needle in tags:
            points += 6
        symbol_hits = sum(1 for item in symbols if needle in text(item.get("name", "")) or needle in text(item.get("kind", "")))
        ref_hits = sum(1 for item in refs if needle in text(item.get("target", "")) or needle in text(item.get("kind", "")))
        keyword_hits = sum(count for word, count in keywords.items() if needle == word)
        points += min(symbol_hits, 4) * 5 + min(ref_hits, 4) * 3 + min(keyword_hits, 8) * 4
        if points:
            weighted = points * weights[needle]
            total += weighted
            reasons.append(f"{needle}:{weighted}")
    return total, reasons


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("index", type=Path)
    parser.add_argument("query")
    parser.add_argument("--limit", type=int, default=8)
    parser.add_argument("--detail-limit", type=int, default=12)
    args = parser.parse_args()
    metadata = json.loads((args.index / "metadata.json").read_text(encoding="utf-8"))
    records = [json.loads(line) for line in (args.index / "files.jsonl").read_text(encoding="utf-8").splitlines() if line]
    needles = terms(args.query)
    weights = {
        needle: max(1, min(8, len(records) // max(1, sum(record_contains(record, needle) for record in records))))
        for needle in needles
    }
    ranked = []
    for record in records:
        points, reasons = score(record, needles, weights)
        if points:
            ranked.append((points, str(record["path"]), reasons, record))
    ranked.sort(key=lambda row: (-row[0], row[1]))
    print(f"source_commit {metadata['sourceCommit']}")
    print(f"query {args.query}")
    print(f"coverage tracked={metadata['trackedFiles']} indexed={metadata['indexedFiles']} skipped={metadata['skippedFiles']}")
    print("warning navigation hints only; inspect source before semantic claims")
    for points, path, reasons, record in ranked[: max(1, min(args.limit, 25))]:
        print(f"\nFILE {path}:{record['lines']} score={points} match={','.join(reasons)} sha256={record['sha256'][:12]}")
        details = []
        for item in items(record.get("symbols", [])):
            if any(needle in text(item.get("name", "")) or needle in text(item.get("kind", "")) for needle in needles):
                details.append((item_line(item), f"{item['kind']} {item['name']}"))
        for item in items(record.get("refs", [])):
            if any(needle in text(item.get("target", "")) or needle in text(item.get("kind", "")) for needle in needles):
                details.append((item_line(item), f"->{item['kind']} {item['target']}"))
        for line, description in sorted(details)[: max(0, min(args.detail_limit, 50))]:
            print(f"  {line:>5} {description}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
