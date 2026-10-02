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
    response.setHeader('Content-Type',filePath.endsWith('.js')?'application/javascript':filePath.endsWith('.html')?'text/html':filePath.endsWith('.css')?'text/css':'application/octet-stream');
    response.end(fs.readFileSync(filePath));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function withPage(run) {
  const server = await startStaticServer();
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();page.setDefaultTimeout(8000);
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
    page.setDefaultTimeout(8000);
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
      Storage._writeConfirmed('account-a',accountA,'base');
      localStorage.setItem('elistlyData', JSON.stringify(accountA));
      localStorage.setItem('elistlyData:user:account-a', JSON.stringify(accountA));
      localStorage.setItem('elistlyData:userUpdated:account-a', '2026-09-17T00:00:00.000Z');
      Storage._cached = structuredClone(accountA);
      Storage._cachedUserId = 'account-a';

      await Storage.prepareForSignOut();
      const afterCleanup = Object.keys(localStorage).filter(key => key === 'elistlyData' || key.startsWith('elistlyData:confirmed:v1:') || key.startsWith('elistlyData:user:') || key.startsWith('elistlyData:userUpdated:') || key.startsWith('elistlyData:outbox:'));
      const memoryAfterCleanup = { cached: Storage._cached, cachedUserId: Storage._cachedUserId };

      backendClient = { auth: {
        getUser: async () => ({ data: { user: { id: 'account-b' } } }),
        getSession: async () => ({ data: { session: { access_token: 'test-token' } } })
      } };
      window.ELISTLY_API_URL = '/mock';
      window.fetch = async () => new Response(JSON.stringify({ payload: accountB, updated_at: '2026-09-17T00:01:00.000Z' }), { status: 200,headers:{ETag:'"2026-09-17T00:01:00.000Z"'} });
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
    assert.match(observed.error || '', /preserved local/i, 'sign-out must fail closed while any recoverable account edits remain local');
    assert.notEqual(observed.outbox, null, 'blocked sign-out must retain pending edits unchanged');
  });
}

async function testFailedLocalCleanupDoesNotClaimSignOutIsSafe() {
  await withPage(async page=>{
    const observed=await page.evaluate(async()=>{
      const key='elistlyData:user:account-a';localStorage.setItem(key,JSON.stringify({entities:{retained:true}}));
      const prototype=Object.getPrototypeOf(localStorage),remove=prototype.removeItem;
      prototype.removeItem=()=>{throw new Error('storage unavailable')};let error;
      try{await Storage.prepareForSignOut()}catch(caught){error=caught.message}finally{prototype.removeItem=remove}
      return {error,cache:localStorage.getItem(key)};
    });
    assert.match(observed.error,/storage unavailable|could not be cleared/);assert.notEqual(observed.cache,null);
  });
}

async function testFailedAuthSignOutIsReportedTruthfullyAfterCleanup() {
  await withPage(async page => {
    const observed = await page.evaluate(async () => {
      const marker = 'PRIVATE_SIGNOUT_FAILURE_INVENTORY';
      localStorage.setItem('elistlyData:user:account-a', JSON.stringify({ version: 'test', entities: { synced: true } }));
      document.getElementById('mainContent').textContent = marker;
      document.getElementById('categoryList').textContent = marker;
      const modal = document.createElement('div');
      modal.id = 'entityModal';
      modal.className = 'modal show';
      modal.textContent = marker;
      document.body.append(modal);
      const notices = [];
      const originalNotification = App.showNotification;
      App.showNotification = (message, kind) => notices.push({ message, kind });
      backendClient = { auth: { signOut: async () => ({ error: new Error('network unavailable') }) } };
      const result = await App.handleSignOut();
      App.showNotification = originalNotification;
      return { result, notices, retainedKeys: Object.keys(localStorage).filter(key => key.startsWith('elistlyData')), rendered: document.body.textContent.includes(marker), warningVisible: document.body.textContent.includes('Sign out did not complete') };
    });
    assert.equal(observed.result, false, 'a failed auth sign-out must not claim success');
    assert.deepEqual(observed.notices, [{ message: 'Sign out did not complete. Local account data was cleared; reload or try again before sharing this browser.', kind: 'error' }], 'a failed auth sign-out must explain the actual cleanup state');
    assert.deepEqual(observed.retainedKeys, [], 'the pre-auth cleanup must not leave plaintext account data behind when auth sign-out fails');
    assert.equal(observed.rendered, false, 'a failed remote sign-out must hide the initiating tab\'s cleared inventory and modals');
    assert.equal(observed.warningVisible, true, 'the locked view must explain that remote sign-out failed');
  });
}

