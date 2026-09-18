#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const serviceWorker = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
const appDocument = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
const registrationScript = fs.readFileSync(path.join(__dirname, '..', 'pwa-register.js'), 'utf8');

function response(body, status = 200) {
  return {
    body,
    status,
    clone() { return response(body, status); }
  };
}

function loadServiceWorker({ fetch, keys = [], match }) {
  const listeners = {};
  const puts = [];
  const deleted = [];
  const cache = {
    addAll: async () => {},
    match: async request => match ? match(request) : undefined,
    put: async (request, value) => { puts.push({ request, value }); }
  };
  const context = {
    URL,
    Promise,
    fetch,
    caches: {
      open: async () => cache,
      match: async request => match ? match(request) : undefined,
      keys: async () => keys,
      delete: async key => { deleted.push(key); return true; }
    },
    self: {
      location: { origin: 'https://elistly.test', href: 'https://elistly.test/sw.js' },
      addEventListener: (type, listener) => { listeners[type] = listener; },
      skipWaiting: () => {},
      clients: { claim: () => {} }
    }
  };
  vm.runInNewContext(serviceWorker, context, { filename: 'sw.js' });
  return { listeners, puts, deleted };
}

async function dispatchFetch(harness, request) {
  let result;
  harness.listeners.fetch({ request, respondWith: promise => { result = promise; } });
  return result ? result : undefined;
}

async function testDoesNotCacheRuntimeConfiguration() {
  const harness = loadServiceWorker({ fetch: async () => response('window.ELISTLY_API_URL = "https://api.example";') });
  await dispatchFetch(harness, { method: 'GET', mode: 'no-cors', url: 'https://elistly.test/config.js' });
  assert.equal(harness.puts.length, 0, 'runtime configuration must remain network-only and never enter the shell cache');
}

async function testPrivateResponsesNeverEnterShellCache() {
  for (const pathname of ['/app-data', '/users/me', '/get-session', '/device-reporting/devices', '/app.html?private=synthetic']) {
    for (const mode of ['cors', 'navigate']) {
      let cacheReads = 0;
      const harness = loadServiceWorker({
        fetch: async () => response('synthetic private response'),
        match: () => { cacheReads += 1; return response('old private response'); }
      });
      const result = await dispatchFetch(harness, { method: 'GET', mode, url: `https://elistly.test${pathname}` });
      assert.equal(result, undefined, 'non-shell requests must remain browser network requests');
      assert.equal(harness.puts.length, 0, 'private responses must never be retained by the service worker');
      assert.equal(cacheReads, 0, 'private requests must never receive old cached responses');
    }
  }
}

async function testNavigationPrefersFreshDocument() {
  const fresh = response('<script src="app.js?v=21"></script>');
  const harness = loadServiceWorker({ fetch: async () => fresh });
  const result = await dispatchFetch(harness, { method: 'GET', mode: 'navigate', url: 'https://elistly.test/app.html' });
  assert.equal(result, fresh, 'an online navigation must use the fresh network document');
}

async function testOfflineNavigationFallsBackToShell() {
  const shell = response('<script src="app.js?v=20"></script>');
  const harness = loadServiceWorker({ fetch: async () => { throw new Error('offline'); }, match: () => shell });
  const result = await dispatchFetch(harness, { method: 'GET', mode: 'navigate', url: 'https://elistly.test/app.html' });
  assert.equal(result, shell, 'offline navigation must use the cached shell as its explicit fallback');
}

async function testActivationRetiresOnlyPriorElistlyShells() {
  const harness = loadServiceWorker({ fetch: async () => response(''), keys: ['elistly-shell-v10', 'elistly-shell-v11', 'elistly-shell-v12', 'elistly-shell-v13', 'elistly-shell-v14', 'elistly-shell-v15', 'unrelated-app-v1'] });
  let completed;
  harness.listeners.activate({ waitUntil: promise => { completed = promise; } });
  await completed;
  assert.deepEqual(harness.deleted, ['elistly-shell-v10', 'elistly-shell-v11', 'elistly-shell-v12', 'elistly-shell-v13', 'elistly-shell-v14', 'elistly-shell-v15'], 'activation must retire only prior Elistly shell caches');
}

function testRegistrationWaitsForSafeReload() {
  assert.match(registrationScript, /registration\.waiting/);
  assert.match(registrationScript, /ElistlyStorage\.getSyncStatus\(\)/);
  assert.match(registrationScript, /sync\.state === 'synced'/);
  assert.match(registrationScript, /controllerchange/);
  assert.match(registrationScript, /navigator\.serviceWorker\.controller/);
  assert.match(registrationScript, /window\.location\.reload\(\)/);
  assert.match(registrationScript, /elistly:sync-status/);
}

function testShellVersionMatchesLoadedBundles() {
  for (const document of [appDocument, fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')]) {
    for (const [, src] of document.matchAll(/<script src="([^"]+)"/g)) {
      if (src === 'config.js' || src.startsWith('https://')) continue;
      assert.ok(serviceWorker.includes(`'./${src}'`), `local shell dependency ${src} must remain available offline`);
    }
  }
  const shellVersion = /elistly-shell-v(\d+)/.exec(serviceWorker)[1];
  const appVersion = /app\.js\?v=(\d+)/.exec(appDocument)[1];
  const styleVersion = /styles\.css\?v=(\d+)/.exec(appDocument)[1];
  const authVersionMatch = /lib\/db\.js\?v=(\d+)/.exec(appDocument);
  assert.ok(authVersionMatch, 'the Auth adapter must have an explicit cache-busting version');
  assert.match(serviceWorker, new RegExp(`app\\.js\\?v=${appVersion}`));
  assert.match(serviceWorker, new RegExp(`styles\\.css\\?v=${styleVersion}`));
  assert.match(serviceWorker, new RegExp(`lib/db\\.js\\?v=${authVersionMatch[1]}`));
  assert.ok(Number(shellVersion) > 10, 'a changed shell must use a newer explicit shell version');
}

(async () => {
  await testDoesNotCacheRuntimeConfiguration();
  await testPrivateResponsesNeverEnterShellCache();
  await testNavigationPrefersFreshDocument();
  await testOfflineNavigationFallsBackToShell();
  await testActivationRetiresOnlyPriorElistlyShells();
  testRegistrationWaitsForSafeReload();
  testShellVersionMatchesLoadedBundles();
  console.log('PASS pwa-update-safety');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
