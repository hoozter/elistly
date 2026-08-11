Read-only reference: commit `99b7c6e8399a16e9bb8169128ba1c4a33a23cbfe`. I inspected Git objects directly, without checking out the commit. I did not inspect or use `spikes/001-static-code-index` or any generated index.

## 1. Device Intake trace

### Launch and report preview

1. The app’s Settings button opens Settings (`app.html:67-69`). In Settings → Data, “Device Intake” calls `App.showDeviceIntake()` (`app.js:2991-3017`).

2. `showDeviceIntake()` clears any prior plan, preview identity, and collision choices (`app.js:7231-7235`), then constructs the modal. It presents the local-only disclosure, links the versioned ZIP, explains execution/upload, and keeps Confirm disabled initially (`app.js:7242-7259`).

3. Selecting a file calls `readDeviceIntakeReport()` (`app.js:7252-7253`). It resets previous preview state, enforces the 256 KiB browser-side limit, parses the report, builds a plan against current application data, and captures the authenticated identity plus current remote revision before rendering (`app.js:7262-7275`).

4. Parsing independently enforces byte, depth, field, string, array, timestamp, object, schema, and stable-computer-identity constraints (`device-intake.js:8-11`, `device-intake.js:41-100`). Parsing returns a deeply frozen report (`device-intake.js:72-77`, `device-intake.js:100`).

5. `createPlan()` reads current entities, computes case-normalized computer/person candidates, and returns a frozen create/update/conflict plan plus additive schema changes (`device-intake.js:158-185`). It does not mutate the source. This is asserted byte-for-byte in `tests/device-intake-core.test.js:53-57` and in the browser at `tests/device-intake-browser.test.js:38-43`.

6. Rendering discloses every category/type/field/association addition (`app.js:7280-7297`), whether each person/computer is created, updated, or conflicted (`app.js:7299-7304`), and added/unchanged/overwritten/retained values (`app.js:7318-7335`). Confirm remains disabled until each conflict has an explicit choice (`app.js:7339-7342`).

### Confirmation and materialization

On Confirm, the app snapshots both `App.data` and all local-storage/cache state (`app.js:7345-7349`). The snapshot includes every localStorage entry and the in-memory cache owner (`app.js:7657-7664`).

For an account-backed session, it re-reads identity and rejects if the user or exact access token differs from the preview session (`app.js:7351-7357`). It then materializes a cloned candidate and persists it before assigning it to `App.data` (`app.js:7358-7360`).

Materialization:

- Clones the complete current document (`device-intake.js:202-206`).
- Applies disclosed schema additions (`device-intake.js:207-215`).
- Requires explicit conflict choices and rejects unknown choices (`device-intake.js:187-194`).
- Updates selected records or creates collision-free IDs (`device-intake.js:196-225`).
- Writes the resulting categories, types, and entities into the active workspace (`device-intake.js:226-230`).

### Revision-aware Worker persistence

At preview, `Storage.getImportIdentity()` verifies that the access-token subject, auth user, and optional session user agree, then captures the account’s cached `updated_at` as `expectedUpdatedAt` (`app.js:183-198`).

Confirmed intake sends the candidate, that expected revision, and the exact preview token to `PUT /app-data` (`app.js:304-308`).

The Worker:

- Recognizes the write as revision-aware when `expectedUpdatedAt` exists (`worker/src/index.js:411-420`).
- Performs a single upsert whose conflict update is conditional on the stored `updated_at` equalling the expected value (`worker/src/index.js:422-430`).
- Returns HTTP 409 without a row if the document changed since preview (`worker/src/index.js:432-433`).

The stale-revision response and SQL condition are tested at `worker/test/worker-routes.spec.js:142-160`.

One nuance: `expectedUpdatedAt: null` allows only the insert side. If a row already exists, its conflict update condition is false (`worker/src/index.js:424-432`). Thus a preview with no known revision cannot overwrite an existing row.

### Failure boundaries

Pre-commit failure: any identity failure, materialization failure, Worker rejection/409, or unconfirmed persistence restores the original `App.data`, all captured localStorage entries, `Storage._cached`, and its owner, then reports that original data was restored (`app.js:7361-7370`; restoration mechanics at `app.js:7666-7670`). The focused browser test verifies rollback at `tests/device-intake-browser.test.js:55-59`.

Post-commit local-cache failure: after a successful Worker response, Storage updates and verifies the generic cache, account cache, and revision timestamp (`app.js:309-318`). If that local step fails, it throws an error marked `remoteCommitted` and directs the user to reload (`app.js:319-323`). The UI retains the committed candidate in memory, does not roll it back, closes the modal, and displays the error (`app.js:7362-7367`). This is tested at `tests/device-intake-browser.test.js:61-76`.

