#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packageScript = path.join(root, 'scripts/package-windows-collector.sh');
const expectedName = 'Elistly-Windows-Device-Intake-v1.0.3.zip';
const outputDirectories = [
  fs.mkdtempSync(path.join(os.tmpdir(), 'elistly-collector-package-a-')),
  fs.mkdtempSync(path.join(os.tmpdir(), 'elistly-collector-package-b-')),
];

try {
  const archives = outputDirectories.map(outputDirectory => {
    childProcess.execFileSync(packageScript, [], {
      cwd: root,
      env: { ...process.env, ELISTLY_COLLECTOR_OUTPUT_DIR: outputDirectory },
      stdio: 'pipe',
    });
    const archive = path.join(outputDirectory, expectedName);
    assert.ok(fs.existsSync(archive), 'the package command must write the declared collector archive to its requested output directory');
    return fs.readFileSync(archive);
  });

  assert.deepEqual(archives[1], archives[0], 'two packages from the same source must be byte-identical');
  assert.equal(
    crypto.createHash('sha256').update(archives[0]).digest('hex'),
    '63348429c4adc81451141cf04de21972fb91e6b2d70e06b592f76ba2e3dcc195',
    'the declared collector artifact must have its recorded reproducible checksum',
  );
  console.log('PASS windows-collector-package');
} finally {
  for (const outputDirectory of outputDirectories) fs.rmSync(outputDirectory, { recursive: true, force: true });
}
