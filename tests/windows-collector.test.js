#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const scriptPath = path.join(root, 'collector/windows/Collect-ElistlyDevice.ps1');
const readmePath = path.join(root, 'collector/windows/README.txt');
const script = fs.readFileSync(scriptPath, 'utf8');
const readme = fs.readFileSync(readmePath, 'utf8');

assert.match(script, /SaveFileDialog/, 'user must choose the report path');
assert.match(script, /elistly\.device-intake\.v1/);
assert.match(script, /networkDirectoryLookup\s*=\s*\$false/);
assert.match(script, /Get-CimInstance/);
assert.doesNotMatch(script, /-ExecutionPolicy|Bypass|Hidden|Set-Clipboard|clip\.exe|Get-AD|Invoke-WebRequest|Invoke-RestMethod|Net\.WebClient|TEMP|TMP/i);
assert.doesNotMatch(script, /product\s*key|password|token|wifi|browser|document/i);
assert.match(script, /ConvertTo-Json/);
assert.match(script, /WriteAllText\([^,]+,[^,]+,\s*\(New-Object System\.Text\.UTF8Encoding\(\$false\)\)\)/);
assert.match(readme, /standard.*non-administrator/i);
assert.match(readme, /does not.*network/i);
assert.match(readme, /PowerShell execution policy/i);
assert.match(readme, /delete.*report/i);
assert.match(readme, /Windows 10.*Windows 11/i);
console.log('PASS windows-collector');
