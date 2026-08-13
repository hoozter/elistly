#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const patterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['aws-access-key-id', /AKIA[0-9A-Z]{16}/],
  ['github-token', /gh[pousr]_[A-Za-z0-9_]{20,}/],
  ['openai-api-key', /sk-[A-Za-z0-9_-]{20,}/],
  ['slack-token', /xox[baprs]-[A-Za-z0-9-]{10,}/]
];
const maxFileBytes = 1024 * 1024;

function optionValue(option) {
  const index = process.argv.indexOf(option);
  return index === -1 ? undefined : process.argv[index + 1];
}

const root = path.resolve(optionValue('--root') || path.join(__dirname, '..'));

function git(args, allowFailure = false) {
  const result = childProcess.spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(`git ${args[0]} failed`);
  return result;
}

function nullSeparated(output) {
  return output.split('\0').filter(Boolean);
}

function reportMatches(content, location, reports) {
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    for (const [kind, pattern] of patterns) {
      if (pattern.test(lines[index])) reports.add(`${location}:${index + 1} ${kind}`);
    }
  }
}

function scanWorkingTree(reports) {
  const files = nullSeparated(git(['ls-files', '-z']).stdout);
  for (const file of files) {
    const target = path.join(root, file);
    const stat = fs.statSync(target, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.size > maxFileBytes) continue;
    const content = fs.readFileSync(target, 'utf8');
    if (!content.includes('\0')) reportMatches(content, `tracked ${file}`, reports);
  }
}

function scanRevision(revision, prefix, reports) {
  const files = nullSeparated(git(['ls-tree', '-r', '-z', '--name-only', revision]).stdout);
  for (const file of files) {
    const shown = git(['show', `${revision}:${file}`], true);
    if (shown.status !== 0 || Buffer.byteLength(shown.stdout, 'utf8') > maxFileBytes || shown.stdout.includes('\0')) continue;
    reportMatches(shown.stdout, `${prefix}${file}`, reports);
  }
}

function main() {
  const reports = new Set();
  scanWorkingTree(reports);
  const commits = git(['rev-list', '--all']).stdout.trim().split('\n').filter(Boolean);
  for (const commit of commits) scanRevision(commit, `${commit} `, reports);

  if (reports.size === 0) {
    console.log('No strong credential signatures found in tracked files or reachable history.');
    return;
  }

  console.log('Strong credential signatures found (locations and pattern classes only):');
  for (const report of [...reports].sort()) console.log(report);
  process.exitCode = 1;
}

main();
