# 001: Deterministic static code index

## Question

Given Elistly at commit `99b7c6e`, when a bounded deterministic index of tracked text files is supplied to a cheaper coding model, does it complete repository-discovery tasks with equal correctness, lower elapsed time, and no increase in total tokens compared with normal source exploration?

## Hard boundaries

- Throwaway spike only; no production integration.
- Repository-scoped and based only on `git ls-files`.
- Exclude dependencies, build output, caches, credentials, environment files, transcripts, browser state, and binary assets.
- No network, embeddings, daemon, watcher, MCP, background semantic summaries, automatic prompt injection, or third-party package.
- Source remains authoritative. Every index result must include a source path and freshness identity.
- Generated artifacts stay in this spike directory.

## Variants

1. Advanced model, no index — correctness reference.
2. Cheaper model, no index — baseline discovery burden.
3. Same cheaper model, static index — test whether bounded navigation changes capability/cost.

## Fixed benchmark tasks

1. Trace Device Intake persistence from the Settings button through preview/confirmation to revision-aware Worker SQL, including pre-commit rollback and post-commit cache-failure semantics.
2. Explain how Device Intake makes imported computer/person fields visible in blank/custom and existing IT workspaces, including the incompatible-schema failure boundary.
3. Identify the collector-download assets and browser/service-worker references that must remain mutually consistent when producing a new collector candidate.

## Measurements

For each variant/task record:

- exact model and prompt;
- repository commit and index freshness;
- answer correctness against source-backed acceptance points;
- elapsed wall time;
- model-reported input/output/total tokens when available;
- files/commands read or searched;
- unsupported claims and missed acceptance points;
- index generation time, bytes, and refresh cost.

## Adoption gate

Adopt only if the indexed cheaper-model variant has equal correctness, lower elapsed time, and no greater **total** token use after including index generation/refresh and index text supplied to the model. Reject if stale-result recovery, generated-map size, maintenance, or unsupported confidence erases the gain.

## Status

In progress. The deterministic builder currently indexes 48 of 79 tracked files in 0.30–0.56 seconds. Repeated builds produced byte-identical `CODEBASE_INDEX.txt` and `files.jsonl` outputs. The full artifacts total 245 KB; fixed-task query slices total 8.9 KB, so only query slices—not the complete map—are eligible as model navigation context.

### Initial benchmark: task 1, Spark

| Variant | Elapsed | Input tokens | Output tokens | Total tokens |
|---|---:|---:|---:|---:|
| No index | 48.862 s | 1,004,038 | 9,120 | 1,013,158 |
| Query slice | 45.528 s | 715,032 | 9,171 | 724,203 |

The query slice reduced measured input tokens by 28.78% and elapsed time by 6.82% on the first task. This is **not yet an adoption verdict**: answer correctness still needs source-backed scoring, and tasks 2–3 plus the advanced-model reference remain to be run. Raw JSONL traces are retained under `benchmarks/`.
