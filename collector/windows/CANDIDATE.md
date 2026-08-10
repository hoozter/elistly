# Windows collector candidate 1.0.0

- Archive: `downloads/Elistly-Windows-Device-Intake-v1.0.0.zip`
- SHA-256: `a0dc79865661ffd41cf358103b9f808d2fd59de3c27f1813ea56472a12d2ef05`
- Contents: `Collect-ElistlyDevice.ps1`, `README.txt`

Launch on Windows 10 or Windows 11:

1. Verify the archive SHA-256 with `Get-FileHash .\Elistly-Windows-Device-Intake-v1.0.0.zip -Algorithm SHA256`.
2. Extract the entire ZIP.
3. Open the extracted folder.
4. Right-click `Collect-ElistlyDevice.ps1` and choose **Run with PowerShell**.
5. Do not change or bypass the machine's PowerShell execution policy. If the existing policy blocks the script, stop and ask the administrator to review it.
6. Review the disclosed field list, choose the JSON report destination, and upload the report through **Settings → Data → Device Intake**.

The source/static/browser gates are verified. Physical execution on Windows 10 and Windows 11, including domain/workgroup, non-admin, missing-CIM, hardware variants, existing-policy execution, and outbound-traffic observation, is not yet verified.
