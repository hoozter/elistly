#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const scanner = path.join(root, 'scripts', 'scan-repository-secrets.js');

function run(command, args, cwd) {
  return childProcess.spawnSync(command, args, { cwd, encoding: 'utf8' });
}

function initializeRepository(files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elistly-secret-scan-'));
  run('git', ['init', '--quiet'], directory);
  run('git', ['config', 'user.email', 'test@example.invalid'], directory);
  run('git', ['config', 'user.name', 'Elistly test'], directory);
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  run('git', ['add', '.'], directory);
  run('git', ['commit', '--quiet', '-m', 'fixture'], directory);
  return directory;
}

const fixtureGithubToken = `gh${'p_'}${'abcdefghijklmnopqrstuvwxyz1234567890'}`;

function testReportsOnlyLocationsForTrackedAndHistoricalMatches() {
  const directory = initializeRepository({
    'current.txt': 'not a credential\n',
    'history-only.txt': `token = "${fixtureGithubToken}"\n`
  });
  try {
    run('git', ['rm', '--quiet', 'history-only.txt'], directory);
    run('git', ['commit', '--quiet', '-m', 'remove fixture'], directory);

    const result = run('node', [scanner, '--root', directory], root);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /history-only\.txt/);
    assert.match(result.stdout, /github-token/);
    assert.doesNotMatch(result.stdout, /ghp_/);
    assert.doesNotMatch(result.stderr, /ghp_/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testScansCurrentTrackedWorkingTreeFiles() {
  const directory = initializeRepository({
    'current.txt': 'safe value\n'
  });
  try {
    fs.writeFileSync(path.join(directory, 'current.txt'), `token = "${fixtureGithubToken}"\n`);
    const result = run('node', [scanner, '--root', directory], root);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /tracked current\.txt/);
    assert.doesNotMatch(result.stdout, /ghp_/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testPassesWithoutStrongCredentialPatterns() {
  const directory = initializeRepository({
    '.env.example': 'ELISTLY_API_URL=https://api.example.test\n',
    'worker/wrangler.toml': '[vars]\nELISTLY_ALLOWED_ORIGINS = "https://app.example.test"\n'
  });
  try {
    const result = run('node', [scanner, '--root', directory], root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No strong credential signatures found/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testIgnoresGenericLocalConfigurationAndCredentialArtifacts() {
  const artifacts = ['.env.local', '.dev.vars', '.dev.vars.preview', 'secrets/api-token', 'private.key', 'certificate.pfx'];
  for (const artifact of artifacts) {
    const result = run('git', ['check-ignore', '-q', '--no-index', artifact], root);
    assert.equal(result.status, 0, `${artifact} must be ignored`);
  }
  const template = run('git', ['check-ignore', '-q', '--no-index', '.env.example'], root);
  assert.notEqual(template.status, 0, 'the safe environment template must remain trackable');
}

testReportsOnlyLocationsForTrackedAndHistoricalMatches();
testScansCurrentTrackedWorkingTreeFiles();
testPassesWithoutStrongCredentialPatterns();
testIgnoresGenericLocalConfigurationAndCredentialArtifacts();
console.log('PASS repository-secret-scan');
