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

async function withPage(run, setup) {
  const server = await startStaticServer();
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.route('**/config.js', route => route.fulfill({ contentType: 'application/javascript', body: 'window.ELISTLY_API_URL = "https://api.elistly.test"; window.NEON_AUTH_URL = "/mock-auth";' }));
  try {
    if (setup) await setup(page);
    await page.goto(`http://127.0.0.1:${server.address().port}/app.html`, { waitUntil: 'domcontentloaded' });
    return await run(page);
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
      let error;
      try { Storage._readOutbox('user-1'); } catch (caught) { error = caught.message; }
      return { error, persisted: localStorage.getItem('elistlyData:outbox:user-1'), status: Storage.getSyncStatus() };
    });

    assert.match(observed.error || '', /retained/, 'unreadable pending changes must stop the caller instead of looking like an empty queue');
    assert.equal(observed.persisted, '{not-json', 'unreadable pending changes must remain available for recovery');
    assert.equal(observed.status.state, 'failed', 'malformed outbox data must be visible as a failure');
  });
}

async function testAcknowledgementPreservesEditsQueuedDuringSave() {
  await withPage(async page => {
    const observed = await page.evaluate(async () => {
      backendClient = { auth: {
        getUser: async () => ({ data: { user: { id: 'queue-user' } } }),
        getSession: async () => ({ data: { session: { access_token: 'test-token' } } })
      } };
      window.ELISTLY_API_URL = '/mock';
      let release, started;
      const waiting = new Promise(resolve => { started = resolve; });
      const requests = [];
      window.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        if (requests.length === 1) {
          started();
          await new Promise(resolve => { release = resolve; });
        }
        return new Response(JSON.stringify({ updated_at: `revision-${requests.length}` }), { status: 200 });
      };
      const first = Storage.setAppData({ entities: { first: true } });
      await waiting;
      const second = Storage.setAppData({ entities: { second: true } });
      await Promise.resolve();
      await Promise.resolve();
      release();
      await Promise.all([first, second]);
      return { requests, cache: Storage._readUserCache('queue-user'), outbox: Storage._readOutbox('queue-user') };
    });
    assert.equal(observed.requests.length, 2, 'acknowledging an older save must not silently discard a newer queued edit');
    assert.deepEqual(observed.requests[1], { payload: { entities: { second: true } }, expectedUpdatedAt: 'revision-1' });
    assert.deepEqual(observed.cache, { entities: { second: true } });
    assert.deepEqual(observed.outbox, []);
  });
}

async function testFailedAccountHydrationDoesNotStartAnEmptyAccount() {
  await withPage(async page => {
    const observed = await page.evaluate(async () => {
      backendClient = {
        auth: {
          getUser: async () => ({ data: { user: { id: 'user-1' } } }),
          getSession: async () => ({ data: { session: { access_token: 'token', user: { id: 'user-1' } } } })
        }
      };
      window.ELISTLY_API_URL = '/mock';
      let writes = 0;
      window.fetch = async (_url, options = {}) => {
        if ((options.method || 'GET') === 'PUT') writes += 1;
        return new Response(JSON.stringify({ error: 'Service unavailable' }), { status: 503 });
      };
      Storage._cached = null;
      Storage._cachedUserId = null;
      Storage._isDirty = false;
      let error = null;
      try { await Storage.getAppData(); } catch (caught) { error = caught.message; }
      return {
        error,
        writes,
        cache: localStorage.getItem('elistlyData:user:user-1'),
        outbox: localStorage.getItem('elistlyData:outbox:user-1'),
        status: Storage.getSyncStatus()
      };
    });

    assert.match(observed.error || '', /Service unavailable/, 'a failed account read must reject instead of looking like an empty account');
    assert.equal(observed.writes, 0, 'failed hydration must never issue an empty-account write');
    assert.equal(observed.cache, null, 'failed hydration must not create an empty account cache');
    assert.equal(observed.outbox, null, 'failed hydration must not create an empty-account outbox entry');
    assert.equal(observed.status.state, 'failed', 'failed hydration must be visible instead of being reported as synced');
  });
}

