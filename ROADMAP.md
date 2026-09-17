# Elistly roadmap

Last updated: 2026-09-17

## Product direction: earn a hosted subscription

Build a trustworthy service worth paying for before adding billing. Elistly remains open source and self-hostable. A useful free hosted tier and paid tiers should compete on dependable operation, scale, collaboration, useful history and automation—not restricted source, lock-in, or withheld basic security. Pricing and tier limits remain undecided.

Delivery order: protect the first installed reporting device; establish verified security boundaries; prove operational reliability (including restoration and export); deliver recurring hosted value; then introduce subscriptions. Security disclosures must accurately explain protections and limitations, not substitute disclaimers for engineering.

Elistly is being built into a trustworthy managed inventory service that is worth paying for while remaining open source and self-hostable. The hosted service must earn payment through reliability, security, useful automation and reduced operational effort—not lock-in or weakened free/self-hosted editions. User-defined categories, entity types and fields remain authoritative; account data survives failure and conflict honestly; import/export stays reversible enough to trust; and optional Windows Device Intake populates the normal Add Device flow without inventing schema or people.

This roadmap names product outcomes. Design notes and historical plans are constraints and evidence, not parallel work queues.

## How to use this roadmap

- Work on the first dependency-ready source outcome below.
- Finish one user-visible or release-enabling behavior at a time through the existing authoritative data path.
- Prefer deletion, truthful disabling and reuse over a second framework, workflow or copy of schema.
- Run focused tests while implementing. Run broad browser, account, device and package acceptance only at the named integration or release gate.
- Complete source behavior before physical QA. Run an earlier real-device check only when it is needed to choose or unblock the source contract.
- Research only a named blocking product or backend decision. Record the answer, update the roadmap boundary and stop.
- Do not turn optional polish, speculative collaboration, deployment work or a broad compatibility matrix into filler when the next gate is blocked.
- Never infer or force Person assignment. Device Intake and imports may propose values only for compatible existing fields; saving remains explicit.

## Implemented foundation

- Modular categories, entity types, custom fields, associations, presets and dashboard/list/gallery views.
- Neon-authenticated Worker and Postgres storage baseline.
- Credentialed CORS restricted to configured exact origins; malformed authentication, oversized bodies, internal failures, owner/admin boundaries and destructive routes have source tests.
- Whole-document revision preconditions with explicit stale-write conflict responses.
- Durable local outbox, ordered replay, dirty-state protection and safe PWA shell activation.
- Versioned full-account backup envelope and bounded round-trip restore with validation before mutation.
- Bounded category CSV export/import with preview and authoritative save behavior.
- Advanced field/association filtering, compatible-field sorting and selected-item CSV export.
- Local first-party QR generation with bounded input and no third-party QR request.
- Source-complete Windows Device Intake draft flow: bounded local report, compatible existing fields only, explicit draft conflicts, no inferred Person, and normal Save.
- Checksummed Windows collector candidate with disclosed local-only behavior.
- Integrated selected-item deletion requires exact-count confirmation and uses the existing revision/outbox save path once. The `/` / `Ctrl+K` / `Cmd+K` search-focus shortcut remains outside editable controls and retains accessible key metadata.
- The built-in entity-type catalog is materialized for every workspace and remains visible in management while default-disabled. Presets enable catalog entries explicitly; they do not control whether entries exist or can be discovered.

## Current priorities — authorized 2026-09-17

### Now: protect the first real scheduled-reporting installation

David intends to complete the first managed computer and install scheduled device reporting on 2026-09-17. Treat the deployed installer, task identity, per-device credential, report endpoint and accepted payload as a compatibility boundary until that physical acceptance result is recorded. Verify and document the current contract before changing it. Subsequent releases must keep an installed task working or provide a deliberately tested upgrade/migration path; never silently strand an out-of-hand computer. Do not alter the reporting protocol, task schedule, credential format or device identity while this acceptance is in flight unless a proven security/correctness defect requires it. Actual Windows execution is David's acceptance step, not something Linux tests can establish.

### Next: managed-service trust and security

Security and operational trust are baseline service qualities, not paid-tier restrictions. Continue bounded work that does not disrupt the reporting acceptance:

- Verify current Neon Auth support for passkeys with user verification and/or MFA against authoritative documentation and an isolated test environment. Define strong enrollment, recovery and factor-removal behavior; never deploy an untested authentication cutover or lock David out.
- Review and harden token validation, expiry, issuer/audience rules, session revocation and sensitive-action reauthentication. Prove cross-account denial rather than trusting happy-path tests.
- Review stored-XSS/browser policy protection, local inventory/outbox retention, logout cleanup and shared-device exposure without discarding unsynced changes.
- Verify production database permissions, provider storage/backup protection, administrative account protections and hosting/data-processing facts where authorized access exists. Mark inaccessible evidence as unknown, not secure.
- Review per-device versus enrollment credential boundaries, rate/body limits, logging without secrets, recovery and audit needs. Do not broaden registration-only credentials.
- Deliver verified fixes for bounded defects and a concise remaining-risk/decision list. No claims of zero risk; no backward-compatibility branches. Preserve dirty work and real records; no destructive tests on production.

