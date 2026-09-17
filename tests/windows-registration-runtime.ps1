# Synthetic command mocks: does not prove Windows hardware acceptance.
param([Parameter(Mandatory=$true)][string]$ScriptPath)
$ErrorActionPreference = 'Stop'
$tokens = $null; $parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$env:COMPUTERNAME = 'ELISTLY-TEST-PC'
$env:SystemDrive = 'C:'
$global:Limited = $false
$global:NoUser = $false
$global:Posts = 0
function Get-CimInstance {
 param($Namespace, $ClassName, $Filter, $ErrorAction)
 if ($global:Limited -and $ClassName -notin @('Win32_BIOS','Win32_ComputerSystemProduct')) { throw 'Test access denied' }
 switch ($ClassName) {
 'Win32_BIOS' { [pscustomobject]@{SerialNumber='ELISTLY-MOCK-SERIAL';SMBIOSBIOSVersion='Mock BIOS'} }
 'Win32_ComputerSystemProduct' { [pscustomobject]@{UUID='dbe9d63c-42a6-4bdb-92c4-a3d7fa420615'} }
 'Win32_ComputerSystem' { [pscustomobject]@{Manufacturer='Mock manufacturer';Model='Mock model';UserName=$(if ($global:NoUser) { 'NT AUTHORITY\SYSTEM' } else { 'TEST\example' });TotalPhysicalMemory=17179869184} }
 'Win32_OperatingSystem' { [pscustomobject]@{Caption='Microsoft Windows 11 Pro';Version='10.0.26100';BuildNumber='26100';InstallDate=[datetime]'2025-01-01T12:00:00Z';LastBootUpTime=[datetime]::UtcNow.AddHours(-2)} }
 'Win32_Processor' { [pscustomobject]@{Name='Mock CPU';NumberOfCores=4;NumberOfLogicalProcessors=8} }
 'Win32_LogicalDisk' { [pscustomobject]@{DeviceID='C:';Size=512000000000;FreeSpace=128000000000} }
 'Win32_Tpm' { [pscustomobject]@{SpecVersion='2.0, 0, 1.59'} }
 'BatteryStaticData' { [pscustomobject]@{DesignedCapacity=50000} }
 'BatteryFullChargedCapacity' { [pscustomobject]@{FullChargedCapacity=40000} }
 'Win32_NetworkAdapterConfiguration' { [pscustomobject]@{Description='Mock ethernet';MACAddress='02:00:00:00:00:01';IPAddress=@('192.0.2.10','2001:db8::10');IPEnabled=$true} }
 default { throw "Unexpected test CIM class: $ClassName" }
 }
}
function Get-ItemProperty { param($Path,$Name,$ErrorAction); if ($global:Limited) { throw 'Test access denied' }; [pscustomobject]@{DisplayVersion='24H2'} }
function Get-Tpm { param($ErrorAction); if ($global:Limited) { throw 'Test access denied' }; [pscustomobject]@{TpmPresent=$true;TpmReady=$true;ManufacturerVersion='firmware-not-spec'} }
function Confirm-SecureBootUEFI { param($ErrorAction); if ($global:Limited) { throw 'Test access denied' }; $true }
function Get-BitLockerVolume { param($MountPoint,$ErrorAction); if ($global:Limited) { throw 'Test access denied' }; [pscustomobject]@{ProtectionStatus='On'} }
function Get-NetAdapter { param([switch]$Physical,$ErrorAction); [pscustomobject]@{Status="Up";MacAddress="02:00:00:00:00:01";Name="Ethernet";ifIndex=1} }
function Get-NetIPAddress { param($InterfaceIndex,$AddressFamily,$ErrorAction); [pscustomobject]@{IPAddress="192.0.2.10";AddressFamily="IPv4"} }
function Invoke-RestMethod { param($Method,$Uri,$Headers,$Body,$ContentType); $global:Posts++; $global:Posted=[System.Text.Encoding]::UTF8.GetString($Body) | ConvertFrom-Json; [pscustomobject]@{created=$true;deviceId='synthetic-test-device'} }
function Assert($Condition,[string]$Message) { if (-not $Condition) { throw "FAIL: $Message" } }
$preview = (& $ScriptPath -Preview | Out-String) | ConvertFrom-Json
Assert ($global:Posts -eq 0) 'Preview must make no HTTP request'
Assert ($preview.hostname -eq 'ELISTLY-TEST-PC') 'Hostname'
Assert ($preview.inventorySnapshot.windows.installDate) 'CIM DateTime install date'
Assert ($preview.inventorySnapshot.lastBootAt) 'CIM DateTime boot timestamp'
Assert ($preview.inventorySnapshot.uptimeSeconds -ge 7190) 'Uptime'
Assert ($preview.inventorySnapshot.windows.displayRelease -eq '24H2') 'Registry Windows release'
Assert ($preview.inventorySnapshot.tpm.version -match '^2.0') 'TPM spec not firmware'
Assert ($preview.inventorySnapshot.lastInteractiveUser.username -eq 'TEST\example') 'Observed interactive username'
Assert ($preview.inventorySnapshot.networkAdapters.Count -eq 1) 'Network adapter facts'
$global:NoUser=$true
$noUser = (& $ScriptPath -Preview | Out-String) | ConvertFrom-Json
Assert ($null -eq $noUser.inventorySnapshot.lastInteractiveUser.username) 'Never label SYSTEM as interactive user'
$global:Limited=$true
$limited = (& $ScriptPath -Preview | Out-String) | ConvertFrom-Json
Assert ($null -eq $limited.inventorySnapshot.secureBoot) 'Unavailable secure boot null'
Assert ($null -eq $limited.inventorySnapshot.windows.installDate) 'Unavailable OS facts null'
Assert ($global:Posts -eq 0) 'All previews make no HTTP requests'
$global:Limited=$false; $global:NoUser=$false
& $ScriptPath
Assert ($global:Posts -eq 1) 'Registration sends exactly once'
Assert ($global:Posted.inventorySnapshot.windows.installDate) 'Posted validated snapshot'

Write-Output 'PASS: PowerShell parser and synthetic full/limited/SYSTEM/preview/registration execution. This does not verify real Windows CIM behavior.'
