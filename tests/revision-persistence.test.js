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

Promise.all([testConflictPreservesDirtyLocalState(), testConflictNotificationKeepsTheEditorOpen(), testBackgroundSyncDoesNotReplaceDirtyData()])
  .then(() => console.log('PASS revision persistence'))
  .catch(error => {
    console.error(`FAIL revision persistence: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
