# Windows device reporting — handoff contract

**Historical deployed baseline:** live frontend and route probe verified 2026-09-17. This is a supervised first-Windows-acceptance candidate, not native-Windows sign-off.

The unified collector correction is now separate, undeployed source; see [current source workflow](windows-device-collector.md). The live observations and acceptance procedure below describe the earlier two-download installation and remain evidence for its compatibility boundary. They do not describe the current dirty checkout or establish a later deployment.

## Historical decision record

At the time of this audit, the then-live split-flow installer generator was judged suitable for supervised Windows acceptance. The deployed `https://elistly.com/app.js` SHA-256 was `c59cf31d07ebc74bcf3dab94a26aa85fdbb8e7071c2bf1d6dc5ff5be3589999b`, exactly matching the local source snapshot used by that audit's parser/UI tests. It does **not** match or describe the later unified collector candidate. The configured live API URL was HTTPS, and a read-only `GET` probe of the live reporting route returned `405 Method not allowed` with `Access-Control-Allow-Origin: https://elistly.com`; this established that the deployed route was present.

Do not begin a new installation from the retired split-flow UI or issue a new `Install-ElistlyReporting.ps1` from it. New installations must use the unified collector workflow in [Windows device collector](windows-device-collector.md). The remainder of this document is retained only to accept, diagnose, or preserve an earlier installed `dp_` reporter.

