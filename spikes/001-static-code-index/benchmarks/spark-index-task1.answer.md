Findings (treating `spikes/001-static-code-index/artifacts/query-1.txt` as navigation hints only; source used is `99b7c6e`):

1. Entry from Settings to Device Intake is explicit:
   - Settings UI is opened via `App.showSettingsModal()`.
   - The Settings “Data” section button calls `App.showDeviceIntake()`.
   - [app.js:2837](/home/campbell/Projects/Elistly-spike-static-index/app.js#L2837), [app.js:3014](/home/campbell/Projects/Elistly-spike-static-index/app.js#L3014), [app.js:2590](/home/campbell/Projects/Elistly-spike-static-index/app.js#L2590), [app.js:2662](/home/campbell/Projects/Elistly-spike-static-index/app.js#L2662).

2. Device-intake report preview pipeline:
   - `showDeviceIntake` builds modal, file input, preview area, and disabled confirm button.
   - On file selection, `readDeviceIntakeReport` validates and parses JSON then builds a plan from current app data via `ElistlyDeviceIntake.createPlan`, and captures import identity for later session consistency check.
   - [app.js:7231](/home/campbell/Projects/Elistly-spike-static-index/app.js#L7231), [app.js:7253](/home/campbell/Projects/Elistly-spike-static-index/app.js#L7253), [app.js:7262](/home/campbell/Projects/Elistly-spike-static-index/app.js#L7262), [app.js:7271](/home/campbell/Projects/Elistly-spike-static-index/app.js#L7271), [app.js:7272](/home/campbell/Projects/Elistly-spike-static-index/app.js#L7272), [app.js:7273](/home/campbell/Projects/Elistly-spike-static-index/app.js#L7273).
   - Matching/materialization logic is pure/planned in `device-intake.js` via `createPlan` and `materializePlan`.
   - [device-intake.js:158](/home/campbell/Projects/Elistly-spike-static-index/device-intake.js#L158), [device-intake.js:202](/home/campbell/Projects/Elistly-spike-static-index/device-intake.js#L202), [tests/device-intake-core.test.js:55](/home/campbell/Projects/Elistly-spike-static-index/tests/device-intake-core.test.js#L55).

3. Confirmation path and in-memory/preview-state checks:
   - `confirmDeviceIntake` revalidates session identity if backend enabled, materializes candidate, then persists with `Storage.setAppDataForImport(candidate, identity)`.
   - Before that it snapshots `beforeData` and `beforeStorage`; on non-`remoteCommitted` errors it restores both.
   - [app.js:7345](/home/campbell/Projects/Elistly-spike-static-index/app.js#L7345), [app.js:7358](/home/campbell/Projects/Elistly-spike-static-index/app.js#L7358), [app.js:7359](/home/campbell/Projects/Elistly-spike-static-index/app.js#L7359), [app.js:7369](/home/campbell/Projects/Elistly-spike-static-index/app.js#L7369), [app.js:7657](/home/campbell/Projects/Elistly-spike-static-index/app.js#L7657), [app.js:7666](/home/campbell/Projects/Elistly-spike-static-index/app.js#L7666).

4. Revision-aware persistence contract (Worker):
   - `Storage.setAppDataForImport` sends `expectedUpdatedAt` with `identity` to `PUT /app-data`.
   - Worker route treats presence of `expectedUpdatedAt` as revision-aware; it writes only when DB `updated_at` matches (unless null), else returns `409 App data changed since preview`.
   - [app.js:183](/home/campbell/Projects/Elistly-spike-static-index/app.js#L183), [app.js:197](/home/campbell/Projects/Elistly-spike-static-index/app.js#L197), [app.js:304](/home/campbell/Projects/Elistly-spike-static-index/app.js#L304), [app.js:307](/home/campbell/Projects/Elistly-spike-static-index/app.js#L307), [worker/src/index.js:417](/home/campbell/Projects/Elistly-spike-static-index/worker/src/index.js#L417), [worker/src/index.js:429](/home/campbell/Projects/Elistly-spike-static-index/worker/src/index.js#L429), [worker/src/index.js:432](/home/campbell/Projects/Elistly-spike-static-index/worker/src/index.js#L432), [worker/test/worker-routes.spec.js:152](/home/campbell/Projects/Elistly-spike-static-index/worker/test/worker-routes.spec.js#L152), [worker/test/worker-routes.spec.js:156](/home/campbell/Projects/Elistly-spike-static-index/worker/test/worker-routes.spec.js#L156).

5. Pre-commit rollback vs post-commit local-cache failure semantics:
   - In `setAppDataForImport`, backend path sets candidate in memory/cache and verifies local cache writes; on cache verification failure it throws an error with `error.remoteCommitted = true`.
   - `confirmDeviceIntake` handles `remoteCommitted` as non-rollback: it keeps candidate state in memory and notifies a cache-sync warning.
   - Without `remoteCommitted`, it restores in-memory data + storage snapshot.
   - [app.js:320](/home/campbell/Projects/Elistly-spike-static-index/app.js#L320), [app.js:7358](/home/campbell/Projects/Elistly-spike-static-index/app.js#L7358), [app.js:7365](/home/campbell/Projects/Elistly-spike-static-index/app.js#L7365), [app.js:7369](/home/campbell/Projects/Elistly-spike-static-index/app.js#L7369).
   - Browser test coverage confirms both behaviors: rollback restores original data on thrown write error; remote-commit-with-cache-warning preserves candidate and does not claim rollback.
   - [tests/device-intake-browser.test.js:55](/home/campbell/Projects/Elistly-spike-static-index/tests/device-intake-browser.test.js#L55), [tests/device-intake-browser.test.js:64](/home/campbell/Projects/Elistly-spike-static-index/tests/device-intake-browser.test.js#L64), [tests/device-intake-browser.test.js:67](/home/campbell/Projects/Elistly-spike-static-index/tests/device-intake-browser.test.js#L67), [tests/device-intake-browser.test.js:73](/home/campbell/Projects/Elistly-spike-static-index/tests/device-intake-browser.test.js#L73).

6. Explicit uncertainty:
   - `expectedUpdatedAt` may be `null` if cache timestamp is missing; in that case the Worker still receives revision-aware payload shape but skips the DB timestamp match and behaves like a blind write. This is an edge semantics gap to confirm against product expectations.
   - Evidence: identity carries `expectedUpdatedAt` defaulting to `null`, and Worker only enforces `updated_at = expectedUpdatedAt` when value is not null.
   - [app.js:197](/home/campbell/Projects/Elistly-spike-static-index/app.js#L197), [worker/src/index.js:419](/home/campbell/Projects/Elistly-spike-static-index/worker/src/index.js#L419), [worker/src/index.js:429](/home/campbell/Projects/Elistly-spike-static-index/worker/src/index.js#L429).
