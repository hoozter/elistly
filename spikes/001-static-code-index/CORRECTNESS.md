# Correctness assessment

Source authority: Elistly commit `99b7c6e8399a16e9bb8169128ba1c4a33a23cbfe`.

## Task 1 — persistence and failure boundaries

Required points:

1. Settings → Data → Device Intake launch.
2. Bounded parse, side-effect-free preview, captured identity/revision.
3. Explicit collision choices before materialization.
4. Candidate materialization into the active workspace.
5. `expectedUpdatedAt` carried to `PUT /app-data`.
6. Conditional Worker upsert and HTTP 409 on stale revision.
7. Full local/in-memory restoration before remote commit.
8. `remoteCommitted` warning without rollback after a successful remote write.
9. Correct semantics when `expectedUpdatedAt` is `null`.

Both Spark variants covered points 1–8. Both incorrectly claimed that a null expected revision permits a blind overwrite or skips stale protection. The SQL condition actually makes the conflict-update branch false when the revision is null, so a missing revision permits an insert but cannot overwrite an existing row (`worker/src/index.js:422-432`). The advanced reference identified this correctly.

**Result:** Spark no-index 8/9; Spark indexed 8/9. The index reduced discovery cost but did not supply the semantic reasoning needed for the SQL edge case.

## Task 2 — schema visibility and workspace behavior

Required points:

1. Blank preset starts without target schema.
2. Existing IT preset already owns compatible categories/types/association.
3. Missing categories/types/fields/associations are additive.
4. Same-name incompatible field or association fails before mutation.
5. Existing unrelated schema is preserved.
6. Candidate is written into the active workspace only.
7. Imported fields render/edit through ordinary schema-driven UI.
8. Computer/person identity collisions require explicit choices.

The no-index Spark response covered all eight with direct preset evidence. The indexed response covered the runtime behavior but explicitly did not inspect `setup-blank.js` or `setup-it.js`; it inferred the preset distinction rather than grounding that distinction in the preset sources. The first query slice omitted both preset files. The revised lexical/IDF query now includes them, but that revision was not replayed through Spark because the benchmark forbids repeatedly probing the same task/model until the method changes materially and task 1 had already exposed a reasoning, not navigation, limit.

**Result:** Spark no-index 8/8; Spark indexed 7/8 for source completeness.

## Task 3 — collector candidate consistency

Required points:

1. PowerShell source version/schema/collectorVersion.
2. README version and launch/privacy claims.
3. Deterministic package script, filename, and exact ZIP members.
4. Tracked ZIP and SHA-256 candidate record.
5. UI download path/filename/label.
6. `app.html`/`sw.js` cache-buster coupling and cache-name consequence.
7. Parser/browser/collector/Worker/shared-persistence tests.
8. Explicit absence of automated hash/member/version/SW consistency checks and physical Windows evidence.

The no-index Spark response covered most points but did not enumerate the tracked ZIP size/hash or all shared persistence tests. The indexed response was narrower: it covered package/UI/SW basics but omitted PowerShell/README version coupling, the actual tracked ZIP/hash, and several relevant tests. The original query was polluted by generic `worker`/`cache` matches and excluded `scripts/package-windows-collector.sh` from its top eight. The revised keyword/IDF query now surfaces the package script and collector test, but the already-observed semantic limit and aggregate speed result prevent adoption without another costly loop.

**Result:** Spark no-index 6/8; Spark indexed 5/8. Advanced reference 8/8.

## Overall

| Variant | Correctness points |
|---|---:|
| Spark, no index | 22/25 |
| Spark, indexed query slices | 20/25 |
| Advanced no-index reference | 25/25 |

The static index improved navigation cost, but it did not make Spark reliable for the hardest semantic finding and reduced source completeness on two tasks. It therefore fails the stated capability-routing and equal-correctness gates.
