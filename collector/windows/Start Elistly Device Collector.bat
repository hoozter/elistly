@echo off
setlocal

set "collector_script=%~dp0Collect-ElistlyDevice.ps1"

if not exist "%collector_script%" (
  echo The Elistly collector script is missing from this folder.
  echo Extract the entire ZIP, then try again.
  pause
  exit /b 2
)

echo Elistly will collect the device details listed in README.txt.
echo The launcher uses a temporary execution-policy bypass for this collector process only.
echo It does not change the machine or user PowerShell execution policy.
echo If your organization enforces policy through Group Policy, that policy still applies.
echo.
choice /C YN /N /M "Continue? [Y/N] "
if errorlevel 2 exit /b 1

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%collector_script%"
set "collector_exit=%ERRORLEVEL%"

if not "%collector_exit%"=="0" (
  echo.
  echo The Elistly collector did not complete. Exit code: %collector_exit%
  pause
)

exit /b %collector_exit%
