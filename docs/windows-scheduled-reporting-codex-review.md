# Local Codex review: previously deployed Windows scheduled reporting

This checklist describes an earlier reporter that was already installed from `Install-ElistlyReporting.ps1` and remains applicable only to that installed baseline. Do not download or install the retired split-flow artifact now. For every new installation, use the unified `Collect-ElistlyDevice.ps1` source workflow in [Windows device collector](windows-device-collector.md).

Review the existing `%ProgramData%\Elistly\Report-ElistlyDevice.ps1` locally. It contains a per-device `dp_…` credential: do not paste the complete file or token into chat, tickets, source control, or public scanners. If that installed file and the **Elistly Inventory Report** task do not already exist, stop and use the current unified workflow instead.

## Read-only review order

1. Confirm the existing **Elistly Inventory Report** task and `%ProgramData%\Elistly\Report-ElistlyDevice.ps1` predate the unified collector workflow. Do not issue a new installer from the retired UI.
2. Have Codex read the installed reporter locally only. Do not modify it, use an execution-policy bypass, disable endpoint protection, or disable monitoring.
3. Verify the only network endpoint is `https://elistly-api.royal-poetry-e390.workers.dev/device-reporting/report` over HTTPS. The installer itself does not download code or updates.
4. Verify the reporting POST is a bounded Windows inventory snapshot for the already-bound device: hardware identity, hostname, hardware model/serial, Windows version, CPU/RAM, fixed disks, local physical-adapter addresses, BIOS/TPM/Secure Boot/BitLocker availability, battery health, boot/uptime, and one current interactive-user observation when Windows exposes it. It does not scan the network, read browser data, documents, passwords, product keys, or Wi-Fi secrets.
5. Verify the task is named **Elistly Inventory Report**, runs as `SYSTEM` (`S-1-5-18`), triggers Monday 09:00 local time and at logon, starts when available, and ignores overlapping runs. Its local collector and result files are under `%ProgramData%\Elistly`.
6. Verify protected local files are limited to `%ProgramData%\Elistly\Report-ElistlyDevice.ps1`, `%ProgramData%\Elistly\Remove-ElistlyReporting.ps1`, and `%ProgramData%\Elistly\last-result.json`; access is restricted to SYSTEM and local administrators. Local administrators can read the scoped credential.
7. Verify removal is available via `%ProgramData%\Elistly\Remove-ElistlyReporting.ps1`, stops/unregisters only **Elistly Inventory Report**, and deletes only those known Elistly reporting files. Reporting credentials are manually revocable in Elistly; revocation stops future API reports but does not erase already stored inventory.
8. Confirm the script contains no `ExecutionPolicy`, `Bypass`, `Set-ExecutionPolicy`, `DownloadString`, `Invoke-Expression`, `iex`, hidden-window behavior, or security-control changes.

For an earlier installed reporter, check local evidence first: `Get-ScheduledTaskInfo -TaskName 'Elistly Inventory Report'` and `%ProgramData%\Elistly\last-result.json`. A successful task start is not proof a report arrived; refresh Elistly and inspect **Last collected facts**. Native Task Scheduler behavior still needs physical acceptance; Linux parser/mock tests are not a substitute. Do not create an old split-flow installation merely to satisfy this historical checklist.
