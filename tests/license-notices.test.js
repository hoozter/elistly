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
  const landing = read('index.html');
  const app = read('app.js');
  for (const page of [landing, app]) {
    assert.ok(page.includes('src="THIRD_PARTY_NOTICES.html?v=9ec1f915882700b3d1d9bb9a0f9a9231e298d1fb7f55ee08da04dce3845b63a7"'), 'notices are available in the Legal popup with the notices content version');
    assert.ok(page.includes('title="Full third-party notices"'), 'embedded notices have an accessible title');
    assert.ok(page.includes('role="tablist"'), 'Legal popup separates notices into tabs');
    assert.ok(page.includes('role="tabpanel"'), 'tab panels are identified for assistive technology');
    assert.ok(page.includes('>Privacy</button>'), 'privacy is a separate tab');
    assert.ok(page.includes('>Terms</button>'), 'terms are a separate tab');
    assert.ok(page.includes('>Third-party notices</button>'), 'notices are a separate tab');
    assert.ok(page.includes('not end-to-end encrypted'), 'privacy copy does not promise end-to-end encryption');
    assert.ok(page.includes('authorised Elistly administrators and service providers'), 'privacy copy plainly explains authorised access');
    assert.ok(page.includes('password is sent to Neon to verify your identity'), 'privacy copy explains where a password goes');
    assert.ok(page.includes('one-way hash rather than as readable plain text'), 'privacy copy plainly explains password storage');
    assert.ok(!page.includes('JSONB'), 'privacy copy does not expose implementation jargon');
    assert.ok(!page.includes('Worker auth route'), 'privacy copy does not expose internal routing details');
    assert.ok(!page.includes('plaintext password'), 'privacy copy does not imply passwords are stored as plaintext');
  }
  for (const footer of [read('index.html').match(/<footer class="app-footer landing-footer">[\s\S]*?<\/footer>/)[0], read('app.html').match(/<footer class="app-footer">[\s\S]*?<\/footer>/)[0]]) {
    assert.ok(!footer.includes('THIRD_PARTY_NOTICES.html'), 'no standalone footer notices link');
  }
});
