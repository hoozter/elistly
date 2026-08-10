Elistly Windows Device Intake Collector 1.0.0
================================================

Purpose
-------
This collector creates one local JSON inventory report for upload in Elistly.
It supports Windows 10 and Windows 11 and runs as a standard non-administrator
account. It does not install software, contact Elistly, or use the network.

Launch
------
1. Extract the entire ZIP archive.
2. Open the extracted folder.
3. Right-click Collect-ElistlyDevice.ps1 and choose "Run with PowerShell".
4. Read the disclosed field list and choose OK to continue.
5. Choose the report destination in the Save dialog.
6. In Elistly, open Settings > Data > Device Intake and select the JSON report.
7. Review all create/update/conflict choices, then choose Confirm import.

Do not weaken or bypass your PowerShell execution policy. If your organization
does not permit this signed/unsigned local script under its existing policy,
ask your administrator to review and approve the script. The collector never
changes the policy itself.

Privacy
-------
The collector reads only the fields shown before collection: hostname,
manufacturer/model, processor, memory, graphics names, Windows version/build,
BIOS serial, current account/domain context, collection time, and collector
version. Directory enrichment is not included in v1. No clipboard or shared
temporary location is used. You choose the output path. Protect the report as
workplace inventory data and delete the report when your retention policy
permits.
