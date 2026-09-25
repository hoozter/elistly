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
      getSession: async () => ({ data: { session: { access_token: 'test.' + btoa(JSON.stringify({ sub: 'account-a', exp: 4102444800 })).replace(/=/g, '') + '.test', user: { id: 'account-a' } }, error: null } })
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
      await Storage.getAppData();
      await Storage._refreshPromise.catch(() => {});
      const data = Storage._cached;
      return { data, outbox: JSON.parse(localStorage.getItem('elistlyData:outbox:account-a')), conflict: Storage.getConflictRecovery(), sync: Storage.getSyncStatus() };
    });
    assert.deepEqual(observed.data.entities, { server: { name: 'Server record' } }, 'the remote snapshot must be the startup inventory when a remote account exists');
    assert.deepEqual(observed.outbox, [], 'divergent writes must be isolated from the active outbox');
    assert.deepEqual(observed.conflict.outbox[0].payload.entities, { local: { name: 'Offline record' } }, 'original pending entries and provenance remain in recovery');
    assert.deepEqual(observed.conflict.localPayload.entities, { local: { name: 'Offline record' } }, 'recovery must expose the preserved local snapshot');
    assert.deepEqual(observed.conflict.remotePayload.entities, { server: { name: 'Server record' } }, 'recovery must identify the authoritative remote snapshot');
    const durable = await page.evaluate(() => JSON.parse(localStorage.getItem('elistlyData:recovery:account-a')));
    assert.deepEqual(durable[0].outbox, observed.conflict.outbox, 'recovery survives reload');
    assert.equal(observed.sync.state, 'archived', 'divergent edits must remain discoverable, not appear pending');
  });
}

async function testOfflinePendingEditsRemainTheStartupInventoryWhenRemoteCannotBeRead() {
  await withPage(async page => {
    await configureAccount(page, () => { window.fetch = async () => { throw new Error('offline'); }; });
    const observed = await page.evaluate(async () => {
      const local = { version: 'test', entities: { local: { name: 'Offline record' } } };
      localStorage.setItem('elistlyData:outbox:account-a', JSON.stringify([{ id: 'offline', payload: local }]));
      await Storage.getAppData();
      await Storage._refreshPromise.catch(() => {});
      const data = Storage._cached;
      return { data, outbox: JSON.parse(localStorage.getItem('elistlyData:outbox:account-a')), sync: Storage.getSyncStatus() };
    });
    assert.deepEqual(observed.data.entities, { local: { name: 'Offline record' } });
    assert.equal(observed.outbox.length, 1);
    assert.equal(observed.sync.state, 'failed');
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

async function testCurrentRevisionPendingEditsStayEditable() {
  await withPage(async page => {
    await configureAccount(page, () => {
      window.fetch = async () => new Response(JSON.stringify({ payload: { entities: { original: {} } }, updated_at: '2026-09-17T06:11:53.746204Z' }), { status: 200 });
    });
    const observed = await page.evaluate(async () => {
      const pending = { entities: { edited: {} } };
      localStorage.setItem('elistlyData:outbox:account-a', JSON.stringify([{ id: 'current', payload: pending, expectedUpdatedAt: '2026-09-17T06:11:53.746204Z' }]));
      await Storage.getAppData(); await Storage._refreshPromise; return { data: Storage._cached, conflict: Storage.getConflictRecovery() };
    });
    assert.deepEqual(observed.data.entities, { edited: {} }, 'edits based on the unchanged server revision remain the active inventory');
    assert.equal(observed.conflict, null);
  });
}

async function testReplayNeverBorrowsANewerCachedRevision() {
  await withPage(async page => {
    await configureAccount(page, () => {
      window.sent = [];
      window.fetch = async (_url, options) => {
        window.sent.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ error: 'App data changed since preview' }), { status: 409 });
      };
    });
    const observed = await page.evaluate(async () => {
      localStorage.setItem('elistlyData:userUpdated:account-a', '2026-09-17T06:11:53.746204Z');
      localStorage.setItem('elistlyData:outbox:account-a', JSON.stringify([{ id: 'stale', payload: { entities: { stale: {} } }, expectedUpdatedAt: null }]));
      try { await Storage.retryPendingSaves(); } catch (_) {}
      return window.sent;
    });
    assert.equal(observed[0]?.expectedUpdatedAt, null, 'a stale null-base queue must never borrow the newer cached revision');
  });
}

