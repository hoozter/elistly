# Elistly Windows Device Intake Collector 1.0.2
# Local-only inventory collection. No administrator access or network lookup is used.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$fieldList = @(
  'Computer hostname', 'Manufacturer and model', 'Processor name', 'Installed memory',
  'Graphics adapter names', 'Windows edition, version, and build', 'BIOS serial number',
  'Current account name and Windows domain/workgroup', 'Collection time and collector version'
)
$notice = "Elistly will read these local fields:`r`n`r`n- " + ($fieldList -join "`r`n- ") +
  "`r`n`r`nNo administrator access is required. No network or directory lookup is performed. You will choose where the JSON report is saved."
$answer = [System.Windows.Forms.MessageBox]::Show($notice, 'Elistly Device Intake', 'OKCancel', 'Information')
if ($answer -ne 'OK') { Write-Host 'Collection cancelled.'; exit 0 }

$saveDialog = New-Object System.Windows.Forms.SaveFileDialog
$saveDialog.Title = 'Choose where to save the Elistly device report'
$saveDialog.Filter = 'JSON report (*.json)|*.json'
$saveDialog.FileName = 'elistly-device-report-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json'
$saveDialog.OverwritePrompt = $true
if ($saveDialog.ShowDialog() -ne 'OK') { Write-Host 'Collection cancelled. No report was written.'; exit 0 }
$reportPath = $saveDialog.FileName

function Get-FirstCim([string] $ClassName) {
  try { @(Get-CimInstance -ClassName $ClassName -ErrorAction Stop)[0] } catch { $null }
}

$computerSystem = Get-FirstCim 'Win32_ComputerSystem'
$operatingSystem = Get-FirstCim 'Win32_OperatingSystem'
$bios = Get-FirstCim 'Win32_BIOS'
$processors = @(Get-CimInstance -ClassName 'Win32_Processor' -ErrorAction SilentlyContinue)
$graphics = @(Get-CimInstance -ClassName 'Win32_VideoController' -ErrorAction SilentlyContinue)
$memoryBytes = if ($computerSystem -and $computerSystem.TotalPhysicalMemory) { [uint64]$computerSystem.TotalPhysicalMemory } else { 0 }
$memorySummary = if ($memoryBytes) { '{0:N0} GB' -f ($memoryBytes / 1GB) } else { $null }
$processorNames = @($processors | ForEach-Object { if ($_.Name) { ([string]$_.Name).Trim() } })
$graphicsNames = @($graphics | ForEach-Object { if ($_.Name) { ([string]$_.Name).Trim() } })

$report = [ordered]@{
  schema = 'elistly.device-intake.v1'
  collectedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  collector = [ordered]@{ name = 'Elistly Windows Device Intake Collector'; version = '1.0.2' }
  collection = [ordered]@{ mode = 'local-only'; networkDirectoryLookup = $false; fields = $fieldList }
  person = [ordered]@{ accountName = [Environment]::UserName; domain = [Environment]::UserDomainName }
  computer = [ordered]@{
    hostname = [Environment]::MachineName
    manufacturer = if ($computerSystem) { [string]$computerSystem.Manufacturer } else { $null }
    model = if ($computerSystem) { [string]$computerSystem.Model } else { $null }
    processorSummary = if ($processorNames.Count) { $processorNames[0] } else { $null }
    processorDescription = $processorNames -join '; '
    memorySummary = $memorySummary
    graphicsAdapters = $graphicsNames
    windowsEdition = if ($operatingSystem) { [string]$operatingSystem.Caption } else { $null }
    windowsVersion = if ($operatingSystem) { [string]$operatingSystem.Version } else { $null }
    windowsBuild = if ($operatingSystem) { [string]$operatingSystem.BuildNumber } else { $null }
    serialNumber = if ($bios) { [string]$bios.SerialNumber } else { $null }
    accountName = [Environment]::UserName
    windowsDomain = [Environment]::UserDomainName
  }
}

$json = $report | ConvertTo-Json -Depth 4
if ([System.Text.Encoding]::UTF8.GetByteCount($json) -gt 262144) { throw 'The report exceeds the 256 KiB limit and was not written.' }
[System.IO.File]::WriteAllText($reportPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Report saved to: $reportPath"
Write-Host 'Upload it in Elistly under Settings > Data > Device Intake. Delete the report when your retention policy permits.'
Read-Host 'Press Enter to close'
