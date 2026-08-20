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
    if (!filePath.startsWith(`${root}${path.sep}`) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.end(fs.readFileSync(filePath));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function withPage(run) {
  const server = await startStaticServer();
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/app.html`, { waitUntil: 'domcontentloaded' });
    await run(page);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

async function testConflictPreservesDirtyLocalState() {
  await withPage(async page => {
    const observed = await page.evaluate(async () => {
      const base = { version: 'test', entities: { original: true } };
      const localEdit = { version: 'test', entities: { local: true } };
      localStorage.setItem('elistlyData', JSON.stringify(base));
      localStorage.setItem('elistlyData:user:user-1', JSON.stringify(base));
      localStorage.setItem('elistlyData:userUpdated:user-1', '2026-08-12T00:00:00.000Z');
      Storage._cached = structuredClone(base);
      Storage._cachedUserId = 'user-1';
      backendClient = {
        auth: {
          getUser: async () => ({ data: { user: { id: 'user-1' } } }),
          getSession: async () => ({ data: { session: { access_token: 'token' } } })
        }
      };
      window.ELISTLY_API_URL = '/mock';
      let request = null;
      window.fetch = async (_url, options) => {
        request = JSON.parse(options.body);
        return new Response(JSON.stringify({ error: 'App data changed since preview' }), { status: 409 });
      };
      let error = null;
      try {
        await Storage.setAppData(localEdit);
      } catch (caught) {
        error = caught.message;
      }
      return {
        request,
        error,
        cached: Storage._cached,
        revision: localStorage.getItem('elistlyData:userUpdated:user-1')
      };
    });

    assert.deepEqual(observed.request, {
      payload: { version: 'test', entities: { local: true } },
      expectedUpdatedAt: '2026-08-12T00:00:00.000Z'
    }, 'ordinary saves must send their base revision');
    assert.equal(observed.error, 'App data changed since preview', 'conflicts must be surfaced deterministically');
    assert.deepEqual(observed.cached, { version: 'test', entities: { local: true } }, 'conflicts must retain dirty in-memory data');
    assert.equal(observed.revision, '2026-08-12T00:00:00.000Z', 'conflicts must retain the base revision');
  });
}

async function testConflictNotificationKeepsTheEditorOpen() {
  await withPage(async page => {
    const observed = await page.evaluate(async () => {
      const notices = [];
      const originalSetAppData = Storage.setAppData;
      const originalNotification = App.showNotification;
      Storage.setAppData = async () => { throw new Error('App data changed since preview'); };
      App.showNotification = (message, kind) => notices.push({ message, kind });
      App.data = { version: 'test', settings: {}, categories: {}, entityTypes: {}, entities: {}, workspaces: {}, currentWorkspaceId: '' };
      App.saveData();
      await new Promise(resolve => setTimeout(resolve, 25));
      Storage.setAppData = originalSetAppData;
      App.showNotification = originalNotification;
      return { notices, data: App.data };
    });

    assert.deepEqual(observed.notices, [{
      message: 'Your changes were not saved because newer app data is available. Your local changes are still open.',
      kind: 'error'
    }], 'the client must report a revision conflict without discarding the active edit');
    assert.deepEqual(observed.data.entities, {}, 'the active in-memory editor data must remain available');
  });
}

async function testBackgroundSyncDoesNotReplaceDirtyData() {
  await withPage(async page => {
    const observed = await page.evaluate(async () => {
      const localEdit = { version: 'test', entities: { local: true } };
      const remote = { version: 'test', entities: { remote: true } };
      Storage._cached = structuredClone(localEdit);
      Storage._cachedUserId = 'user-1';
      Storage._isDirty = true;
      window.ELISTLY_API_URL = '/mock';
      window.fetch = async () => new Response(JSON.stringify({ payload: remote, updated_at: '2026-08-12T00:01:00.000Z' }), { status: 200 });
      let callbackCalls = 0;
      await Storage.syncRemoteInBackground('user-1', '2026-08-12T00:00:00.000Z', () => { callbackCalls += 1; });
      return { cached: Storage._cached, callbackCalls };
    });

    assert.deepEqual(observed.cached, { version: 'test', entities: { local: true } }, 'background hydration must not replace unsaved local data');
    assert.equal(observed.callbackCalls, 0, 'background hydration must not render remote data over an active edit');
  });
}

async function testOverlappingSavesUseTheRevisionAcknowledgedByThePreviousSave() {
  await withPage(async page => {
    const observed = await page.evaluate(async () => {
      const first = { version: 'test', entities: { first: true } };
      const second = { version: 'test', entities: { second: true } };
      localStorage.setItem('elistlyData:userUpdated:user-1', '2026-08-12T00:00:00.000Z');
      backendClient = {
        auth: {
          getUser: async () => ({ data: { user: { id: 'user-1' } } }),
          getSession: async () => ({ data: { session: { access_token: 'token' } } })
        }
      };
      window.ELISTLY_API_URL = '/mock';
      const requests = [];
      let finishFirst;
      window.fetch = (_url, options) => {
        requests.push(JSON.parse(options.body));
        if (requests.length === 1) return new Promise(resolve => { finishFirst = resolve; });
        return Promise.resolve(new Response(JSON.stringify({ payload: second, updated_at: '2026-08-12T00:02:00.000Z' }), { status: 200 }));
      };
      const firstSave = Storage.setAppData(first);
      const secondSave = Storage.setAppData(second);
      await new Promise(resolve => setTimeout(resolve, 10));
      const beforeFirstCompletes = requests.length;
      finishFirst(new Response(JSON.stringify({ payload: first, updated_at: '2026-08-12T00:01:00.000Z' }), { status: 200 }));
      await Promise.all([firstSave, secondSave]);
      return { beforeFirstCompletes, requests };
    });

    assert.equal(observed.beforeFirstCompletes, 1, 'overlapping saves must have one in-flight conditional write');
    assert.equal(observed.requests[1].expectedUpdatedAt, '2026-08-12T00:01:00.000Z', 'the next save must use the revision acknowledged by the previous save');
  });
}

async function testDelayedBackgroundHydrationCannotOverwriteAnAcknowledgedSave() {
  await withPage(async page => {
    const observed = await page.evaluate(async () => {
      const cached = { version: 'test', entities: { cached: true } };
      const localEdit = { version: 'test', entities: { local: true } };
      const staleRemote = { version: 'test', entities: { staleRemote: true } };
      localStorage.setItem('elistlyData:user:user-1', JSON.stringify(cached));
      localStorage.setItem('elistlyData:userUpdated:user-1', '2026-08-12T00:00:00.000Z');
      backendClient = {
        auth: {
          getUser: async () => ({ data: { user: { id: 'user-1' } } }),
          getSession: async () => ({ data: { session: { access_token: 'token' } } })
        }
      };
      window.ELISTLY_API_URL = '/mock';
      let finishBackgroundRead;
      let requests = 0;
      window.fetch = (_url, options = {}) => {
        requests += 1;
        if ((options.method || 'GET') === 'GET') return new Promise(resolve => { finishBackgroundRead = resolve; });
        return Promise.resolve(new Response(JSON.stringify({ payload: localEdit, updated_at: '2026-08-12T00:02:00.000Z' }), { status: 200 }));
      };
      await Storage.getAppData();
      await Storage.setAppData(localEdit);
      finishBackgroundRead(new Response(JSON.stringify({ payload: staleRemote, updated_at: '2026-08-12T00:01:00.000Z' }), { status: 200 }));
      await new Promise(resolve => setTimeout(resolve, 10));
      return {
        requests,
        cached: Storage._cached,
        revision: localStorage.getItem('elistlyData:userUpdated:user-1')
      };
    });

    assert.equal(observed.requests, 2, 'the delayed read and local save must both reach the persistence boundary');
    assert.deepEqual(observed.cached, { version: 'test', entities: { local: true } }, 'a delayed remote read must not roll back an acknowledged local save');
    assert.equal(observed.revision, '2026-08-12T00:02:00.000Z', 'a delayed remote read must not roll back the acknowledged revision');
  });
}

async function testFailedSavePersistsItsOutboxEntryForReloadWithoutHydration() {
  await withPage(async page => {
    const observed = await page.evaluate(async () => {
      const localEdit = { version: 'test', entities: { local: true } };
      backendClient = {
        auth: {
          getUser: async () => ({ data: { user: { id: 'user-1' } } }),
          getSession: async () => ({ data: { session: { access_token: 'token' } } })
        }
      };
      window.ELISTLY_API_URL = '/mock';
      let requests = 0;
      window.fetch = async () => {
        requests += 1;
        throw new Error('offline');
      };
      try { await Storage.setAppData(localEdit); } catch (_) {}
      Storage._cached = null;
      Storage._cachedUserId = null;
      Storage._isDirty = false;
      const reloaded = await Storage.getAppData();
      return {
        outbox: JSON.parse(localStorage.getItem('elistlyData:outbox:user-1')),
        reloaded,
        requests,
        status: Storage.getSyncStatus()
      };
    });

    assert.equal(observed.outbox.length, 1, 'a failed write must remain in the durable outbox');
    assert.deepEqual(observed.reloaded, { version: 'test', entities: { local: true } }, 'reload must restore queued local data');
    assert.equal(observed.requests, 1, 'reload must not hydrate over queued local data');
    assert.deepEqual(observed.status, { state: 'pending', message: 'Changes are waiting to sync.' }, 'queued local data must report pending sync status');
  });
}

async function testRetryClearsOnlyAcknowledgedOutboxEntryAndAdvancesRevision() {
  await withPage(async page => {
    const observed = await page.evaluate(async () => {
      const first = { version: 'test', entities: { first: true } };
      const second = { version: 'test', entities: { second: true } };
      localStorage.setItem('elistlyData:userUpdated:user-1', '2026-08-12T00:00:00.000Z');
      localStorage.setItem('elistlyData:outbox:user-1', JSON.stringify([
        { id: 'first', payload: first },
        { id: 'second', payload: second }
      ]));
      backendClient = {
        auth: {
          getUser: async () => ({ data: { user: { id: 'user-1' } } }),
          getSession: async () => ({ data: { session: { access_token: 'token' } } })
        }
      };
      window.ELISTLY_API_URL = '/mock';
      window.fetch = async () => new Response(JSON.stringify({ payload: first, updated_at: '2026-08-12T00:01:00.000Z' }), { status: 200 });
      await Storage.retryPendingSaves();
      return {
        outbox: JSON.parse(localStorage.getItem('elistlyData:outbox:user-1')),
        revision: localStorage.getItem('elistlyData:userUpdated:user-1'),
        status: Storage.getSyncStatus()
      };
    });

    assert.deepEqual(observed.outbox, [{ id: 'second', payload: { version: 'test', entities: { second: true } } }], 'retry must clear only the acknowledged entry');
    assert.equal(observed.revision, '2026-08-12T00:01:00.000Z', 'successful retry must advance the cached revision');
    assert.equal(observed.status.state, 'pending', 'remaining queued changes must remain visible as pending');
  });
}

async function testConcurrentReconnectsSerializeOnePendingReplay() {
  await withPage(async page => {
    const observed = await page.evaluate(async () => {
      const localEdit = { version: 'test', entities: { local: true } };
      localStorage.setItem('elistlyData:userUpdated:user-1', '2026-08-12T00:00:00.000Z');
      localStorage.setItem('elistlyData:outbox:user-1', JSON.stringify([{ id: 'pending', payload: localEdit }]));
      backendClient = {
        auth: {
          getUser: async () => ({ data: { user: { id: 'user-1' } } }),
          getSession: async () => ({ data: { session: { access_token: 'token' } } })
        }
      };
      window.ELISTLY_API_URL = '/mock';
      const requests = [];
      let finishSave;
      window.fetch = (_url, options) => {
        requests.push(JSON.parse(options.body));
        return new Promise(resolve => { finishSave = resolve; });
      };
      const firstReplay = Storage.retryPendingSaves();
      const secondReplay = Storage.retryPendingSaves();
      await new Promise(resolve => setTimeout(resolve, 10));
      const beforeAcknowledgement = requests.length;
      finishSave(new Response(JSON.stringify({ payload: localEdit, updated_at: '2026-08-12T00:01:00.000Z' }), { status: 200 }));
      await Promise.all([firstReplay, secondReplay]);
      return { beforeAcknowledgement, requests, outbox: JSON.parse(localStorage.getItem('elistlyData:outbox:user-1')) };
    });

    assert.equal(observed.beforeAcknowledgement, 1, 'concurrent reconnect signals must send one conditional replay at a time');
    assert.equal(observed.requests.length, 1, 'the acknowledged pending entry must not be replayed twice');
    assert.deepEqual(observed.outbox, [], 'the one acknowledged replay must clear the durable entry');
  });
}

async function testOnlineReconnectRetriesPendingSave() {
  await withPage(async page => {
    const observed = await page.evaluate(async () => {
      const localEdit = { version: 'test', entities: { local: true } };
      localStorage.setItem('elistlyData:userUpdated:user-1', '2026-08-12T00:00:00.000Z');
      localStorage.setItem('elistlyData:outbox:user-1', JSON.stringify([{ id: 'pending', payload: localEdit }]));
      backendClient = {
        auth: {
          getUser: async () => ({ data: { user: { id: 'user-1' } } }),
          getSession: async () => ({ data: { session: { access_token: 'token' } } })
        }
      };
      window.ELISTLY_API_URL = '/mock';
      let requests = 0;
      window.fetch = async () => {
        requests += 1;
        return new Response(JSON.stringify({ payload: localEdit, updated_at: '2026-08-12T00:01:00.000Z' }), { status: 200 });
      };
      window.dispatchEvent(new Event('online'));
      await new Promise(resolve => setTimeout(resolve, 20));
      return { requests, outbox: JSON.parse(localStorage.getItem('elistlyData:outbox:user-1')), revision: localStorage.getItem('elistlyData:userUpdated:user-1') };
    });

    assert.equal(observed.requests, 1, 'reconnect must retry a pending durable save');
    assert.deepEqual(observed.outbox, [], 'a reconnect acknowledgement must clear the durable outbox entry');
    assert.equal(observed.revision, '2026-08-12T00:01:00.000Z', 'a reconnect acknowledgement must advance the cached revision');
  });
}

async function testMalformedOutboxFailsSafely() {
  await withPage(async page => {
    const observed = await page.evaluate(() => {
      localStorage.setItem('elistlyData:outbox:user-1', '{not-json');
      return { outbox: Storage._readOutbox('user-1'), persisted: localStorage.getItem('elistlyData:outbox:user-1'), status: Storage.getSyncStatus() };
    });

    assert.deepEqual(observed.outbox, [], 'malformed outbox data must not be used as a save request');
    assert.equal(observed.persisted, null, 'malformed outbox data must be removed rather than retried');
    assert.equal(observed.status.state, 'failed', 'malformed outbox data must be visible as a failure');
  });
}

async function testSyncStatusIsAccessibleInTheApplication() {
  await withPage(async page => {
    const observed = await page.evaluate(() => {
      Storage._setSyncStatus('failed', 'Changes could not be synced. Local changes are retained.');
      const status = document.getElementById('syncStatus');
      return status && { text: status.textContent, state: status.dataset.state, live: status.getAttribute('aria-live') };
    });

    assert.deepEqual(observed, {
      text: 'Changes could not be synced. Local changes are retained.',
      state: 'failed',
      live: 'polite'
    }, 'sync failure must have an accessible, truthful status');
  });
}

async function testRemoteHydrationRetainsUnknownTopLevelAccountData() {
  await withPage(async page => {
    const observed = await page.evaluate(() => {
      App.data = {
        version: 'test', settings: {}, categories: {}, entityTypes: {}, entities: {},
        workspaces: { default: { name: 'Default', categories: {}, entityTypes: {}, entities: {} } }, currentWorkspaceId: 'default'
      };
      App.applyRemoteSyncData({
        version: 'test', settings: {},
        workspaces: { default: { name: 'Default', categories: {}, entityTypes: {}, entities: {} } }, currentWorkspaceId: 'default',
        retainedTopLevelMarker: 'must-survive-hydration'
      });
      return App.data.retainedTopLevelMarker;
    });
    assert.equal(observed, 'must-survive-hydration', 'account hydration must retain unknown authoritative top-level fields');
  });
}

async function testImportAcknowledgementAcceptsEquivalentJsonObjectOrder() {
  await withPage(async page => {
    const observed = await page.evaluate(async () => {
      const candidate = { version: 'test', settings: { view: 'list', retained: true }, workspaces: { default: { name: 'Default', categories: {}, entityTypes: {}, entities: {} } }, currentWorkspaceId: 'default' };
      const acknowledged = { currentWorkspaceId: 'default', workspaces: { default: { entities: {}, entityTypes: {}, categories: {}, name: 'Default' } }, settings: { retained: true, view: 'list' }, version: 'test' };
      backendClient = { auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }), getSession: async () => ({ data: { session: { access_token: 'token' } } }) } };
      window.ELISTLY_API_URL = '/mock';
      Storage._cachedUserId = 'user-1';
      window.fetch = async () => new Response(JSON.stringify({ payload: acknowledged, updated_at: '2026-08-20T00:00:00.000Z' }), { status: 200 });
      await Storage.setAppDataForImport(candidate, { userId: 'user-1', accessToken: 'token', expectedUpdatedAt: null });
      return Storage._cached;
    });
    assert.deepEqual(observed, { version: 'test', settings: { view: 'list', retained: true }, workspaces: { default: { name: 'Default', categories: {}, entityTypes: {}, entities: {} } }, currentWorkspaceId: 'default' }, 'a semantically identical JSON acknowledgement must complete the import');
  });
}

async function run() {
  await testConflictPreservesDirtyLocalState();
  await testConflictNotificationKeepsTheEditorOpen();
  await testBackgroundSyncDoesNotReplaceDirtyData();
  await testOverlappingSavesUseTheRevisionAcknowledgedByThePreviousSave();
  await testDelayedBackgroundHydrationCannotOverwriteAnAcknowledgedSave();
  await testFailedSavePersistsItsOutboxEntryForReloadWithoutHydration();
  await testRetryClearsOnlyAcknowledgedOutboxEntryAndAdvancesRevision();
  await testConcurrentReconnectsSerializeOnePendingReplay();
  await testOnlineReconnectRetriesPendingSave();
  await testMalformedOutboxFailsSafely();
  await testSyncStatusIsAccessibleInTheApplication();
  await testRemoteHydrationRetainsUnknownTopLevelAccountData();
  await testImportAcknowledgementAcceptsEquivalentJsonObjectOrder();
}

run()
  .then(() => console.log('PASS revision persistence'))
  .catch(error => {
    console.error(`FAIL revision persistence: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