Neon Managed Auth currently does not provide the required MFA capability, and no imitation second-factor flow is authorized. A provider migration or self-hosted authentication design needs explicit review before implementation. The current database connection also cannot prove tenant isolation with RLS because the shared runtime role can forge application-supplied identity; choose a trusted identity boundary before any RLS migration.

This is an active roadmap outcome, not a reminder-only item. Use the existing portfolio coordinator for continuation rather than restoring obsolete Elistly workers. Major provider/migration decisions or required account-owner actions are escalations; lack of native Windows access does not block independent documentation, compatibility, testing or security work.

## Remaining release work

### 1. Integrated inventory candidate (complete)

- The selected-item deletion and search-shortcut source/test changes are integrated at `cdfa946`.
- Deletion captures the exact selected IDs, requires exact-count confirmation, uses the existing revision/outbox save path once, preserves unrelated data and reports persistence failure honestly.
- The search shortcut stays out of editable controls, preserves browser/platform shortcuts and retains accessible key metadata.
- Focused and broad local browser/runtime tests, syntax checks and `git diff --check` passed before the later account-capability and package commits.

### 2. Truthful account capabilities (complete in source)

- Sign-in, sign-up, email verification, session refresh and sign-out remain on the current tested Neon Auth path.
- Commit `30fef3e` introduced one source-of-truth boundary for password reset/change, email management and MFA capabilities.
- Actions the deployed adapter cannot actually complete are hidden or clearly disabled; no interactive control promises success through a “not implemented” or inferred Supabase-compatible method.
- Deterministic source/browser tests prove unsupported controls cannot promise success and supported actions preserve redirect, expiry and user-visible error behavior.
- End-to-end capability acceptance remains part of the private signed-in integration gate below; no parallel account service was added.

### 3. Complete private signed-in integration acceptance (complete)

Use a disposable/private Elistly environment and synthetic accounts; never production family or inventory data.

- Exercise sign-up, verification, sign-in, refresh and sign-out against the current Worker, Neon Auth and Postgres schema.
- Exercise the capabilities retained by milestone 2; record unsupported capabilities as visible limitations rather than simulated success.
- Verify initial load, one ordinary save, offline pending edit, reconnect replay, stale revision conflict, refresh and second-client behavior.
- Export a full backup, replace data through the validated restore preview, reload the account and compare the authoritative result.
- Exercise bounded CSV import/export and selected-item deletion through the real save lifecycle.
- Review Worker logs only for the exercised failures; do not start general observability infrastructure.

The private synthetic-account gate is complete. It exposed and drove fixes for live account persistence, hydration, restore acknowledgements and cached-client refresh. The final recreated account signs in cleanly against the deployed Worker and remains ready for use without retained acceptance inventory.

### 4. Accept Windows Device Intake (source and private integration complete)

- Review the exact source-complete candidate and integrate it without reopening the abandoned Settings import/schema/person transaction.
- In the private signed-in environment, import a synthetic report into a new compatible Computer draft, resolve a non-empty-field conflict, leave Person as None, save once and reload the account.
- On real Windows 10/11 where available, run the exact checksummed package as a standard user; check workgroup/domain context, missing CIM properties, multiple GPUs, report disclosure, no default network traffic and ordinary browser import.
- If real-machine evidence finds a defect, fix its authoritative parser, mapper, form or package source and rerun only the affected path.
- Do not add remote collection requests, directory enrichment, automatic matching, existing-device update or schema generation to this release.

The deployed private-account flow imports into the ordinary Computer draft, presents non-empty-field conflicts, keeps Person unassigned, saves once and survives reload. Physical Windows 10/11 execution remains an external gate, with the unverified surfaces recorded in `collector/windows/CANDIDATE.md`.

### 5. Release acceptance (published; external hardware evidence remains a known limitation)

The release candidate was accepted and published after explicit approval on 2026-09-01. The checks below describe the evidence retained for that release and the one hardware-specific limitation that remains disclosed rather than blocking publication.

- All Worker and browser/runtime tests pass from the release commit; syntax and repository-secret checks pass.
- A fresh private account passes the signed-in integration workflow in milestone 3.
- The exact Windows collector archive has a recorded path, version, checksum, contents and launch instructions; its physical acceptance result is attached or clearly marked unavailable.
- One real desktop browser and one real mobile browser cover sign-in, navigation, add/edit/delete, search, import preview, backup/restore, conflict messaging, reconnect replay and PWA update behavior.
- Accessibility checks cover keyboard reachability, labels, focus order and destructive confirmations for the changed flows. Do not create a synthetic visual test suite.
- README, DOCS, deployment instructions, known limitations and screenshots describe only verified behavior.
- No production deployment, data migration or release occurs without David’s explicit approval.

Release approval was given on 2026-09-01. Commit `2a5616e` is published to production and the deployed `app.js` was verified byte-for-byte against that commit. All 75 browser/runtime tests and all 6 Worker tests pass from the published source; syntax and repository whitespace checks also pass. The published collector 1.0.3 archive still matches its recorded SHA-256 and contents. Prior private signed-in acceptance covered account persistence, restore, conflict handling and Device Intake through ordinary Add Computer. Physical Windows 10/11 collector execution remains unavailable evidence and is disclosed in `collector/windows/CANDIDATE.md`; it is not represented as verified and does not block this published release.

