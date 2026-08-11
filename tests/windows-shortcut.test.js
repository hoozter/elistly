#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildPortableShortcut } = require('../scripts/build-windows-shortcut');

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elistly-shortcut-'));
const outputPath = path.join(outputDir, 'Elistly Device Collector.lnk');

try {
  assert.throws(() => buildPortableShortcut({
    outputPath,
    description: 'Invalid target',
    relativeTarget: '..\\outside.bat',
    iconLocation: 'bin\\Elistly.ico',
  }), /package-relative/);
  assert.throws(() => buildPortableShortcut({
    outputPath,
    description: 'Invalid icon',
    relativeTarget: 'bin\\collector.bat',
    iconLocation: 'C:Elistly.ico',
  }), /package-relative/);

  buildPortableShortcut({
    outputPath,
    description: 'Collect this Windows computer for Elistly',
    relativeTarget: 'bin\\Start Elistly Device Collector.bat',
    iconLocation: 'bin\\Elistly.ico',
  });

  const shortcut = fs.readFileSync(outputPath);
  assert.equal(shortcut.readUInt32LE(0), 0x4c, 'shortcut header size');
  assert.equal(shortcut.subarray(4, 20).toString('hex'), '0114020000000000c000000000000046', 'Shell Link CLSID');

  const flags = shortcut.readUInt32LE(20);
  assert.equal(flags & 0x04, 0x04, 'description must be present');
  assert.equal(flags & 0x08, 0x08, 'relative target must be present');
  assert.equal(flags & 0x40, 0x40, 'icon location must be present');
  assert.equal(flags & 0x80, 0x80, 'strings must be Unicode');
  assert.equal(flags & ~0xcc, 0, 'shortcut must not contain absolute target, arguments, or environment blocks');
  assert.equal(shortcut.readUInt32LE(60), 1, 'shortcut must open normally');

  let offset = 76;
  const readUnicodeString = () => {
    const length = shortcut.readUInt16LE(offset);
    offset += 2;
    const value = shortcut.subarray(offset, offset + length * 2).toString('utf16le');
    offset += length * 2;
    return value;
  };

  assert.equal(readUnicodeString(), 'Collect this Windows computer for Elistly');
  assert.equal(readUnicodeString(), 'bin\\Start Elistly Device Collector.bat');
  assert.equal(readUnicodeString(), 'bin\\Elistly.ico');
  assert.equal(shortcut.readUInt32LE(offset), 0, 'shortcut must end with TerminalBlock');
  assert.equal(offset + 4, shortcut.length, 'shortcut must contain no hidden trailing data');

  const utf16 = shortcut.toString('utf16le').toLowerCase();
  assert.doesNotMatch(utf16, /home\\campbell|powershell|https?:|cmd\.exe/);
  console.log('PASS windows-shortcut');
} finally {
  fs.rmSync(outputDir, { recursive: true, force: true });
}