async function testFailedBackgroundHydrationPreservesCachedData() {
  await withPage(async page => {
    const observed = await page.evaluate(async () => {
      const cached = { version: 'test', entities: { retained: true } };
      localStorage.setItem('elistlyData:user:user-1', JSON.stringify(cached));
      localStorage.setItem('elistlyData:outbox:user-1', JSON.stringify([{ id: 'pending', payload: cached }]));
      window.ELISTLY_API_URL = '/mock';
      window.fetch = async () => new Response(JSON.stringify({ error: 'Service unavailable' }), { status: 503 });
      Storage._cached = structuredClone(cached);
      Storage._cachedUserId = 'user-1';
      Storage._isDirty = false;
      await Storage.syncRemoteInBackground('user-1', '2026-08-12T00:00:00.000Z');
      return {
        cache: JSON.parse(localStorage.getItem('elistlyData:user:user-1')),
        outbox: JSON.parse(localStorage.getItem('elistlyData:outbox:user-1')),
        status: Storage.getSyncStatus()
      };
    });

    assert.deepEqual(observed.cache, { version: 'test', entities: { retained: true } }, 'failed background hydration must preserve the account cache');
    assert.deepEqual(observed.outbox, [{ id: 'pending', payload: { version: 'test', entities: { retained: true } } }], 'failed background hydration must preserve the durable outbox');
    assert.equal(observed.status.state, 'failed', 'failed background hydration must be visible rather than silently ignored');
  });
}

async function testHealthySyncStatusIsHiddenWhileFailuresRemainAccessible() {
  await withPage(async page => {
    const observed = await page.evaluate(() => {
      Storage._setSyncStatus('synced', 'Changes are synced.');
      const status = document.getElementById('syncStatus');
      const healthy = { hidden: status.hidden, text: status.textContent, state: status.dataset.state };
      Storage._setSyncStatus('failed', 'Changes could not be synced. Local changes are retained.');
      return { healthy, failed: { hidden: status.hidden, text: status.textContent, state: status.dataset.state, live: status.getAttribute('aria-live') } };
    });

    assert.deepEqual(observed.healthy, { hidden: true, text: '', state: 'synced' }, 'healthy sync must be quiet rather than permanently claiming success');
    assert.deepEqual(observed.failed, {
      hidden: false,
      text: 'Changes could not be synced. Local changes are retained.',
      state: 'failed',
      live: 'polite'
    }, 'sync failures must remain compact, visible, and announced accessibly');
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

async function testWorkspaceOnlyAccountDataSurvivesInitNamingSaveAndReload() {
  const saved = {
    version: '1.12.1', settings: { defaultView: 'dashboard', fontSize: 'normal' },
    // Simulate the historical stale top-level projection: the workspace is
    // authoritative, but its old mirror no longer has categories or types.
    categories: {}, entityTypes: {}, entities: {},
    workspaces: {
      default: {
        name: 'Default',
        categories: { hardware: { id: 'hardware', label: 'Hardware', enabled: true } },
        entityTypes: {
          computer: {
            id: 'computer', label: 'Computer', icon: 'computer', enabled: true,
            categories: ['hardware'], fields: [{ name: 'serial', label: 'Serial', type: 'text', partOfName: true }], associations: [],
            enableNameGen: true,
            nameGen: { prefixEnabled: true, prefix: 'PC-', partOfNamePrefix: true, suffixType: 'number', componentsOrder: [{ type: 'field', name: 'serial' }] }
          }
        },
        entities: {
          'computer-1': { id: 'computer-1', type: 'computer', serial: '001', autoName: 'PC-001', notes: 'first saved computer' },
          'computer-2': { id: 'computer-2', type: 'computer', serial: '002', autoName: 'PC-002', notes: 'second saved computer' }
        }
      }
    },
    currentWorkspaceId: 'default', onboardingDone: true
  };
  let remote = structuredClone(saved);
  let writes = [];
  const token = `x.${Buffer.from(JSON.stringify({ sub: 'user-1', exp: 4102444800 })).toString('base64url')}.x`;

  await withPage(async page => {
    await page.waitForFunction(() => window.App && App._isReady);
    const afterHydration = await page.evaluate(() => structuredClone(App.data));
    const savedWrite = page.waitForResponse(response => response.url().endsWith('/app-data') && response.request().method() === 'PUT');
    await page.evaluate(() => {
      const form = document.createElement('form');
      form.innerHTML = `
        <input name="label" value="Computer">
        <input name="icon" value="computer">
        <input name="category_hardware" type="checkbox" checked>
        <input name="enableNameGen" type="checkbox" checked>
        <input name="prefixEnabled" type="checkbox" checked>
        <input name="namePrefix" value="WORKSTATION-">
        <input name="suffixType" value="number">
        <input name="fields[0].name" value="serial">
        <input name="fields[0].label" value="Serial">
        <input name="fields[0].type" value="text">
        <input name="fields[0].partOfName" type="checkbox" checked>
        <div id="nameComponentsList"><div class="name-component-item" data-component-type="field" data-field-name="serial"></div></div>`;
      App.saveEntityType({ preventDefault() {}, target: form }, 'computer');
    });
    await savedWrite;
    await page.waitForFunction(() => !Storage._isDirty && Storage._readOutbox('user-1').length === 0);
    const persistedAfterNamingSave = structuredClone(remote);

    // A real page reload with no account cache must fetch the saved remote data.
    await page.evaluate(() => {
      localStorage.removeItem('elistlyData');
      localStorage.removeItem('elistlyData:user:user-1');
      localStorage.removeItem('elistlyData:userUpdated:user-1');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.App && App._isReady);
    const afterReload = await page.evaluate(() => structuredClone(App.data));
    return { afterHydration, persistedAfterNamingSave, afterReload };
  }, async page => {
    await page.addInitScript(fakeToken => localStorage.setItem('elistly_token', fakeToken), token);
    await page.route('https://api.elistly.test/**', async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/admin/me') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ admin: false }) });
      if (pathname !== '/app-data') return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) });
      if (request.method() === 'PUT') {
        remote = request.postDataJSON().payload;
        writes.push(structuredClone(remote));
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ payload: remote, updated_at: `2026-09-15T00:00:0${writes.length}.000Z` }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ payload: remote, updated_at: '2026-09-15T00:00:00.000Z' }) });
    });
  }).then(observed => {
    for (const snapshot of [observed.afterHydration, observed.persistedAfterNamingSave, observed.afterReload]) {
      assert.deepEqual(Object.keys(snapshot.entities).sort(), ['computer-1', 'computer-2'], 'workspace-only saved device IDs must survive remote hydration, naming save, and browser reload');
      assert.equal(snapshot.entities['computer-1'].autoName, 'PC-001', 'saved generated names must remain prospective');
      assert.equal(snapshot.entities['computer-2'].notes, 'second saved computer', 'saved device fields must not be discarded');
    }
    assert.equal(observed.afterReload.entityTypes.computer.nameGen.prefix, 'WORKSTATION-', 'the changed naming configuration must persist across browser reload');
    assert.equal(observed.afterReload.entityTypes.computer.categories[0], 'hardware', 'the saved type category must remain attached');
    assert.ok(writes.length >= 1, 'the naming save must issue a complete workspace write');
    assert.ok(writes.every(payload => Object.keys(payload.entities || {}).length === 2), 'no naming-save write may replace saved device IDs with an empty workspace');
  });
}

