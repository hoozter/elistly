#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('/home/campbell/node_modules/playwright');

const root = path.resolve(__dirname, '..');

function startStaticServer() {
  const server = http.createServer((request, response) => {
    const relativePath = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname).replace(/^\/+/, '') || 'app.html';
    const filePath = path.resolve(root, relativePath);
    if (!filePath.startsWith(`${root}${path.sep}`) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return response.writeHead(404).end('Not found');
    response.end(fs.readFileSync(filePath));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function withPage(run) {
  const server = await startStaticServer();
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.route('**/config.js', route => route.fulfill({ contentType: 'application/javascript', body: 'window.ELISTLY_API_URL = "/mock"; window.NEON_AUTH_URL = "/mock-auth";' }));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/app.html`, { waitUntil: 'domcontentloaded' });
    await run(page);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

async function withPages(run) {
  const server = await startStaticServer();
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const first = await context.newPage();
  const second = await context.newPage();
  for (const page of [first, second]) {
    await page.route('**/config.js', route => route.fulfill({ contentType: 'application/javascript', body: 'window.ELISTLY_API_URL = "/mock"; window.NEON_AUTH_URL = "/mock-auth";' }));
    await page.goto(`http://127.0.0.1:${server.address().port}/app.html`, { waitUntil: 'domcontentloaded' });
  }
  try {
    await run(first, second);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

async function testSignOutClearsDurableAccountDataWithoutCrossAccountHydration() {
  await withPage(async page => {
    const observed = await page.evaluate(async () => {
      const accountA = { version: 'test', entities: { secretA: { name: 'Account A inventory' } } };
      const accountB = { version: 'test', entities: { secretB: { name: 'Account B inventory' } } };
      localStorage.setItem('elistlyData', JSON.stringify(accountA));
      localStorage.setItem('elistlyData:user:account-a', JSON.stringify(accountA));
      localStorage.setItem('elistlyData:userUpdated:account-a', '2026-09-17T00:00:00.000Z');
      Storage._cached = structuredClone(accountA);
      Storage._cachedUserId = 'account-a';

      await Storage.prepareForSignOut();
      const afterCleanup = Object.keys(localStorage).filter(key => key === 'elistlyData' || key.startsWith('elistlyData:user:') || key.startsWith('elistlyData:userUpdated:') || key.startsWith('elistlyData:outbox:'));
      const memoryAfterCleanup = { cached: Storage._cached, cachedUserId: Storage._cachedUserId };

      backendClient = { auth: {
        getUser: async () => ({ data: { user: { id: 'account-b' } } }),
        getSession: async () => ({ data: { session: { access_token: 'test-token' } } })
      } };
      window.ELISTLY_API_URL = '/mock';
      window.fetch = async () => new Response(JSON.stringify({ payload: accountB, updated_at: '2026-09-17T00:01:00.000Z' }), { status: 200 });
      const hydratedB = await Storage.getAppData();
      return { afterCleanup, memoryAfterCleanup, hydratedB };
    });

    assert.deepEqual(observed.afterCleanup, [], 'successful sign-out preparation must remove every durable inventory cache, revision, and outbox entry');
    assert.equal(observed.memoryAfterCleanup.cached, null, 'successful sign-out preparation must clear in-memory inventory');
    assert.equal(observed.memoryAfterCleanup.cachedUserId, null, 'successful sign-out preparation must clear the in-memory account binding');
    assert.deepEqual(observed.hydratedB, { version: 'test', entities: { secretB: { name: 'Account B inventory' } } }, 'account B must hydrate only its own remote inventory after account A signs out');
  });
}

async function testPendingEditsBlockSignOutInsteadOfBeingDiscarded() {
  await withPage(async page => {
    const observed = await page.evaluate(async () => {
      const pending = [{ id: 'pending', payload: { version: 'test', entities: { unsynced: true } } }];
      localStorage.setItem('elistlyData:outbox:account-a', JSON.stringify(pending));
      let error = null;
      try { await Storage.prepareForSignOut(); } catch (caught) { error = caught.message; }
      return { error, outbox: localStorage.getItem('elistlyData:outbox:account-a') };
    });
    assert.match(observed.error || '', /unsynced/i, 'sign-out must fail closed while any recoverable account edits remain local');
    assert.notEqual(observed.outbox, null, 'blocked sign-out must retain pending edits unchanged');
  });
}

async function testFailedLocalCleanupDoesNotClaimSignOutIsSafe() {
  await withPage(async page => {
    const observed = await page.evaluate(async () => {
      localStorage.setItem('elistlyData:user:account-a', JSON.stringify({ version: 'test', entities: { retained: true } }));
      const originalRemove = Storage._removeDurableKey;
      Storage._removeDurableKey = () => { throw new Error('storage unavailable'); };
      let error = null;
      try { await Storage.prepareForSignOut(); } catch (caught) { error = caught.message; }
      Storage._removeDurableKey = originalRemove;
      return { error, cache: localStorage.getItem('elistlyData:user:account-a') };
    });
    assert.equal(observed.error, 'Local account data could not be cleared. Sign out was not completed.', 'persistence failure must be reported rather than claiming cleanup');
    assert.notEqual(observed.cache, null, 'a failed cleanup must leave the account signed in and retained data visible to recovery, not falsely claim privacy');
  });
}

async function testFailedAuthSignOutIsReportedTruthfullyAfterCleanup() {
  await withPage(async page => {
    const observed = await page.evaluate(async () => {
      localStorage.setItem('elistlyData:user:account-a', JSON.stringify({ version: 'test', entities: { synced: true } }));
      const notices = [];
      const originalNotification = App.showNotification;
      App.showNotification = (message, kind) => notices.push({ message, kind });
      backendClient = { auth: { signOut: async () => ({ error: new Error('network unavailable') }) } };
      const result = await App.handleSignOut();
      App.showNotification = originalNotification;
      return { result, notices, retainedKeys: Object.keys(localStorage).filter(key => key.startsWith('elistlyData')) };
    });
    assert.equal(observed.result, false, 'a failed auth sign-out must not claim success');
    assert.deepEqual(observed.notices, [{ message: 'Sign out did not complete. Local account data was cleared; reload or try again before sharing this browser.', kind: 'error' }], 'a failed auth sign-out must explain the actual cleanup state');
    assert.deepEqual(observed.retainedKeys, [], 'the pre-auth cleanup must not leave plaintext account data behind when auth sign-out fails');
  });
}

async function testLateInventoryReadCannotUndoSignOutCleanup() {
  for (const background of [false, true]) {
    await withPage(async page => {
      const observed = await page.evaluate(async background => {
        backendClient = { auth: {
          getUser: async () => ({ data: { user: { id: 'account-a' } } }),
          getSession: async () => ({ data: { session: { access_token: 'test-token' } } })
        } };
        window.ELISTLY_API_URL = '/mock';
        let release, started;
        const waiting = new Promise(resolve => { started = resolve; });
        window.fetch = async () => {
          started();
          await new Promise(resolve => { release = resolve; });
          return new Response(JSON.stringify({ payload: { entities: { secret: true } }, updated_at: 'new' }));
        };
        let callbacks = 0;
        const loading = background
          ? Storage.syncRemoteInBackground('account-a', '', () => { callbacks += 1; })
          : Storage.getAppData().catch(() => null);
        await waiting;
        await Storage.prepareForSignOut();
        release();
        await loading;
        return { cached: Storage._cached, keys: Object.keys(localStorage).filter(key => key.startsWith('elistlyData')), callbacks };
      }, background);
      assert.equal(observed.cached, null, 'a late inventory response must not restore signed-out account memory');
      assert.deepEqual(observed.keys, [], 'a late inventory response must not recreate durable account data');
      assert.equal(observed.callbacks, 0, 'a late inventory response must not render signed-out inventory');
    });
  }
}

async function testSignOutInAnotherTabClearsStaleInMemoryInventory() {
  await withPages(async (first, second) => {
    await second.evaluate(() => {
      const accountA = { version: 'test', entities: { secretA: { name: 'Account A inventory' } } };
      localStorage.setItem('elistlyData:user:account-a', JSON.stringify(accountA));
      Storage._cached = structuredClone(accountA);
      Storage._cachedUserId = 'account-a';
      App.data = structuredClone(accountA);
    });

    await first.evaluate(() => Storage.prepareForSignOut());
    await second.waitForFunction(() => Storage._cached === null && Storage._cachedUserId === null);
    const staleState = await second.evaluate(() => ({
      cached: Storage._cached,
      cachedUserId: Storage._cachedUserId,
      entities: App.data.entities
    }));

    assert.equal(staleState.cached, null, 'a sign-out in another tab must clear stale in-memory inventory');
    assert.equal(staleState.cachedUserId, null, 'a sign-out in another tab must clear the stale account binding');
    assert.deepEqual(staleState.entities, {}, 'a sign-out in another tab must remove the signed-out account inventory from the receiving tab');
  });
}

async function run() {
  await testLateInventoryReadCannotUndoSignOutCleanup();
  await testSignOutInAnotherTabClearsStaleInMemoryInventory();
  await testSignOutClearsDurableAccountDataWithoutCrossAccountHydration();
  await testPendingEditsBlockSignOutInsteadOfBeingDiscarded();
  await testFailedLocalCleanupDoesNotClaimSignOutIsSafe();
  await testFailedAuthSignOutIsReportedTruthfullyAfterCleanup();
}

run().then(() => console.log('PASS sign-out privacy')).catch(error => {
  console.error(`FAIL sign-out privacy: ${error.stack || error.message}`);
  process.exitCode = 1;
});