Uncertainty: the Device Intake browser test mocks `setAppDataForImport()` for its two failure-boundary cases; the actual Worker conflict is covered separately by the Worker test. There is no single end-to-end test using a real Worker/database that spans preview, revision conflict, and rollback.

## 2. Additive schema, visibility, workspaces, and collisions

### Blank or custom workspaces

The blank preset contains no categories, types, or entities (`setup-blank.js:7-13`). Device Intake therefore plans:

- `devices` and `people` dashboard-visible categories.
- Complete `computer` and `person` types.
- Visible card fields including hostname, manufacturer, model, memory, serial number, display name, account name, and email.
- The visible `computer.assignedTo → person` association.

Definitions are at `device-intake.js:13-38`; missing categories/types are planned at `device-intake.js:130-140`.

For a custom workspace, existing unrelated schema is preserved because materialization clones the full document and only assigns missing IDs or appends missing fields/associations (`device-intake.js:202-215`).

The preview explicitly discloses these additions (`app.js:7283-7297`). After confirmation, the ordinary entity form can render the imported fields; hostname and serial visibility are browser-tested at `tests/device-intake-browser.test.js:47-52`.

### Existing IT workspace

The IT preset already owns `devices`, `people`, `computer`, and `person` (`setup-it.js:11-20`, `setup-it.js:77-99`). Therefore Device Intake does not replace those categories or types. It calculates only missing intake fields and associations (`device-intake.js:136-154`) and appends them on confirmation (`device-intake.js:208-214`).

The existing IT `assignedTo` association already targets `person` (`setup-it.js:39`), so it is structurally compatible and is retained rather than duplicated. Existing IT fields such as `computer.cpu`, `computer.ram`, `person.firstName`, and `person.lastName` likewise remain intact.

### Same-name incompatibilities and reuse

A same-name intake field fails planning if its existing `type` differs from the required type (`device-intake.js:142-147`). A same-name association fails if it is not an association or targets a different type (`device-intake.js:148-152`). Because planning happens before confirmation, these failures produce no candidate and no mutation.

However, compatibility checking is deliberately narrow:

- Existing category IDs are accepted without checking label, icon, or visibility (`device-intake.js:132-137`).
- Existing type IDs are accepted without checking type label, category, icon, or name-generation settings (`device-intake.js:137-154`).
- A same-name field with the same broad type is accepted without comparing label, required/card flags, dropdown options, or other metadata (`device-intake.js:142-147`).
- A same-name association only checks association type and target type, not association kind or presentation flags (`device-intake.js:148-152`).

Therefore “same-name failure” is not a full schema-equivalence guarantee.

### Active-workspace persistence

At load, the active workspace is projected into top-level `categories`, `entityTypes`, and `entities` (`app.js:505-517`). Device Intake plans against those top-level active values.

After materialization, the complete candidate projection is copied back only into `workspaces[currentWorkspaceId]` (`device-intake.js:226-230`). The focused test confirms that the active workspace receives the extended types (`tests/device-intake-core.test.js:70-78`). Other workspace records remain untouched in the cloned document.

### Explicit record collisions

Computer candidates are the union of:

- Manufacturer + non-placeholder serial matches.
- Hostname + Windows/domain matches.

If those identities point to different records, the result is a conflict (`device-intake.js:162-166`, `device-intake.js:172-176`).

Person candidates are the union of email, UPN, and domain/account matches; name alone is never considered (`device-intake.js:167-171`). Multiple candidates similarly become a conflict requiring an explicit record or “Create new record” choice (`device-intake.js:187-194`; UI at `app.js:7303-7315`).

The tests cover:

- Serial and hostname identifying different computers (`tests/device-intake-core.test.js:58-63`).
- Email and account identifying different people, with name-only excluded (`tests/device-intake-core.test.js:64-66`).
- Email and UPN identifying different people (`tests/device-intake-core.test.js:81-86`).
- Confirmation without a choice failing (`tests/device-intake-core.test.js:69`).
- UI Confirm remaining disabled until selection (`tests/device-intake-browser.test.js:39-46`).

New entity IDs use deterministic prefixes and increment `-2`, `-3`, etc. while an ID is occupied (`device-intake.js:196-200`, `device-intake.js:219-224`).

Uncertainty: there are no focused tests at this commit for an existing IT preset, incompatible same-name fields/associations, unusual same-ID category metadata, multiple workspaces with a non-default active workspace, or generated-ID suffix collisions. Those conclusions come directly from implementation rather than dedicated tests.

## 3. Windows collector consistency surface

For a new candidate, these files form the mutually consistent release set.

### Collector source and package

