Here’s the traced flow with exact source points and branch semantics.

## Settings launch → Device Intake preview

1. Header settings button calls the settings modal launcher directly.  
- `app.html:67-69` (`onclick="App.showSettingsModal()"`).  
- `app.js:2837-3066` defines `showSettingsModal` and renders Settings UI.

2. Settings → Data → Device Intake opens the intake modal.  
- `app.js:3014-3017` shows the “Device Intake” button calling `App.showDeviceIntake()`.

3. `showDeviceIntake()` creates the modal (guidance + ZIP download link + file input + disabled Confirm button + preview area).  
- `app.js:7231-7259` (modal creation, file input wiring).

4. File selection enters read/plan flow (no immediate mutation of app data).  
- `app.js:7262-7273` reads file, enforces max size, parses report, builds plan, and captures import identity.  
- Parsing/planing logic is in `device-intake.js`:
  - `parseReport` validation and normalization: `device-intake.js:79-101`
  - `createPlan` conflict/match/disposition planning: `device-intake.js:158-185`
  - Side-effect safety verified in tests: `tests/device-intake-core.test.js:56` (`preview must not mutate source data`).

5. Preview rendering and confirm enablement are purely UI/state updates from the plan.  
- `app.js:7288-7334` renders schema additions and field disposition lines.  
- `app.js:7341-7343` disables Confirm only while conflict choices unresolved.

## From confirmation to revision-aware Worker persistence

6. On confirm, app captures pre-state, re-validates identity/session (account mode), materializes a candidate, then writes via import persistence helper.  
- `app.js:7346-7359` (`confirmDeviceIntake` flow).
- Candidate materialization: `device-intake.js:202-231` (`materializePlan`).

7. Revision token/session capture happens before confirm:
- `Storage.getImportIdentity()` returns `{ userId, accessToken, expectedUpdatedAt }` in account mode; it validates signed-in session identity and expiry.  
  - `app.js:183-198`.

8. `setAppDataForImport` sends revision token to Worker as `expectedUpdatedAt`.  
- `app.js:305-310` call shape includes `expectedUpdatedAt: identity.expectedUpdatedAt ?? null`.  
- Worker route applies revision-aware update:
  - `worker/src/index.js:417-433` reads `expectedUpdatedAt`, validates timestamp, and runs `ON CONFLICT ... WHERE (expectedUpdatedAt IS NOT NULL AND app_data.updated_at = expectedUpdatedAt)`; on mismatch returns `409 { error: "App data changed since preview" }`.

9. Revision-staleness test confirms this contract at HTTP boundary:  
- `worker/test/worker-routes.spec.js:142-160` expects 409 + same signature of SQL update guard.

## Pre-commit rollback vs post-commit local-cache failure

10. Pre-commit rollback: if confirm fails without `remoteCommitted`, app restores prior in-memory and local cache state from snapshot.  
- Snapshot capture: `app.js:7657-7664`  
- Restore: `app.js:7666-7670`  
- Catch branch: `app.js:7369-7371` (`beforeData`/`restoreImportStorageState` + “original data was restored” message).

11. Post-commit local-cache failure: `Storage.setAppDataForImport` treats cache write verification failure as **remoteCommitted** and throws special error; caller keeps candidate in memory and does **not** claim rollback.  
- `Storage.setAppDataForImport` throws `remoteCommitted` on cache verification failure: `app.js:319-324`.  
- Device intake catch branch handles this explicitly: `app.js:7362-7368`.  
- Browser test asserts this behavior:
  - generic write failure restores data: `tests/device-intake-browser.test.js:55-60`
  - cache-commit warning keeps committed candidate visible and does **not** claim rollback: `tests/device-intake-browser.test.js:72-77`.

## Explicit uncertainties

- `expectedUpdatedAt` can be `null` if `_readUserUpdatedAt` is empty; because SQL guard is conditional (`expectedUpdatedAt IS NOT NULL`), that case skips stale-preview protection (`worker/src/index.js:419-430`, `app.js:197`).  
- `Device Intake` does not perform a post-save revalidation of active session identity after a successful call (unlike generic import flow, which does) — that extra check is absent in `confirmDeviceIntake`’s success path (`app.js:7345-7373`, compare to `app.js:7832-7843` in generic import flow).
