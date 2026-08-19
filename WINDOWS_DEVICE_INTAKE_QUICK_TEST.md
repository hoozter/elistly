# Elistly Windows intake — quick acceptance

1. Download and extract `Elistly-Windows-Device-Intake-v1.0.3.zip`.
2. Double-click **Elistly Device Collector**. If Windows blocks the shortcut, run `bin\Start Elistly Device Collector.bat` instead.
3. Confirm the process-only PowerShell bypass, review the disclosed fields, and save the JSON report.
4. In Elistly: **Add Computer → Import collected information**. Check hostname, manufacturer/model, serial number, user context, CPU/RAM/GPU and Windows details; correct anything needed. Person assignment should remain optional and unselected.
5. Press the ordinary **Save**, reopen the Computer, and confirm the imported values remain editable.

If anything fails, send Yuki the step number, a screenshot or exact message, and the generated JSON report only if it contains no information you do not want to share.