async function testLateInventoryReadCannotUndoSignOutCleanup() {
  for (const background of [false,true]) await withPage(async page => {
    const observed=await page.evaluate(async background => {
      backendClient={auth:{getUser:async()=>({data:{user:{id:'account-a'}}}),getSession:async()=>({data:{session:{access_token:'test-token',user:{id:'account-a'}}}})}};
      window.ELISTLY_API_URL='/mock';
      if(background) Storage._writeConfirmed('account-a',{entities:{cached:true}},'old');
      let release,started;const waiting=new Promise(resolve=>{started=resolve});let callbacks=0;
      window.fetch=async()=>{started();await new Promise(resolve=>{release=resolve});return new Response(JSON.stringify({payload:{entities:{secret:true}},updated_at:'new'}),{headers:{ETag:'"new"'}})};
      const loading=Storage.getAppData({onRemoteSync:()=>{callbacks++;return true}}).catch(()=>null);
      await waiting;await Storage.prepareForSignOut();release();await loading;await Storage._refreshPromise?.catch(()=>{});
      return {cached:Storage._cached,keys:Object.keys(localStorage).filter(key=>key.startsWith('elistlyData')),callbacks};
    },background);
    assert.equal(observed.cached,null);assert.deepEqual(observed.keys,[]);assert.equal(observed.callbacks,0);
  });
}