## Stored-XSS hardening (published, 2026-09-15)

- Remaining live HTML interpolation now escapes workspace IDs/names, appearance values, profile/account values, API errors and title-component labels at the rendering boundary. Stored values and callback IDs remain literal and unchanged.
- Existing DOM-based category/type editors and export views now own their public entry points; superseded HTML implementations and unused editor helpers were removed.
- Four browser regressions reproduced active-node injection before the fix and passed afterward. The security runner runs all scenarios by default, including import/reload/click, editor/export, settings, local QR and import persistence coverage.
- The application bundle and service-worker shell versions were advanced and published. Production `app.html` requests bundle version 27; deployed `app.js` and `sw.js` match the accepted source byte-for-byte.
- Native Windows collector acceptance remains the previously disclosed external hardware gate; no additional feature work is authorized by that wait.

## Managed Windows registration deployment (source complete; not deployed)

- A workspace-bound registration secret now has no automatic expiry by default so managed deployment media does not silently stop working. An operator can instead choose a future expiry and can always revoke the secret manually.
- The `dr_` registration boundary remains additive and device-only: it can create a Computer from the machine that runs the script, but cannot read inventory, edit existing records, access account/admin routes or infer a Person assignment.
- The UI lists permanent, scheduled, expired and revoked registrations truthfully and uses the shared responsive modal behavior.
- Source/browser and Worker coverage passes for permanent and explicitly expiring registrations. Production requires the nullable-expiry schema migration, Worker and Pages changes to be deployed together under the existing release authorization process.
- Native Windows execution remains the disclosed external hardware gate. It does not block this source result and is not represented as verified.

## Unified Windows device collector (local source verified; not deployed)

- Settings → **Windows device collector → Create** now has one form and one **Save and download** action. The current workspace and optional collector name are explicit. **Keep updated automatically** defaults off: unchecked registers once; checked registers and installs reporting with weekly day/time and optional sign-in settings.
- Validation, download status, failures and destructive confirmations use product UI. The native prompt and the separate new-installation download path were removed. Browser/source regressions prohibit native JavaScript alert/confirm/prompt calls.
- Automatic enrollment explicitly creates `dc_` secrets; existing `dr_` credentials remain registration-only. An atomic registration write returns a device-bound `dp_` credential. The report endpoint, payload, task identity and existing deployed credentials remain compatible. Existing tasks are refused before enrollment and are not modified.
- Reporting management stays in the selected workspace, identifies known computers by name, shows network failures and requires confirmation before revocation. Collector revocation does not silently revoke installed reporting.
- Verified locally: browser downloads for both modes, schedule selection, validation/error/revocation flows; installer/report source checks and PowerShell parsing; synthetic collector execution; isolated PostgreSQL new/existing registration, credential scoping, revocation and revision-conflict tests; all 24 root JavaScript test files and full Worker suite (33 tests). Full gate details and RED/GREEN evidence are in `.hermes/windows-collector-unified-status.md`.
- **Not verified:** real Windows CIM/ACL/Task Scheduler installation, delivery and removal. No deployment or production-data writes occurred. Source completion does not imply physical acceptance. See [collector instructions](docs/windows-device-collector.md); the earlier deployed installation contract remains in [the handoff](docs/windows-device-reporting-handoff.md).

## Triggered work, not background work

These items remain possible, but workers must not choose them merely because a release gate awaits credentials, a device or a product decision.

- **Category movement for selected items:** start only after compatible destination semantics are chosen for modular entity types and associations.
- **More keyboard shortcuts:** the search shortcut is sufficient for now. Add quick-add, selection or navigation keys only for a demonstrated workflow problem and an existing unambiguous command.
- **Drag-to-reorder instances:** start only after a view with meaningful persistent manual order is chosen.
- **Photo/gallery behavior:** start only after an intentional image-field storage and privacy contract exists.
- **QR scanning:** start only after a cross-browser fallback and permission UX are accepted. Local QR rendering does not imply scanning.
- **Due-date notifications and install prompts:** start only after in-app versus push behavior, permission timing, duplicate suppression and offline semantics are decided.
- **Collaboration, sharing and activity logs:** blocked on an explicit ownership/permission/revision model and migration decision. Do not normalize the current whole-user document speculatively.
- **Remote Device Intake, directory enrichment and existing-device updates:** separate trust and identity decisions; not extensions of the accepted local draft workflow.
- **Additional preset/module architecture:** start only for a concrete composition or non-destructive-disable need. Do not redesign presets as background architecture work.

## Explicitly deferred physical or external gates

- Production deployment, production migration and real-user data.
- Native Windows collector acceptance when suitable hardware is unavailable.
- Mobile/native visual polish without an attachable real browser/device.
- Backend account capabilities that cannot be tested against the current Neon service.

A blocked external gate does not authorize optional feature work. Use spare capacity on another authorized project rather than broadening Elistly’s release scope.
