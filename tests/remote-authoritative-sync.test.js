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

async function configureAccount(page, fetch) {
  await page.evaluate(() => {
    backendClient = { auth: {
      getUser: async () => ({ data: { user: { id: 'account-a' } } }),
      getSession: async () => ({ data: { session: { access_token: 'test-token' }, error: null } })
    } };
    window.ELISTLY_API_URL = '/mock';
  });
  await page.evaluate(fetch);
}

async function testRemoteSnapshotBootstrapsWithoutDiscardingDivergentPendingEdits() {
  await withPage(async page => {
    await configureAccount(page, () => {
      window.fetch = async () => new Response(JSON.stringify({ payload: { version: 'test', entities: { server: { name: 'Server record' } } }, updated_at: '2026-09-17T06:11:53.746204Z' }), { status: 200 });
    });
    const observed = await page.evaluate(async () => {
      const local = { version: 'test', entities: { local: { name: 'Offline record' } } };
      localStorage.setItem('elistlyData:outbox:account-a', JSON.stringify([{ id: 'offline', payload: local, expectedUpdatedAt: null }]));
      const data = await Storage.getAppData();
      return { data, outbox: JSON.parse(localStorage.getItem('elistlyData:outbox:account-a')), conflict: Storage.getConflictRecovery(), sync: Storage.getSyncStatus() };
    });
    assert.deepEqual(observed.data.entities, { server: { name: 'Server record' } }, 'the remote snapshot must be the startup inventory when a remote account exists');
    assert.deepEqual(observed.outbox[0].payload.entities, { local: { name: 'Offline record' } }, 'the local pending snapshot must remain durable for explicit recovery');
    assert.deepEqual(observed.conflict.localPayload.entities, { local: { name: 'Offline record' } }, 'recovery must expose the preserved local snapshot');
    assert.deepEqual(observed.conflict.remotePayload.entities, { server: { name: 'Server record' } }, 'recovery must identify the authoritative remote snapshot');
    assert.equal(observed.sync.state, 'conflict', 'divergence must be visible instead of pretending it will safely sync');
  });
}

async function testOfflinePendingEditsRemainTheStartupInventoryWhenRemoteCannotBeRead() {
  await withPage(async page => {
    await configureAccount(page, () => { window.fetch = async () => { throw new Error('offline'); }; });
    const observed = await page.evaluate(async () => {
      const local = { version: 'test', entities: { local: { name: 'Offline record' } } };
      localStorage.setItem('elistlyData:outbox:account-a', JSON.stringify([{ id: 'offline', payload: local }]));
      const data = await Storage.getAppData();
      return { data, outbox: JSON.parse(localStorage.getItem('elistlyData:outbox:account-a')), sync: Storage.getSyncStatus() };
    });
    assert.deepEqual(observed.data.entities, { local: { name: 'Offline record' } });
    assert.equal(observed.outbox.length, 1);
    assert.equal(observed.sync.state, 'pending');
  });
}

async function testBootstrapUsesTheAccountEndpointAndDoesNotDependOnAHealthRoute() {
  await withPage(async page => {
    await configureAccount(page, () => {
      window.requestPaths = [];
      window.fetch = async request => {
        window.requestPaths.push(String(request));
        return new Response(JSON.stringify({ payload: { version: 'test', entities: { server: {} } }, updated_at: 'remote' }), { status: 200 });
      };
    });
    const observed = await page.evaluate(async () => ({ data: await Storage.getAppData(), paths: window.requestPaths }));
    assert.deepEqual(observed.data.entities, { server: {} });
    assert.equal(observed.paths.length, 1);
    assert.match(observed.paths[0], /app-data$/);
    assert.doesNotMatch(observed.paths[0], /health/);
  });
}

async function testConflictRecoveryIsVisibleAndExportsThePreservedLocalSnapshot() {
  await withPage(async page => {
    const observed = await page.evaluate(() => {
      Storage._conflictRecovery = {
        userId: 'account-a',
        localPayload: { version: 'test', entities: { local: { name: 'Offline record' } } },
        remotePayload: { version: 'test', entities: { server: { name: 'Server record' } } },
        remoteUpdatedAt: 'remote',
        detectedAt: 'now'
      };
      App.showSyncConflictRecovery();
      const modal = document.getElementById('syncRecoveryModal');
      return {
        title: modal?.querySelector('h3')?.textContent,
        message: modal?.textContent,
        exportLabel: modal?.querySelector('button')?.textContent
      };
    });
    assert.equal(observed.title, 'Local changes need review');
    assert.match(observed.message || '', /Both copies are preserved/);
    assert.equal(observed.exportLabel, 'Download local backup');
  });
}

async function run() {
  await testRemoteSnapshotBootstrapsWithoutDiscardingDivergentPendingEdits();
  await testOfflinePendingEditsRemainTheStartupInventoryWhenRemoteCannotBeRead();
  await testBootstrapUsesTheAccountEndpointAndDoesNotDependOnAHealthRoute();
  await testConflictRecoveryIsVisibleAndExportsThePreservedLocalSnapshot();
  console.log('remote-authoritative sync tests passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