async function testEmptyActiveWorkspaceHydratesInactiveWorkspaceAndAccountSettings() {
  const saved = {
    version: '1.12.1',
    settings: { defaultView: 'dashboard', fontSize: 'normal', dashboard: { viewMode: 'list' } },
    accountLevelMarker: 'retain-empty-active-account',
    categories: {}, entityTypes: {}, entities: {},
    workspaces: {
      default: { name: 'Empty current', categories: {}, entityTypes: {}, entities: {} },
      archive: {
        name: 'Archived inventory',
        categories: { records: { id: 'records', label: 'Records', enabled: true } },
        entityTypes: { record: { id: 'record', label: 'Record', enabled: true, categories: ['records'], fields: [], associations: [] } },
        entities: { 'record-7': { id: 'record-7', type: 'record', autoName: 'Archived record', retainedField: 'must-survive' } }
      }
    },
    currentWorkspaceId: 'default', onboardingDone: true
  };
  let remote = structuredClone(saved);
  const writes = [];
  const token = `x.${Buffer.from(JSON.stringify({ sub: 'empty-active-user', exp: 4102444800 })).toString('base64url')}.x`;

  const observed = await withPage(async page => {
    await page.waitForFunction(() => window.App && App._isReady);
    const hydrated = await page.evaluate(() => structuredClone(App.data));
    const save = page.waitForResponse(response => response.url().endsWith('/app-data') && response.request().method() === 'PUT');
    await page.evaluate(() => App.setFontSizeStep(1));
    await save;
    await page.waitForFunction(() => !Storage._isDirty && Storage._readOutbox('empty-active-user').length === 0);
    await page.evaluate(() => {
      localStorage.removeItem('elistlyData');
      localStorage.removeItem('elistlyData:user:empty-active-user');
      localStorage.removeItem('elistlyData:userUpdated:empty-active-user');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.App && App._isReady);
    return { hydrated, persisted: structuredClone(remote), reloaded: await page.evaluate(() => structuredClone(App.data)) };
  }, async page => {
    await page.addInitScript(fakeToken => localStorage.setItem('elistly_token', fakeToken), token);
    await page.route('https://api.elistly.test/**', async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/admin/me') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ admin: false }) });
      if (pathname !== '/app-data') return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) });
      if (request.method() === 'PUT') {
        remote = request.postDataJSON().payload;
        writes.push(structuredClone(remote));
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ payload: remote, updated_at: `2026-09-15T00:10:0${writes.length}.000Z` }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ payload: remote, updated_at: '2026-09-15T00:10:00.000Z' }) });
    });
  });

  for (const snapshot of [observed.hydrated, observed.persisted, observed.reloaded]) {
    assert.equal(snapshot.accountLevelMarker, 'retain-empty-active-account', 'an existing empty active workspace must still hydrate account-level data');
    assert.equal(snapshot.workspaces.archive.name, 'Archived inventory', 'inactive workspace metadata must survive active-workspace settings saves');
    assert.deepEqual(Object.keys(snapshot.workspaces.archive.entities), ['record-7'], 'inactive workspace entity IDs must survive active-workspace settings saves');
    assert.equal(snapshot.workspaces.archive.entities['record-7'].retainedField, 'must-survive', 'inactive workspace entity fields must survive active-workspace settings saves');
  }
  assert.equal(observed.reloaded.settings.fontSize, 'large', 'the active workspace settings save must persist across a remote-only reload');
  assert.ok(writes.length >= 1, 'the settings change must be saved');
  for (const payload of writes) {
    assert.equal(payload.accountLevelMarker, saved.accountLevelMarker, 'every write must preserve account metadata');
    assert.deepEqual(payload.workspaces.archive, saved.workspaces.archive, 'every write must preserve the entire inactive inventory');
  }
}