async function testAccountInvalidationRejectsLateQueuedRead() {
  await withPage(async page => {
    await configureAccount(page, () => {
      window.fetch = async () => {
        Storage._clearInMemoryAccountState();
        return new Response(JSON.stringify({ payload: { entities: { remote: {} } }, updated_at: 'remote' }), { status: 200 });
      };
    });
    const observed = await page.evaluate(async () => {
      localStorage.setItem('elistlyData:outbox:account-a', JSON.stringify([{ id: 'stale', payload: { entities: { stale: {} } }, expectedUpdatedAt: null }]));
      let rejected = false;
      try { await Storage.getAppData(); await Storage._refreshPromise; } catch (_) { rejected = true; }
      return { rejected, cached: Storage._cached, recovery: Storage.getConflictRecovery(), persisted: Storage._readUserCache('account-a') };
    });
    assert.equal(observed.rejected, true, 'late queued read must reject after account invalidation');
    assert.equal(observed.cached, null);
    assert.equal(observed.recovery, null);
    assert.equal(observed.persisted, null);
  });
}

async function testRecoveryResolutionRequiresTheReviewedArchive() {
  await withPage(async page => {
    await configureAccount(page, () => {});
    const result = await page.evaluate(async () => {
      const records = [{userId:'account-a',outbox:[{id:'old',payload:{entities:{old:{}}},expectedUpdatedAt:null}],archived:true}];
      localStorage.setItem('elistlyData:recovery:account-a',JSON.stringify(records));
      Storage._conflictRecovery=records[0];
      let blocked=false;try{await Storage.prepareForSignOut();}catch(_){blocked=true;}
      let staleBlocked=false;try{await Storage.resolveDownloadedRecovery('account-a',[]);}catch(_){staleBlocked=true;}
      const before=localStorage.getItem('elistlyData:recovery:account-a');
      await Storage.resolveDownloadedRecovery('account-a',records);
      await Storage.prepareForSignOut();
      return {blocked,staleBlocked,before,after:localStorage.getItem('elistlyData:recovery:account-a')};
    });
    assert.equal(result.blocked,true);
    assert.equal(result.staleBlocked,true);
    assert.ok(result.before);
    assert.equal(result.after,null);
  });
}

async function testFailedRecoveryArchivePreservesOriginalQueue() {
  await withPage(async page => {
    await configureAccount(page, () => { window.fetch=async()=>new Response(JSON.stringify({payload:{entities:{remote:{}}},updated_at:'remote'}),{status:200}); });
    const result=await page.evaluate(async()=>{
      const queue=JSON.stringify([{id:'stale',payload:{entities:{local:{}}},expectedUpdatedAt:null}]);
      localStorage.setItem('elistlyData:outbox:account-a',queue);
      const proto=Object.getPrototypeOf(localStorage);const set=proto.setItem;
      proto.setItem=function(k,v){if(k.startsWith('elistlyData:recovery:'))throw new DOMException('Full','QuotaExceededError');return set.call(this,k,v);};
      await Storage.getAppData();let rejected=false;try{await Storage._refreshPromise;}catch(_){rejected=true;}finally{proto.setItem=set;}
      return {rejected,queue,retained:localStorage.getItem('elistlyData:outbox:account-a'),state:Storage.getSyncStatus().state};
    });
    assert.equal(result.rejected,true);assert.equal(result.retained,result.queue);assert.equal(result.state,'failed');
  });
}

async function testRecoveryRestoreRequiresFreshPreviewAndConditionalWrite() {
  await withPage(async page => {
    await configureAccount(page, () => {
      window.remote = { payload: { entities: { server: { name: 'remote' } } }, updated_at: 'revision-1' };
      window.puts = [];
      window.fetch = async (_url, options) => {
        if (options.method === 'PUT') {
          const body = JSON.parse(options.body); window.puts.push(body);
          if (body.expectedUpdatedAt !== window.remote.updated_at) return new Response(JSON.stringify({ error: 'App data changed since preview' }), { status: 409 });
          window.remote = { payload: body.payload, updated_at: 'revision-2' };
        }
        return new Response(JSON.stringify(window.remote), { status: 200 });
      };
    });
    const result = await page.evaluate(async () => {
      const localPayload = { entities: { local: { name: 'authored' } } };
      const recovery = [{ userId: 'account-a', localPayload, remotePayload: window.remote.payload, remoteUpdatedAt: 'revision-1', outbox: [{ id: 'local', payload: localPayload, expectedUpdatedAt: null }] }];
      localStorage.setItem(Storage.USER_RECOVERY_PREFIX + 'account-a', JSON.stringify(recovery));
      await Storage.getAppData(); await Storage._refreshPromise;
      const preview = await Storage.previewRecovery('account-a', recovery);
      window.remote = { payload: { entities: { concurrent: {} } }, updated_at: 'revision-concurrent' };
      let blocked = false;
      try { await Storage.restoreRecovery('account-a', recovery, preview); } catch (_) { blocked = true; }
      const newer = await Storage.previewRecovery('account-a', recovery);
      const result = await Storage.restoreRecovery('account-a', recovery, newer);
      return { blocked, preview, newer, result, puts: window.puts, archive: Storage._readRecovery('account-a'), remote: window.remote };
    });
    assert.equal(result.blocked, true);
    assert.equal(result.puts.length, 1, 'stale preview must not write');
    assert.equal(result.puts[0].expectedUpdatedAt, 'revision-concurrent');
    assert.deepEqual(result.remote.payload.entities, { local: { name: 'authored' } });
    assert.equal(result.archive.length, 1, 'restoration must not erase the preserved copy');
    assert.equal(result.result.updated_at, 'revision-2');
  });
}

