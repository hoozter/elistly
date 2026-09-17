# Elistly Deploy Notes

## Backend

Elistly now uses Neon:

- Neon Auth for signup/login.
- Neon Postgres for app data.
- Cloudflare Worker for API access to Neon Postgres.

## Windows device collector deployment and physical acceptance

The active source candidate uses one unified flow. In the active inventory, select the target workspace, then open **Settings → Windows device collector → Create**. Optionally name the download and choose a future collector-secret expiry; blank remains usable until revoked. Choose **Save and download** to download `Collect-ElistlyDevice.ps1`.

- Leave **Keep updated automatically** unchecked to register the computer once. Run the downloaded script in PowerShell on that computer with its workspace-bound secret. Nothing is scheduled or installed.
- Check it to register and install reporting in one run. Choose the weekly day/time and optional sign-in trigger (defaults: Monday 09:00 and after sign-in), then run `Collect-ElistlyDevice.ps1` in administrator PowerShell under normal execution policy. The script starts reporting immediately, catches up missed runs, retries failed runs up to three times five minutes apart, and refuses an existing installed reporter rather than replacing it.

After an automatic installation, inspect **Manage installed reporting** and **Last collected facts** in Elistly. On Windows, verify `Get-ScheduledTaskInfo -TaskName 'Elistly Inventory Report'` and `Get-Content "$env:ProgramData\Elistly\last-result.json"`. A successful download, registration, install, or task start alone is not proof of delivery. To stop reporting, revoke the reporting credential in Elistly; to remove local reporting, run `%ProgramData%\Elistly\Remove-ElistlyReporting.ps1` in administrator PowerShell. Neither action deletes inventory.

The collector secret is workspace-scoped enrollment authority. Protect it, do not place it in a public image/script/history, and delete the target download after use. The installed reporter retains only its device-bound `dp_` credential; it cannot read inventory or edit manual fields. Local administrators can read the protected local reporter files. See [the collector instructions](docs/windows-device-collector.md) for bounded collection, failure handling, removal, and the outstanding native-Windows acceptance.

## Historical installed-reporting baseline (compatibility runbook)

This section applies only to a computer that already has the earlier installed `dp_` reporting task. It is not the current source candidate UI or installation flow, and it must not be used to create new installations. The protected endpoint, payload, device identity, credential, task name **Elistly Inventory Report**, SYSTEM identity, schedule, paths, retry behavior, and removal behavior remain documented in [the historical handoff](docs/windows-device-reporting-handoff.md). Follow that handoff for supervised acceptance or incident recovery of an existing installed task; do not alter the task or redirect its endpoint.

## Windows device collector deployment

For deployment tooling, create the collector once and store its secret in the deployment system’s secret store. Invoke the downloaded `Collect-ElistlyDevice.ps1` with `-RegistrationToken <secret>`; do not put that value in a public script, image, repository, or command history. A blank expiry is deliberate; use a future expiry only when the deployment window requires it. Protect any ISO containing a registration secret; anyone holding it can register devices into its bound inventory.

Test first on a non-production Windows computer: run `./Collect-ElistlyDevice.ps1 -Preview` and inspect the complete locally emitted JSON. Preview makes no network request. Then run `./Collect-ElistlyDevice.ps1 -RegistrationToken <secret>` once to register. The script has no scheduler, persistence, updater, policy bypass, or security-setting changes unless automatic reporting was explicitly selected; its scheduled reporter follows the unified flow above. It collects only bounded local facts; adapter collection is limited to local physical adapters and their local IPv4/IPv6 addresses (no network scan). Optional unsupported or denied queries remain `null` and carry an `availability` explanation. `lastInteractiveUser` is only a current `Win32_ComputerSystem.UserName` observation with its collection timestamp; it is not logon history. The POST body is explicitly UTF-8 and rejected locally if it exceeds 64 KB.

The registration endpoint accepts no inventory-reading, editing, profile, or administrative operations. It creates a Computer record only, uses BIOS UUID plus BIOS serial to detect a repeat install, and rejects a collision with an existing manually-created Computer rather than changing it. Person assignment is never inferred.

Before first use, apply the current `neon/schema.sql`, deploy the Worker and Pages together, then create a fresh registration script from the deployed app. Test the PSD step against a non-production computer first.

## Frontend Config

For local development, copy `config.example.js` to `config.js` and set:

- `ELISTLY_API_URL`
- `NEON_AUTH_URL`

For Cloudflare Pages, set the same variables in Pages environment variables. The build command `node scripts/write-config.js` writes `config.js`.

## Worker Config

Set these Worker secrets:

- `NEON_DATABASE_URL`
- `NEON_AUTH_URL`
- `NEON_AUTH_JWKS_URL`
- `NEON_AUTH_JWT_ISSUER`
- `NEON_AUTH_JWT_AUDIENCE`

Set `NEON_AUTH_JWT_ISSUER` and `NEON_AUTH_JWT_AUDIENCE` from the `iss` and `aud` claims in a verified, current Neon Auth access token for this exact deployment. Do not guess them or reuse values from another Auth environment. Missing or incorrect values reject all bearer-token requests by design. The release script requires both values explicitly and will not deploy this authentication change without them.

Optional:

- `ELISTLY_ADMIN_EMAILS`

Set the required non-secret Worker variable `ELISTLY_ALLOWED_ORIGINS` to a comma-separated allowlist of exact frontend HTTP(S) origins. The checked-in production default is `https://elistly.com`; override it explicitly for another deployment. Do not use `*`, paths, or trailing slashes. Missing or malformed configuration fails every request closed, and an unlisted `Origin` receives `403` without credentialed CORS headers.

See `CLOUDFLARE_DEPLOY.md` for the full Cloudflare setup.