This is not proof that a real Windows task has executed or that a credentialed production report can write: no credential was issued, no production inventory was sent, and no native Windows host is available in this audit. Capture the evidence in [Native Windows acceptance](#native-windows-acceptance-of-an-earlier-installed-reporter) before treating an earlier installed reporter as accepted.

## Installed-device contract

### Endpoint and transport

- The downloaded `Install-ElistlyReporting.ps1` embeds the API base URL that was configured when it was downloaded. The currently live installer embeds exactly:
  `https://elistly-api.royal-poetry-e390.workers.dev/device-reporting/report`
- The collector uses `Invoke-RestMethod` with an HTTPS URI, `POST`, a 45-second timeout, UTF-8 JSON, and `Authorization: Bearer <credential>`.
- There is no installer self-update, remote code download, execution-policy bypass, hidden window, or security-control change. The installed task executes the locally written collector only.
- Do not redirect or proxy this installed endpoint to HTTP. A release that changes the endpoint must preserve the HTTPS POST contract below for already-installed scripts.

### Credential and authorization boundary

- The installer contains one opaque `dp_…` reporting credential. It is generated from 32 random bytes, is returned once at issuance, and the service stores only its SHA-256 hash.
- A reporting credential is bound at issuance to one already-registered `device_id`, its workspace, and its owner account. It is not a browser/session/JWT credential and cannot call `/app-data` or account-authenticated routes.
- `/device-reporting/report` is handled before user/JWT authentication. This intentional separation means login MFA, login-token issuer/audience work, and normal browser sessions must not be prerequisites for an installed device report.
- The report is accepted only when the credential is active, the target device still exists at its bound workspace, and the submitted `hardwareIdentity` matches the registration. A stale snapshot is rejected; a conflicting data revision or concurrent revocation is rejected rather than overwriting data.
- Reporting credentials have **no automatic expiry**. They remain usable until the user manually revokes them (or deletes the account). `last_used_at` is recorded. This is distinct from registration scripts: registration expiry is optional and blank means no expiry.
- Treat the downloaded installer and `%ProgramData%\Elistly\Report-ElistlyDevice.ps1` as device secrets. The local directory ACL is restricted to `SYSTEM` and local Administrators; local Administrators can read the credential.

### Device identity and payload

- Hardware identity is lowercase SHA-256 of `BIOS UUID|BIOS serial number`. Generic/placeholder serials or UUIDs stop collection before a request.
- The report POST is bounded to 64 KiB. Its schema is `elistly.windows-device-registration.v1` and includes hostname; serial/manufacturer/model/Windows edition; BIOS UUID/version; Windows release/build/install and boot time; CPU and RAM; up to 32 fixed disks; up to 32 active physical adapters with bounded IP addresses; TPM, Secure Boot, BitLocker and battery availability; uptime; and one current interactive-user observation when Windows exposes it.
- It does not read browser data, documents, passwords, product keys, Wi-Fi secrets, or scan the network. Collection failures for optional Windows facilities become null/availability messages where possible.
- A successful report refreshes only the bound registration’s inventory snapshot and reporting timestamps. It preserves ordinary inventory fields such as name and assignment.

### Task, account, paths, and failure behavior

- Task name: `Elistly Inventory Report`.
- Task executable: `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -File "%ProgramData%\Elistly\Report-ElistlyDevice.ps1"`.
- Principal: `SYSTEM` (`S-1-5-18`), service-account logon, highest run level.
- Triggers: first run immediately after install; weekly Monday 09:00 local time; at user logon after one minute. Missed starts run when available. Overlapping starts are ignored.
- Limits/retry: five-minute execution limit; Task Scheduler retries a failed execution up to three times at five-minute intervals. The collector writes `%ProgramData%\Elistly\last-result.json`; a caught collector failure writes a non-secret diagnostic message and exits nonzero so Scheduler retry policy applies.
- Removal: `%ProgramData%\Elistly\Remove-ElistlyReporting.ps1` stops/unregisters only this task and removes only the three known Elistly reporting files. It does not revoke the server credential or delete historical inventory; manually revoke the reporting credential in Elistly as well.

## Mandatory future-release non-breakage gate

This is a narrow compatibility exception for reporting credentials/installers deployed today, not a general compatibility promise. Before any auth, MFA, provider, isolation/RLS, database, encryption, Worker, frontend, endpoint, or task-installer release, release owners must demonstrate all of the following against a synthetic copy of an installed-device record and credential:

1. An existing `dp_…` credential still POSTs the existing schema to the existing HTTPS path and receives the existing successful response shape (`ok`, `deviceId`, `updatedAt`), without a browser session, user JWT, MFA factor, or interactive login.
2. The credential remains constrained to its original device/workspace/owner. Wrong hardware identity, revoked credential, moved/deleted target, stale collection time, and app-data revision conflict must remain denied rather than updating another device or overwriting data.
3. The reporting token record and associations survive the change: token ID, SHA-256 verifier/hash, `owner_user_id` mapping, `workspace_id`, `device_id`, `revoked_at`, `created_at`, and `last_used_at`. A provider migration must preserve the original account/device/workspace IDs or carry an explicit, tested mapping before cutover. It must not silently invalidate or reissue installed credentials.
4. Login MFA and browser/JWT policy are tested independently. The reporting route must remain ahead of account authentication and must not inherit browser-token expiry, issuer/audience, MFA, or session-revocation requirements.
5. Any encryption design preserves an authorized server-side ability to verify the device credential and atomically replace only its bound current snapshot, or it supplies an equivalently tested reporting path. Do not deploy encryption that makes payload lookup/update opaque and silently drops, corrupts, or blocks scheduled reports.
6. The endpoint remains HTTPS and preserves CORS/transport behavior needed by the current installer. There is no remote installer update mechanism to repair endpoint or protocol changes after handoff.
7. Run the generated-installer parser test, browser download test, Worker reporting regressions, Windows runtime mock where PowerShell is available, and a native Windows acceptance run before release. Retain release evidence and a rollback path that leaves existing `dp_…` credentials usable.

A release failing any item is blocked for this deployed-device exception until an explicit, reviewed migration/remediation plan exists. Do not solve it by silently expiring or revoking the installed credential.

## Native Windows acceptance of an earlier installed reporter

Use this procedure only on a Windows computer that already has the earlier `Elistly Inventory Report` task installed. Do not issue or install the retired split-flow artifact merely to perform this acceptance. Use a normal administrator PowerShell session, and do not paste the installed script or its `dp_…` credential into chat, source control, tickets, or scanners.

1. Confirm the existing task and `%ProgramData%\Elistly\Report-ElistlyDevice.ps1` predate the unified collector workflow. If no earlier reporter is installed, stop and follow the current unified collector instructions instead.
2. Read the installed script locally. Confirm its only network endpoint is the HTTPS URL above; task name, paths, principal, triggers, retry settings, and removal behavior match this document; and it contains no `ExecutionPolicy`, `Bypass`, `DownloadString`, `Invoke-Expression`/`iex`, hidden-window behavior, or security-control change.
3. Collect local evidence (redact credentials):
   ```powershell
   Get-ScheduledTask -TaskName 'Elistly Inventory Report' | Format-List TaskName,State,Principal,Actions,Triggers,Settings
   Get-ScheduledTaskInfo -TaskName 'Elistly Inventory Report' | Format-List *
   Get-Content "$env:ProgramData\Elistly\last-result.json"
   Get-Acl "$env:ProgramData\Elistly" | Format-List Owner,AccessToString
   ```
   Record the task state/result, run timestamps, result JSON’s `success`/`completedAt`/`deviceId` (or non-secret failure message), and ACL owner/access. Do not record the collector script body or credential.
4. Refresh Elistly and verify the selected device has a fresh **Last collected facts** timestamp and expected non-secret hardware facts. This UI/API readback is required; a successful Scheduler start alone does not prove delivery.
5. Optional resilience check: while the device is offline, run the task once and verify `last-result.json` records failure and Task Scheduler schedules/reports retry behavior; then restore network and verify a later report reaches Elistly. Do not change security policy to perform this check.
6. Verify removal only when approved: run `%ProgramData%\Elistly\Remove-ElistlyReporting.ps1`, confirm only `Elistly Inventory Report` and the three known Elistly files are removed, then manually revoke the credential in Elistly. Historical inventory remains by design.

Acceptance evidence to retain: installer SHA-256 (not contents), Windows version, task principal/action/triggers/settings, task result/timestamps, redacted result JSON, ACL summary, Elistly UI readback timestamp/device ID, and any failure/retry evidence.

## Verified test evidence and current blockers

### Verified in this audit

- Historical live `app.js` exact-byte match to the local split-flow source snapshot audited that day: SHA-256 `c59cf31d07ebc74bcf3dab94a26aa85fdbb8e7071c2bf1d6dc5ff5be3589999b`. This is not the later unified collector candidate.
- Live `config.js` selected the HTTPS Worker base above. `/health` returned `200`; a read-only reporting-route `GET` returned `405` and CORS allowed `https://elistly.com`.
- `node tests/scheduled-reporting.test.js`: passed generated installer/report parser assertions.
- `node tests/scheduled-reporting-browser.test.js`: passed actual browser download with mocked issue/list/revoke API, correct selected `deviceId`, `dp_` credential, and revoke readback.
- `npm test` in `worker/`: 4 test files, 32 tests passed, including device-reporting route regressions.
- Every root JavaScript `tests/*.test.js` passed (24 files), including scheduled reporting, registration expiry, snapshot retention, collector, and secret-scan tests.

### Blockers and limits

- **No native Windows execution occurred.** Parent verification located the previously provisioned PowerShell runtime under `/home/campbell/.cache/elistly-pwsh-test/pwsh` and ran `tests/windows-registration-runtime.ps1` against the existing `/tmp/elistly-reporting-test.ps1` fixture. Parser and synthetic full/limited/SYSTEM/preview/registration execution passed. That existing fixture check does not establish freshly generated installer execution or real Windows CIM/Task Scheduler behavior; native acceptance remains required.
- Parent verification located the previously provisioned PGlite module under `/home/campbell/.cache/elistly-reporting-sql-test/node_modules/@electric-sql/pglite/dist/index.js` and ran `tests/reporting-sql-integration.mjs` successfully: actual PostgreSQL-engine schema, credential issuance, report write/readback, manual-field retention, stale rejection, account isolation and revoke/readback. These are isolated tests, not production RLS or live credentialed reporting proof. No installation or production mutation was required.
- A successful credentialed production report was deliberately not attempted: it would issue a real secret and write real inventory. The live route probe confirms route presence, not a production end-to-end write.
- Existing auth issuer/audience source hardening is not deployed because authoritative provider claim values are still unavailable; current deployed Worker secret evidence lacks those bindings. This must remain separate from reporting: do not make installed reporting depend on the pending browser-auth change.
- Neon Managed Auth MFA is unavailable according to the current provider roadmap, and RLS/isolation design remains unresolved. Neither is a reason to alter the independent reporting credential contract without satisfying the release gate.

## Historical corrections requested for integration

At the time of the audit, no installation-blocking source correction was identified in the then-live split-flow generator. That judgment is preserved only as historical evidence; it is not authorization to create a new split-flow installation after the unified collector superseded it. The non-breakage gate above remains required for any future auth/MFA/provider/isolation/encryption deployment affecting an earlier installed reporter.

The later source candidate added a focused unit assertion that `buildDeviceReportingInstaller` rejects a non-HTTPS API base URL. That hardens the preserved reporting contract; it does not make the retired split-flow installation UI current again.