async function testUnrelatedCacheIsOnlyDisplayData() {
  await withPage(async page => {
    await configureAccount(page, () => {
      window.writes = 0;
      window.fetch = async (_url, options) => { if (options.method === 'PUT') window.writes++; return new Response(JSON.stringify({ payload: { entities: { server: {} } }, updated_at: 'new' }), { status: 200 }); };
    });
    const result = await page.evaluate(async () => {
      localStorage.setItem(Storage._getUserCacheKey('account-a'), JSON.stringify({ entities: { old: {} } }));
      localStorage.setItem(Storage._getUserUpdatedKey('account-a'), 'old');
      const initial = await Storage.getAppData(); await Storage._refreshPromise;
      return { initial, fresh: Storage._cached, recovery: Storage.getConflictRecovery(), writes: window.writes };
    });
    assert.deepEqual(result.initial.entities, { old: {} });
    assert.deepEqual(result.fresh.entities, { server: {} });
    assert.equal(result.recovery, null);
    assert.equal(result.writes, 0);
  });
}

async function testLostAcknowledgementWithLaterOfflineEdits() {
  await withPage(async page => {
    await configureAccount(page, () => {
      window.remote = { payload: { entities: { record: { name: 'first saved edit' } } }, updated_at: 'revision-after-first' };
      window.writes = [];
      window.fetch = async (_url, options) => {
        if (options.method === 'PUT') {
          const body = JSON.parse(options.body);
          window.writes.push(body);
          if (body.expectedUpdatedAt !== window.remote.updated_at) return new Response(JSON.stringify({ error: 'App data changed since preview' }), { status: 409 });
          window.remote = { payload: body.payload, updated_at: 'revision-after-second' };
        }
        return new Response(JSON.stringify(window.remote), { status: 200 });
      };
    });
    const result = await page.evaluate(async () => {
      const first = { entities: { record: { name: 'first saved edit' } } };
      const second = { entities: { record: { name: 'later offline edit' } } };
      localStorage.setItem(Storage._getUserOutboxKey('account-a'), JSON.stringify([
        { id: 'first', payload: first, expectedUpdatedAt: 'revision-before-first' },
        { id: 'second', parentId: 'first', payload: second, createdAt: new Date().toISOString() }
      ]));
      await Storage.getAppData(); await Storage._refreshPromise;
      const pending = Storage._readOutbox('account-a');
      await Storage.retryPendingSaves();
      return { pending, writes: window.writes, remote: window.remote, archive: Storage.getConflictRecovery(), remaining: Storage._readOutbox('account-a') };
    });
    assert.equal(result.pending.length, 1);
    assert.equal(result.pending[0].expectedUpdatedAt, 'revision-after-first');
    assert.equal(result.writes.length, 1);
    assert.equal(result.writes[0].expectedUpdatedAt, 'revision-after-first');
    assert.equal(result.remote.payload.entities.record.name, 'later offline edit');
    assert.equal(result.archive, null);
    assert.deepEqual(result.remaining, []);
  });
}