- `collector/windows/Collect-ElistlyDevice.ps1`
  - Human-visible version: line 1.
  - Report schema: line 42.
  - Embedded collector version: line 44.
  - Disclosed fields/network mode: lines 9-16 and 45.
  - Report fields: lines 41-62.
  - 256 KiB limit and UTF-8 output: lines 64-66.

- `collector/windows/README.txt`
  - Product/version heading: line 1.
  - Supported Windows/non-admin/network claims: lines 6-8.
  - Launch/UI instructions: lines 12-18.
  - Field/privacy description: lines 25-33.

- `scripts/package-windows-collector.sh`
  - Versioned output filename: line 7.
  - Exact archive members: line 11.
  - Checksum generation: line 12.

- `downloads/Elistly-Windows-Device-Intake-v1.0.0.zip`
  - Tracked candidate archive.
  - At this commit its size is 2,667 bytes and its verified SHA-256 is  
    `a0dc79865661ffd41cf358103b9f808d2fd59de3c27f1813ea56472a12d2ef05`.

- `collector/windows/CANDIDATE.md`
  - Candidate version: line 1.
  - Archive pathname: line 3.
  - Recorded checksum: line 4.
  - Expected archive contents: line 5.
  - Checksum/launch instructions: lines 7-14.
  - Outstanding physical Windows validation: line 16.

A new package must be rebuilt from the updated PowerShell and README, and the filename, archive contents, hash, and candidate record must all be updated together.

### Report contract and UI

- `device-intake.js`
  - Accepted envelope schema: lines 79-100.
  - Accepted computer/person field sets: lines 10-11.
  - Collector version persisted into computer records: lines 105-113.
  - Intake-visible schema definitions: lines 13-38.

- `app.js`
  - Download URL and `download` filename: lines 7246-7249.
  - Launch instructions: lines 7250-7251.
  - UI-displayed report collector version: line 7281.

- `WINDOWS_DEVICE_INTAKE_PLAN.md`
  - Documented schema and example collector version: lines 22-37.
  - Version migration requirement: lines 41-49.

The parser does not require collector version `1.0.0`; it accepts a cleaned string (`device-intake.js:89-100`). `tests/device-intake-core.test.js:39` explicitly accepts collector `1.9.0` with the same v1 schema. Thus a candidate-only version bump need not change the envelope schema, but a report-format change does.

### Service worker and browser asset versions

- `app.html:150-151` loads `device-intake.js?v=1` and `app.js?v=16`.
- `sw.js:3-10` defines cache `elistly-shell-v6` and caches those same URLs.
- `pwa-register.js:4-10` registers `sw.js`.

Because the download URL lives inside `app.js`, changing the candidate filename requires updating `app.js` and its cache-busting URL consistently in both `app.html` and `sw.js`, plus bumping `CACHE_NAME` so installed clients activate a fresh shell.

The ZIP itself is not in `APP_SHELL` (`sw.js:4-29`). It is downloaded from the network through the runtime cache-first handler (`sw.js:47-84`). Giving each candidate a new filename avoids an old runtime-cached ZIP being served for a reused URL.

### Tests that must remain aligned

- `tests/windows-collector.test.js:7-24`
  - Reads the source and README.
  - Checks schema, local-only behavior, prohibited commands/data, UTF-8 output, Windows/non-admin claims, policy guidance, and retention guidance.
  - It does not currently verify package contents, filename, version agreement, or checksum.

- `tests/device-intake-core.test.js:7-39`
  - Uses the report schema and collector versions.
  - Covers parser limits and allows newer collector versions under schema v1.
  - `tests/device-intake-core.test.js:42-96` covers matching, conflicts, schema additions, visibility, active-workspace materialization, and placeholder serials.

- `tests/device-intake-browser.test.js:17-52`
  - Embeds the report collector version.
  - Asserts the exact UI download filename at line 37.
  - Exercises preview, explicit conflict resolution, persistence, and ordinary-view visibility.
  - Lines 55-76 cover pre-/post-commit failure presentation.

- `worker/test/worker-routes.spec.js:142-160`
  - Must remain valid if intake persistence or its revision field changes.

- `tests/frontend-security-runtime.test.js:584-642`
  - Exercises the shared import persistence boundary: complete rollback before commit and authoritative remote state after local-cache failure. It is not collector-version-specific but protects the same Storage mechanism.

Explicit gaps/uncertainty:

- No test verifies that the ZIP hash equals `CANDIDATE.md`.
- No test inspects the ZIP member list or proves it was rebuilt from the tracked source files.
- No test asserts version agreement among PowerShell, README, package filename, candidate record, UI link, and embedded report.
- No test asserts the service-worker/app HTML cache-buster agreement or fresh-candidate delivery.
- Physical Windows 10/11 execution remains explicitly unverified (`collector/windows/CANDIDATE.md:16`).