async function testSignOutInAnotherTabClearsStaleInMemoryInventory() {
  await withPages(async (first, second) => {
    await second.evaluate(() => {
      const accountA = { version: 'test', entities: { secretA: { name: 'Account A inventory' } } };
      localStorage.setItem('elistly_token','token');
      localStorage.setItem('elistlyData:user:account-a', JSON.stringify(accountA));
      Storage._cached = structuredClone(accountA);
      Storage._cachedUserId = 'account-a';
      App.data = structuredClone(accountA);
    });

    await first.evaluate(async () => {await Storage.prepareForSignOut();localStorage.removeItem('elistly_token');});
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

async function testCrossTabSignOutHidesRenderedAccountContent() {
  await withPages(async (first, second) => {
    await second.evaluate(() => {
      const marker = 'PRIVATE_ACCOUNT_INVENTORY_0930';
      localStorage.setItem('elistly_token','token');
      localStorage.setItem('elistlyData:user:account-a', JSON.stringify({ entities: { secret: { name: marker } } }));
      Storage._cachedUserId = 'account-a';
      Storage._cached = { entities: { secret: { name: marker } } };
      App.data = structuredClone(Storage._cached);
      document.getElementById('mainContent').textContent = marker;
      document.getElementById('categoryList').textContent = marker;
      const modal = document.createElement('div');
      modal.id = 'entityModal';
      modal.className = 'modal show';
      modal.textContent = marker;
      document.body.append(modal);
    });
    await first.evaluate(async () => {await Storage.prepareForSignOut();localStorage.removeItem('elistly_token');});
    await second.waitForFunction(() => Storage._cached === null);
    const observed = await second.evaluate(() => ({
      rendered: document.body.textContent.includes('PRIVATE_ACCOUNT_INVENTORY_0930'),
      accountData: App.data.entities,
      message: document.body.textContent
    }));
    assert.equal(observed.rendered, false, 'another tab must hide rendered inventory and open account modals after sign-out cleanup');
    assert.deepEqual(observed.accountData, {}, 'account data must be invalidated');
    assert.match(observed.message, /reload/i, 'the invalidated tab must explain how to continue');
  });
}

async function testStaleCrossTabRemovalCannotRestoreInFlightSaveState() {
  await withPages(async(first,second)=>{
    await second.evaluate(mode=>{
      const user={id:'account-a'},session={access_token:'test-token',user},data={entities:{secret:{name:'PRIVATE'}}};
      backendClient={auth:{getUser:async()=>({data:{user}}),getSession:async()=>({data:{session}})}};
      window.ELISTLY_API_URL='/mock';Storage._cachedUserId=user.id;Storage._cached=data;Storage._accountVerified=true;Storage._cachedUpdatedAt='base';
      localStorage.setItem('elistly_token','token');
      Storage._writeConfirmed(user.id,data,'base');App.data=structuredClone(data);window.__requestCount=0;
      window.__saveStarted=new Promise(resolve=>{window.__started=resolve});
      window.fetch=async(_url,options)=>{
        window.__requestCount++;window.__started();return new Promise((resolve,reject)=>{window.__releaseSave=()=>mode==='failure'?reject(Error('offline')):resolve(new Response(JSON.stringify({payload:JSON.parse(options.body).payload,updated_at:'new'}),{headers:{ETag:'"new"'}}))});
      };
      const save=mode==='import'?Storage.setAppDataForImport(data,{userId:user.id,accessToken:session.access_token,expectedUpdatedAt:'base'}):Storage.setAppData(data);
      window.__pendingSave=save.catch(error=>error.message);
      if(mode==='queued') window.__secondSave=Storage.setAppData({entities:{second:true}}).catch(error=>error.message);
    },'ack');
    await second.evaluate(()=>window.__saveStarted);
    await first.evaluate(()=>{localStorage.removeItem('elistlyData:confirmed:v1:account-a');localStorage.removeItem('elistly_token');});
    await second.waitForFunction(()=>Storage._cached===null && Storage._cachedUserId===null);
    const observed=await second.evaluate(async()=>{
      window.__releaseSave();await window.__pendingSave;if(window.__secondSave)await window.__secondSave;
      return {cached:Storage._cached,user:Storage._cachedUserId,entities:App.data.entities,cache:Storage._readConfirmed('account-a'),dirty:Storage._isDirty,status:Storage.getSyncStatus().state,requests:window.__requestCount};
    });
    assert.equal(observed.cached,null);assert.equal(observed.user,null);assert.deepEqual(observed.entities,{});assert.equal(observed.cache,null);
    assert.equal(observed.dirty,false);assert.equal(observed.status,'idle');assert.equal(observed.requests,1,'no queued operation may send after invalidation');
  });
}

async function testStaleCrossTabSaveFailureCannotOverwriteClearedSyncState() {
  await withPages(async(first,second)=>{
    await second.evaluate(mode=>{
      const user={id:'account-a'},session={access_token:'test-token',user},data={entities:{secret:{name:'PRIVATE'}}};
      backendClient={auth:{getUser:async()=>({data:{user}}),getSession:async()=>({data:{session}})}};
      window.ELISTLY_API_URL='/mock';Storage._cachedUserId=user.id;Storage._cached=data;Storage._accountVerified=true;Storage._cachedUpdatedAt='base';
      localStorage.setItem('elistly_token','token');
      Storage._writeConfirmed(user.id,data,'base');App.data=structuredClone(data);window.__requestCount=0;
      window.__saveStarted=new Promise(resolve=>{window.__started=resolve});
      window.fetch=async(_url,options)=>{
        window.__requestCount++;window.__started();return new Promise((resolve,reject)=>{window.__releaseSave=()=>mode==='failure'?reject(Error('offline')):resolve(new Response(JSON.stringify({payload:JSON.parse(options.body).payload,updated_at:'new'}),{headers:{ETag:'"new"'}}))});
      };
      const save=mode==='import'?Storage.setAppDataForImport(data,{userId:user.id,accessToken:session.access_token,expectedUpdatedAt:'base'}):Storage.setAppData(data);
      window.__pendingSave=save.catch(error=>error.message);
      if(mode==='queued') window.__secondSave=Storage.setAppData({entities:{second:true}}).catch(error=>error.message);
    },'failure');
    await second.evaluate(()=>window.__saveStarted);
    await first.evaluate(()=>{localStorage.removeItem('elistlyData:confirmed:v1:account-a');localStorage.removeItem('elistly_token');});
    await second.waitForFunction(()=>Storage._cached===null && Storage._cachedUserId===null);
    const observed=await second.evaluate(async()=>{
      window.__releaseSave();await window.__pendingSave;if(window.__secondSave)await window.__secondSave;
      return {cached:Storage._cached,user:Storage._cachedUserId,entities:App.data.entities,cache:Storage._readConfirmed('account-a'),dirty:Storage._isDirty,status:Storage.getSyncStatus().state,requests:window.__requestCount};
    });
    assert.equal(observed.cached,null);assert.equal(observed.user,null);assert.deepEqual(observed.entities,{});assert.equal(observed.cache,null);
    assert.equal(observed.dirty,false);assert.equal(observed.status,'idle');assert.equal(observed.requests,1,'no queued operation may send after invalidation');
  });
}

async function testQueuedSaveCannotSendAfterCrossTabInvalidation() {
  await withPages(async(first,second)=>{
    await second.evaluate(mode=>{
      const user={id:'account-a'},session={access_token:'test-token',user},data={entities:{secret:{name:'PRIVATE'}}};
      backendClient={auth:{getUser:async()=>({data:{user}}),getSession:async()=>({data:{session}})}};
      window.ELISTLY_API_URL='/mock';Storage._cachedUserId=user.id;Storage._cached=data;Storage._accountVerified=true;Storage._cachedUpdatedAt='base';
      localStorage.setItem('elistly_token','token');
      Storage._writeConfirmed(user.id,data,'base');App.data=structuredClone(data);window.__requestCount=0;
      window.__saveStarted=new Promise(resolve=>{window.__started=resolve});
      window.fetch=async(_url,options)=>{
        window.__requestCount++;window.__started();return new Promise((resolve,reject)=>{window.__releaseSave=()=>mode==='failure'?reject(Error('offline')):resolve(new Response(JSON.stringify({payload:JSON.parse(options.body).payload,updated_at:'new'}),{headers:{ETag:'"new"'}}))});
      };
      const save=mode==='import'?Storage.setAppDataForImport(data,{userId:user.id,accessToken:session.access_token,expectedUpdatedAt:'base'}):Storage.setAppData(data);
      window.__pendingSave=save.catch(error=>error.message);
      if(mode==='queued') window.__secondSave=Storage.setAppData({entities:{second:true}}).catch(error=>error.message);
    },'queued');
    await second.evaluate(()=>window.__saveStarted);
    await first.evaluate(()=>{localStorage.removeItem('elistlyData:confirmed:v1:account-a');localStorage.removeItem('elistly_token');});
    await second.waitForFunction(()=>Storage._cached===null && Storage._cachedUserId===null);
    const observed=await second.evaluate(async()=>{
      window.__releaseSave();await window.__pendingSave;if(window.__secondSave)await window.__secondSave;
      return {cached:Storage._cached,user:Storage._cachedUserId,entities:App.data.entities,cache:Storage._readConfirmed('account-a'),dirty:Storage._isDirty,status:Storage.getSyncStatus().state,requests:window.__requestCount};
    });
    assert.equal(observed.cached,null);assert.equal(observed.user,null);assert.deepEqual(observed.entities,{});assert.equal(observed.cache,null);
    assert.equal(observed.dirty,false);assert.equal(observed.status,'idle');assert.equal(observed.requests,1,'no queued operation may send after invalidation');
  });
}

async function testStaleImportAcknowledgementCannotRestoreAccountState() {
  await withPages(async(first,second)=>{
    await second.evaluate(mode=>{
      const user={id:'account-a'},session={access_token:'test-token',user},data={entities:{secret:{name:'PRIVATE'}}};
      backendClient={auth:{getUser:async()=>({data:{user}}),getSession:async()=>({data:{session}})}};
      window.ELISTLY_API_URL='/mock';Storage._cachedUserId=user.id;Storage._cached=data;Storage._accountVerified=true;Storage._cachedUpdatedAt='base';
      localStorage.setItem('elistly_token','token');
      Storage._writeConfirmed(user.id,data,'base');App.data=structuredClone(data);window.__requestCount=0;
      window.__saveStarted=new Promise(resolve=>{window.__started=resolve});
      window.fetch=async(_url,options)=>{
        window.__requestCount++;window.__started();return new Promise((resolve,reject)=>{window.__releaseSave=()=>mode==='failure'?reject(Error('offline')):resolve(new Response(JSON.stringify({payload:JSON.parse(options.body).payload,updated_at:'new'}),{headers:{ETag:'"new"'}}))});
      };
      const save=mode==='import'?Storage.setAppDataForImport(data,{userId:user.id,accessToken:session.access_token,expectedUpdatedAt:'base'}):Storage.setAppData(data);
      window.__pendingSave=save.catch(error=>error.message);
      if(mode==='queued') window.__secondSave=Storage.setAppData({entities:{second:true}}).catch(error=>error.message);
    },'import');
    await second.evaluate(()=>window.__saveStarted);
    await first.evaluate(()=>{localStorage.removeItem('elistlyData:confirmed:v1:account-a');localStorage.removeItem('elistly_token');});
    await second.waitForFunction(()=>Storage._cached===null && Storage._cachedUserId===null);
    const observed=await second.evaluate(async()=>{
      window.__releaseSave();await window.__pendingSave;if(window.__secondSave)await window.__secondSave;
      return {cached:Storage._cached,user:Storage._cachedUserId,entities:App.data.entities,cache:Storage._readConfirmed('account-a'),dirty:Storage._isDirty,status:Storage.getSyncStatus().state,requests:window.__requestCount};
    });
    assert.equal(observed.cached,null);assert.equal(observed.user,null);assert.deepEqual(observed.entities,{});assert.equal(observed.cache,null);
    assert.equal(observed.dirty,false);assert.equal(observed.status,'idle');assert.equal(observed.requests,1,'no queued operation may send after invalidation');
  });
}

async function testLateStartupHydrationCannotRenderAfterCrossTabSignOut() {
  await withPages(async (first, second) => {
    await second.evaluate(() => {
      const marker = 'PRIVATE_LATE_STARTUP_INVENTORY';
      localStorage.setItem('elistly_token','token');
      const stale = { version: CURRENT_VERSION, entities: { secret: { name: marker } } };
      localStorage.setItem('elistlyData:user:account-a', JSON.stringify(stale));
      Storage._cached = structuredClone(stale);
      Storage._cachedUserId = 'account-a';
      backendClient = { auth: {
        getSession: async () => ({ data: { session: { access_token: 'test-token', user: { id: 'account-a' } } } }),
        getUser: async () => ({ data: { user: { id: 'account-a' } } })
      } };
      Storage.getAppData = () => new Promise(resolve => {
        window.__releaseStartup = () => resolve(stale);
        window.__startupWaiting = true;
      });
      window.__pendingStartup = App.init();
    });
    await second.waitForFunction(() => window.__startupWaiting === true);
    await first.evaluate(async () => {await Storage.prepareForSignOut();localStorage.removeItem('elistly_token');});
    await second.waitForFunction(() => Storage._cached === null);
    const observed = await second.evaluate(async () => {
      window.__releaseStartup();
      await window.__pendingStartup;
      return {
        rendered: document.body.textContent.includes('PRIVATE_LATE_STARTUP_INVENTORY'),
        entities: App.data.entities,
        ready: App._isReady
      };
    });
    assert.equal(observed.rendered, false, 'late startup hydration must not render inventory after another tab signs out');
    assert.deepEqual(observed.entities, {}, 'late startup hydration must not restore account data');
    assert.equal(observed.ready, false, 'a signed-out tab must remain locked');
  });
}

async function run() {
  await testLateInventoryReadCannotUndoSignOutCleanup();
  await testSignOutInAnotherTabClearsStaleInMemoryInventory();
  await testCrossTabSignOutHidesRenderedAccountContent();
  await testStaleCrossTabRemovalCannotRestoreInFlightSaveState();
  await testStaleCrossTabSaveFailureCannotOverwriteClearedSyncState();
  await testQueuedSaveCannotSendAfterCrossTabInvalidation();
  await testStaleImportAcknowledgementCannotRestoreAccountState();
  await testLateStartupHydrationCannotRenderAfterCrossTabSignOut();
  await testSignOutClearsDurableAccountDataWithoutCrossAccountHydration();
  await testPendingEditsBlockSignOutInsteadOfBeingDiscarded();
  await testFailedLocalCleanupDoesNotClaimSignOutIsSafe();
  await testFailedAuthSignOutIsReportedTruthfullyAfterCleanup();
}

run().then(() => console.log('PASS sign-out privacy')).catch(error => {
  console.error(`FAIL sign-out privacy: ${error.stack || error.message}`);
  process.exitCode = 1;
});