async function testLegacyDetachedTypeCategorySurvivesWorkspaceHydration() {
  await withPage(async page => {
    const observed = await page.evaluate(async () => {
      const saved = {
        version: '1.12.1', settings: {}, categories: {}, entityTypes: {}, entities: {},
        workspaces: {
          default: {
            name: 'Default',
            categories: { hardware: { id: 'hardware', label: 'Hardware', enabled: true } },
            // 0ebf314 stopped this from happening on future saves. Do not infer
            // or restore a category for pre-existing detached type records.
            entityTypes: { computer: { id: 'computer', label: 'Computer', icon: 'computer', enabled: true, categories: [], fields: [], associations: [] } },
            entities: { 'computer-legacy': { id: 'computer-legacy', type: 'computer', autoName: 'PC-LEGACY' } }
          }
        },
        currentWorkspaceId: 'default', onboardingDone: true
      };
      localStorage.clear();
      localStorage.setItem('elistlyData:user:user-legacy', JSON.stringify(saved));
      localStorage.setItem('elistlyData:userUpdated:user-legacy', '2026-09-15T00:00:00.000Z');
      Storage._cached = null;
      Storage._cachedUserId = null;
      Storage._isDirty = false;
      Storage._saveChains = {};
      backendClient = { auth: {
        getUser: async () => ({ data: { user: { id: 'user-legacy' } } }),
        getSession: async () => ({ data: { session: { access_token: 'token', user: { id: 'user-legacy' } } } })
      } };
      window.ELISTLY_API_URL = '/mock';
      window.fetch = async url => String(url).endsWith('/admin/me')
        ? new Response(JSON.stringify({ admin: false }), { status: 200 })
        : new Response(JSON.stringify({ payload: saved, updated_at: '2026-09-15T00:00:00.000Z' }), { status: 200 });
      App.renderSidebar = () => {};
      App.loadView = () => {};
      App.buildIconGrid = () => {};
      App.setupEventListeners = () => {};
      App.setupMobileNav = () => {};
      App.initProfileDropdown = async () => {};
      await App.init();
      const hydrated = structuredClone(App.data);
      Storage._cached = null;
      Storage._cachedUserId = null;
      Storage._isDirty = false;
      Storage._saveChains = {};
      await App.init();
      return { hydrated, reloaded: structuredClone(App.data) };
    });
    for (const snapshot of [observed.hydrated, observed.reloaded]) {
      assert.deepEqual(Object.keys(snapshot.entities), ['computer-legacy'], 'a legacy detached type must not erase its saved devices');
      assert.deepEqual(snapshot.entityTypes.computer.categories, [], 'a legacy detached type must not be guessed or reassigned');
    }
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

async function testFullBackupRestoreDoesNotReplaceAQueuedLocalChange() {
  await withPage(async page => {
    const observed = await page.evaluate(async () => {
      const pending = { version: 'test', settings: { view: 'list' }, workspaces: { default: { name: 'Default', categories: {}, entityTypes: {}, entities: {} } }, currentWorkspaceId: 'default', marker: 'pending-local-edit' };
      const backup = { version: 'test', settings: { view: 'grid' }, workspaces: { restored: { name: 'Restored', categories: {}, entityTypes: {}, entities: {} } }, currentWorkspaceId: 'restored', marker: 'backup' };
      localStorage.setItem('elistlyData:user:user-1', JSON.stringify(pending));
      localStorage.setItem('elistlyData:userUpdated:user-1', '2026-08-12T00:00:00.000Z');
      localStorage.setItem('elistlyData:outbox:user-1', JSON.stringify([{ id: 'pending', payload: pending }]));
      Storage._cached = structuredClone(pending);
      Storage._cachedUserId = 'user-1';
      Storage._isDirty = true;
      backendClient = { auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }), getSession: async () => ({ data: { session: { access_token: 'token' } } }) } };
      window.ELISTLY_API_URL = '/mock';
      let requests = 0;
      window.fetch = async () => {
        requests += 1;
        return new Response(JSON.stringify({ payload: backup, updated_at: '2026-08-12T00:01:00.000Z' }), { status: 200 });
      };
      let error = null;
      try {
        await Storage.setAppDataForImport(backup, { userId: 'user-1', accessToken: 'token', expectedUpdatedAt: '2026-08-12T00:00:00.000Z' });
      } catch (caught) {
        error = caught.message;
      }
      return {
        error,
        requests,
        cached: Storage._cached,
        outbox: JSON.parse(localStorage.getItem('elistlyData:outbox:user-1')),
        revision: localStorage.getItem('elistlyData:userUpdated:user-1')
      };
    });

    assert.equal(observed.error, 'Unsynced local changes must be synced or resolved before restoring a full backup.');
    assert.equal(observed.requests, 0, 'restore must not remotely replace account data while a local change is queued');
    assert.deepEqual(observed.cached, { version: 'test', settings: { view: 'list' }, workspaces: { default: { name: 'Default', categories: {}, entityTypes: {}, entities: {} } }, currentWorkspaceId: 'default', marker: 'pending-local-edit' }, 'restore rejection must retain the local edit in memory');
    assert.deepEqual(observed.outbox, [{ id: 'pending', payload: { version: 'test', settings: { view: 'list' }, workspaces: { default: { name: 'Default', categories: {}, entityTypes: {}, entities: {} } }, currentWorkspaceId: 'default', marker: 'pending-local-edit' } }], 'restore rejection must retain the durable pending local change');
    assert.equal(observed.revision, '2026-08-12T00:00:00.000Z', 'restore rejection must retain the revision that protects the queued local change');
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
  await testAcknowledgementPreservesEditsQueuedDuringSave();
  await testFailedAccountHydrationDoesNotStartAnEmptyAccount();
  await testFailedBackgroundHydrationPreservesCachedData();
  await testHealthySyncStatusIsHiddenWhileFailuresRemainAccessible();
  await testSyncStatusIsAccessibleInTheApplication();
  await testRemoteHydrationRetainsUnknownTopLevelAccountData();
  await testWorkspaceOnlyAccountDataSurvivesInitNamingSaveAndReload();
  await testEmptyActiveWorkspaceHydratesInactiveWorkspaceAndAccountSettings();
  await testLegacyDetachedTypeCategorySurvivesWorkspaceHydration();
  await testImportAcknowledgementAcceptsEquivalentJsonObjectOrder();
  await testFullBackupRestoreDoesNotReplaceAQueuedLocalChange();
}

run()
  .then(() => console.log('PASS revision persistence'))
  .catch(error => {
    console.error(`FAIL revision persistence: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
