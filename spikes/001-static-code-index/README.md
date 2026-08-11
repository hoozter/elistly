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

## Verdict: INVALIDATED for adoption

The deterministic builder indexes 48 of 79 tracked files in about 0.30 seconds. Repeated builds produced byte-identical `CODEBASE_INDEX.txt` and `files.jsonl`. The first complete map was 245 KB; adding bounded lexical keywords increased it to about 291 KB. Query slices remain small at 2.3–2.8 KB each and include commit/hash freshness markers.

### Spark A/B measurements

| Task | Variant | Elapsed | Total tokens |
|---|---|---:|---:|
| Persistence | No index | 48.862 s | 1,013,158 |
| Persistence | Query slice | 45.528 s | 724,203 |
| Schema/workspaces | No index | 52.940 s | 1,270,236 |
| Schema/workspaces | Query slice | 64.925 s | 836,857 |
| Collector release surface | No index | 33.634 s | 567,972 |
| Collector release surface | Query slice | 29.793 s | 372,366 |
| **Aggregate** | **No index** | **135.437 s** | **2,851,366** |
| **Aggregate** | **Query slices** | **140.246 s** | **1,933,426** |

Query slices reduced aggregate measured tokens by **32.19%**, but aggregate elapsed time increased by **3.55%**. Index generation cost was negligible relative to model use.

### Correctness result

| Variant | Source-backed points |
|---|---:|
| Spark, no index | 22/25 |
| Spark, query slices | 20/25 |
| Advanced no-index reference | 25/25 |

Both Spark variants misread the null-revision SQL edge case: a null `expectedUpdatedAt` permits an insert but cannot overwrite an existing row. The index did not repair that semantic reasoning limit. The indexed responses were also less source-complete for preset-specific schema behavior and collector release coupling. See `CORRECTNESS.md`.

The advanced `gpt-5.6-sol` no-index reference took 144.462 seconds and 685,881 total tokens for a single batched three-task run. Its timing/token shape is not directly comparable to the three separate Spark runs; it is retained as the correctness reference.

### Recommendation

Do **not** integrate this index, add a watcher/daemon, or route complex findings to a cheaper model on its strength. The experiment demonstrated token savings but failed the required faster-development and equal-correctness gates. Preserve the spike evidence, then return project capacity to higher-value roadmap work. A future reconsideration would need a materially different hypothesis, such as a precise source-navigation CLI for advanced models—not another repetition of this cheaper-model benchmark.
