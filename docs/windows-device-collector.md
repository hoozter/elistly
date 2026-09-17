# Windows device collector

This describes the locally tested source workflow. It has not been deployed or exercised on real Windows hardware.

1. Select the workspace that should receive the computer. Open **Settings → Windows device collector → Create**.
2. Optionally name the collector download, for example “Office PCs”. This does not rename computers: registration uses the Windows hostname.
3. Leave **Keep updated automatically** unchecked to collect and register once. Nothing is installed. Repeating registration recognizes the same hardware; it does not overwrite existing manual records or assign a person.
4. Check it to register and install reporting in one run. Choose the weekly day and local time, and whether to report after sign-in. Defaults remain Monday 09:00 and after sign-in. Reporting also starts immediately after installation and catches up missed runs.
5. Optionally choose a future expiry for the collector secret. Blank means it remains usable until revoked.
6. Choose **Save and download**. The single file is `Collect-ElistlyDevice.ps1`. Downloading does not register or change a computer. Run it in PowerShell on the target; automatic reporting requires administrator PowerShell. Follow your normal execution policy; the script does not change it.

The form displays validation, creation failures and download status. Revocation requires an in-app confirmation. No native JavaScript alert, confirm or prompt is used.

## Credentials and existing installations

The download contains a workspace-scoped enrollment secret. Store it privately, do not paste it into chats or tickets, and delete the target’s copy after use. It is not displayed in the page, included in credential lists or stored in app inventory. The server stores its hash. If the download cannot start after creation, revoke that collector and create a replacement.

One-time collectors retain registration-only `dr_` credentials. Automatic collectors use explicit `dc_` enrollment authority: registration atomically returns a `dp_` credential bound to that computer and workspace. Only that device credential is written into the protected installed reporter; the collector credential is not persisted there. Collector expiry or revocation prevents future enrollment but does not revoke already installed reporters. Revoke those separately in **Created collectors and reporting → Manage installed reporting**.

Existing deployed `dp_` credentials, `/device-reporting/report`, snapshot payload, task name **Elistly Inventory Report**, SYSTEM identity, local paths and existing task schedules are unchanged. The combined script refuses an already installed task before contacting registration. It never silently replaces an installed reporter. The existing installed removal script remains usable.

## Verify and remove reporting

Refresh Elistly after running the collector. Open **Manage installed reporting**, select the computer, and inspect **Last collected facts**. A successful download or task start does not prove that reporting succeeded.

On Windows, inspect **Elistly Inventory Report** in Task Scheduler and `%ProgramData%\Elistly\last-result.json`. Its reporter, removal script and result file are restricted to SYSTEM and local administrators. Local administrators can read the device credential. Collection retains the existing bounded hardware/Windows facts and current interactive-user observation; it does not read documents, browser data, passwords or recovery keys.

To stop API reporting, revoke the relevant reporting credential in Elistly. To remove the local task and credential, run `%ProgramData%\Elistly\Remove-ElistlyReporting.ps1` in administrator PowerShell. Neither action deletes inventory. If installation fails after registration, the computer and issued reporting credential may already exist; inspect the error, revoke the unused reporting credential and use the removal script if local files were written before retrying. A network failure after an enrollment response is lost can also leave an unused reporting credential; it is visible in reporting management.

Browser tests exercise real downloads against synthetic API responses. Source tests, an isolated PostgreSQL engine and PowerShell parser/synthetic collector execution verify the contract locally. Real Windows CIM, ACL, Task Scheduler installation, delivery and removal remain a separate physical acceptance step.