async function testDownloadedArchiveRequiresCurrentBackupBeforeItOffersRestore() {
  await withPage(async page => {
    await configureAccount(page, () => {
      window.writes = 0;
      window.fetch = async (_url, options = {}) => {
        if (options.method === 'PUT') window.writes++;
        return new Response(JSON.stringify({ payload: { entities: { current: { name: 'account copy' } } }, updated_at: 'revision-1' }), { status: 200 });
      };
    });
    const observed = await page.evaluate(async () => {
      await Storage.getAppData(); await Storage._refreshPromise;
      await Storage.importRecoveryArchive({
        format: 'elistly-sync-recovery', version: 1,
        records: [{ userId: 'account-a', localPayload: { entities: { lost: { name: 'downloaded edit' } } }, outbox: [] }]
      });
      App.showSyncConflictRecovery();
      for (let attempt = 0; attempt < 20; attempt++) {
        const currentBackup = [...document.querySelectorAll('#syncRecoveryModal button')].find(button => button.textContent === 'Download current account backup');
        if (currentBackup && !currentBackup.disabled) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const buttons = [...document.querySelectorAll('#syncRecoveryModal button')];
      const byLabel = label => buttons.find(button => button.textContent === label);
      const before = {
        restoreDisabled: byLabel('Restore local copy to account').disabled,
        accountBackupDisabled: byLabel('Download current account backup').disabled,
        local: document.querySelector('#syncRecoveryModal')?.textContent.includes('downloaded edit'),
        current: document.querySelector('#syncRecoveryModal')?.textContent.includes('account copy')
      };
      byLabel('Download current account backup').click();
      const after = { restoreDisabled: byLabel('Restore local copy to account').disabled, writes: window.writes };
      return { before, after };
    });
    assert.deepEqual(observed.before, { restoreDisabled: true, accountBackupDisabled: false, local: true, current: true });
    assert.deepEqual(observed.after, { restoreDisabled: false, writes: 0 }, 'review and backup clicks must not write account data');
  });
}

async function testUnchangedRefreshDoesNotCreateRecurringRecoveryConflicts() {
  await withPage(async page => {
    await configureAccount(page, () => {
      window.fetch = async () => new Response(JSON.stringify({ payload: { entities: { server: { name: 'current' } } }, updated_at: 'revision-1' }), { status: 200 });
    });
    const observed = await page.evaluate(async () => {
      const local = { entities: { local: { name: 'older' } } };
      localStorage.setItem(Storage._getUserOutboxKey('account-a'), JSON.stringify([{ id: 'old', payload: local, expectedUpdatedAt: null }]));
      await Storage.getAppData(); await Storage._refreshPromise;
      const first = Storage._readRecovery('account-a');
      await Storage.getAppData(); await Storage._refreshPromise;
      return { firstCount: first.length, final: Storage._readRecovery('account-a'), outbox: Storage._readOutbox('account-a'), status: Storage.getSyncStatus().state };
    });
    assert.equal(observed.firstCount, 1);
    assert.equal(observed.final.length, 1, 'an unchanged account refresh must retain one reviewed archive, not create another conflict');
    assert.deepEqual(observed.outbox, []);
    assert.equal(observed.status, 'archived');
  });
}

async function testDownloadedArchiveCanBeReopenedWithoutWritingAccount() {
  await withPage(async page => {
    await configureAccount(page, () => {
      window.writes = 0;
      window.fetch = async (_url, options) => {
        if (options.method === 'PUT') window.writes++;
        return new Response(JSON.stringify({ payload: { entities: { current: { name: 'account copy' } } }, updated_at: 'revision-1' }), { status: 200 });
      };
    });
    const result = await page.evaluate(async () => {
      await Storage.getAppData(); await Storage._refreshPromise;
      const record = { userId: 'account-a', localPayload: { entities: { lost: { name: 'downloaded edit' } } }, outbox: [], detectedAt: '2026-09-21T00:00:00Z' };
      const archive = { format: 'elistly-sync-recovery', version: 1, records: [record] };
      let wrongAccountRejected = false;
      try { await Storage.importRecoveryArchive({ ...archive, records: [{ ...record, userId: 'other' }] }); } catch (_) { wrongAccountRejected = true; }
      await Storage.importRecoveryArchive(archive);
      await Storage.importRecoveryArchive(archive);
      return { wrongAccountRejected, records: Storage._readRecovery('account-a'), status: Storage.getSyncStatus().state, cached: Storage._cached, writes: window.writes };
    });
    assert.equal(result.wrongAccountRejected, true);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].localPayload.entities.lost.name, 'downloaded edit');
    assert.equal(result.cached.entities.current.name, 'account copy');
    assert.equal(result.status, 'archived');
    assert.equal(result.writes, 0);
  });
}

async function run() {
  await testDownloadedArchiveRequiresCurrentBackupBeforeItOffersRestore();
  await testUnchangedRefreshDoesNotCreateRecurringRecoveryConflicts();
  await testDownloadedArchiveCanBeReopenedWithoutWritingAccount();
  await testLostAcknowledgementWithLaterOfflineEdits();
  await testRecoveryRestoreRequiresFreshPreviewAndConditionalWrite();
  await testUnrelatedCacheIsOnlyDisplayData();
  await testFailedRecoveryArchivePreservesOriginalQueue();
  await testRecoveryResolutionRequiresTheReviewedArchive();
  await testReplayNeverBorrowsANewerCachedRevision();
  await testAccountInvalidationRejectsLateQueuedRead();
  await testCurrentRevisionPendingEditsStayEditable();
  await testRemoteSnapshotBootstrapsWithoutDiscardingDivergentPendingEdits();
  await testOfflinePendingEditsRemainTheStartupInventoryWhenRemoteCannotBeRead();
  await testBootstrapUsesTheAccountEndpointAndDoesNotDependOnAHealthRoute();
  await testConflictRecoveryIsVisibleAndExportsThePreservedLocalSnapshot();
  console.log('remote-authoritative sync tests passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
