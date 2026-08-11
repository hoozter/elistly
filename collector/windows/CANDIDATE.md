# Windows collector candidate 1.0.2

- Archive: `downloads/Elistly-Windows-Device-Intake-v1.0.2.zip`
- SHA-256: `8cb5ffdae2aed753ea8944a409a6856af6323845c21451cefdc9a4ff72bbcba2`
- Contents:
  - `Elistly Device Collector.lnk`
  - `README.txt`
  - `bin/Start Elistly Device Collector.bat`
  - `bin/Collect-ElistlyDevice.ps1`
  - `bin/Elistly.ico`

Launch on Windows 10 or Windows 11:

1. Verify the archive SHA-256 with `Get-FileHash .\Elistly-Windows-Device-Intake-v1.0.2.zip -Algorithm SHA256`.
2. Extract the entire ZIP.
3. Open the extracted folder.
4. Double-click the `Elistly Device Collector` shortcut with the Elistly icon.
5. Confirm the disclosed process-only execution policy bypass. It does not change machine or user policy; organization Group Policy still applies.
6. Review the disclosed field list, choose the JSON report destination, and upload the report through **Settings → Data → Device Intake**.

The shortcut stores only the relative target `bin\Start Elistly Device Collector.bat` and relative icon `bin\Elistly.ico`. It contains no absolute build path, command-line arguments, embedded script, URL, or network destination. If Windows or security software blocks the shortcut, the BAT in `bin` is the documented transparent fallback.

The source/static/browser gates are verified. Physical execution on Windows 10 and Windows 11, including shortcut appearance/resolution, Mark-of-the-Web behavior, domain/workgroup, non-admin, missing-CIM, hardware variants, organization-policy execution, and outbound-traffic observation, is not yet verified.
