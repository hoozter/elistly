#!/usr/bin/env python3
"""Extract final answers and token usage from retained Codex JSONL traces."""

from __future__ import annotations

import json
from pathlib import Path

ELAPSED_MS = {
    "spark-no-index-task1": 48862.062,
    "spark-index-task1": 45527.883,
    "spark-no-index-task2": 52940.421,
    "spark-index-task2": 64924.610,
    "spark-no-index-task3": 33634.189,
    "spark-index-task3": 29793.263,
}


def main() -> int:
    root = Path(__file__).resolve().parent / "benchmarks"
    results = []
    for path in sorted(root.glob("spark-*-task*.jsonl")):
        usage = {}
        answer = ""
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event.get("usage"), dict):
                usage = event["usage"]
            item = event.get("item")
            if isinstance(item, dict) and item.get("type") == "agent_message":
                answer = str(item.get("text", ""))
        stem = path.stem
        (root / f"{stem}.answer.md").write_text(answer + "\n", encoding="utf-8")
        result = {
            "run": stem,
            "elapsedMs": ELAPSED_MS[stem],
            "answerChars": len(answer),
            **usage,
        }
        result["total_tokens"] = int(result.get("input_tokens", 0)) + int(result.get("output_tokens", 0))
        results.append(result)
    (root / "metrics.json").write_text(json.dumps(results, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(results, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
