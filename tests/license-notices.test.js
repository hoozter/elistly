import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
test('third-party notices ship complete texts and match the worker lock', () => {
  const notices = read('THIRD_PARTY_NOTICES.html');
  for (const text of ['SortableJS', 'Roboto', 'Material Icons', 'Kazuhiko Arase', 'Permission is hereby granted', 'SIL OPEN FONT LICENSE', 'Apache License', 'Neon Inc.']) assert.ok(notices.includes(text), text);
  const lock = read('worker/package-lock.json');
  assert.ok(notices.includes(createHash('sha256').update(lock).digest('hex')), 'regenerate notices after dependency changes');
  for (const [path, pkg] of Object.entries(JSON.parse(lock).packages)) {
    if (path && !pkg.dev) assert.ok(notices.includes(`${path} @ ${pkg.version}`), path);
  }
  for (const page of ['index.html', 'app.html']) assert.ok(read(page).includes('href="THIRD_PARTY_NOTICES.html"'));
});
