#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SHELL_LINK_CLSID = Buffer.from('0114020000000000c000000000000046', 'hex');
const LINK_FLAGS = 0x04 | 0x08 | 0x40 | 0x80; // description, relative target, icon, Unicode

function encodeUnicodeString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 0xffff) {
    throw new TypeError(`${label} must contain 1-65535 characters`);
  }
  if (value.includes('\0')) throw new TypeError(`${label} must not contain NUL characters`);
  const content = Buffer.from(value, 'utf16le');
  const encoded = Buffer.allocUnsafe(2 + content.length);
  encoded.writeUInt16LE(value.length, 0);
  content.copy(encoded, 2);
  return encoded;
}

function assertPackageRelative(value, label) {
  if (typeof value !== 'string' || value.length === 0 ||
      path.win32.isAbsolute(value) || path.posix.isAbsolute(value) ||
      value.includes(':') || value.split(/[\\/]/).includes('..')) {
    throw new TypeError(`${label} must be a package-relative path`);
  }
}

function buildPortableShortcut({ outputPath, description, relativeTarget, iconLocation }) {
  if (!outputPath) throw new TypeError('outputPath is required');
  assertPackageRelative(relativeTarget, 'relativeTarget');
  assertPackageRelative(iconLocation, 'iconLocation');

  const header = Buffer.alloc(76);
  header.writeUInt32LE(0x4c, 0);
  SHELL_LINK_CLSID.copy(header, 4);
  header.writeUInt32LE(LINK_FLAGS, 20);
  header.writeUInt32LE(0x20, 24); // FILE_ATTRIBUTE_ARCHIVE
  header.writeUInt32LE(0, 56); // first icon in the ICO file
  header.writeUInt32LE(1, 60); // SW_SHOWNORMAL

  const shortcut = Buffer.concat([
    header,
    encodeUnicodeString(description, 'description'),
    encodeUnicodeString(relativeTarget, 'relativeTarget'),
    encodeUnicodeString(iconLocation, 'iconLocation'),
    Buffer.alloc(4), // TerminalBlock
  ]);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, shortcut);
}

if (require.main === module) {
  const [outputPath, relativeTarget, iconLocation, description] = process.argv.slice(2);
  if (!outputPath || !relativeTarget || !iconLocation || !description) {
    console.error('Usage: build-windows-shortcut.js OUTPUT RELATIVE_TARGET ICON_LOCATION DESCRIPTION');
    process.exit(2);
  }
  buildPortableShortcut({ outputPath, relativeTarget, iconLocation, description });
}

module.exports = { buildPortableShortcut };
