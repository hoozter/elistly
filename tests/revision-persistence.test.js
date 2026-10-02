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
    response.setHeader('Content-Type',filePath.endsWith('.js')?'application/javascript':filePath.endsWith('.html')?'text/html':filePath.endsWith('.css')?'text/css':'application/octet-stream');
    response.end(fs.readFileSync(filePath));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function withPage(run, setup) {
  const server = await startStaticServer();
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', error => console.error('BROWSER ERROR:', error.message));
  page.on('console', message => {if (message.type()==='error') console.error('BROWSER:',message.text());});
  page.setDefaultTimeout(8000);
  await page.route('**/config.js', route => route.fulfill({ contentType: 'application/javascript', body: 'window.ELISTLY_API_URL = "https://api.elistly.test"; window.NEON_AUTH_URL = "/mock-auth";' }));
  try {
    if (setup) await setup(page);
    await page.goto(`http://127.0.0.1:${server.address().port}/app.html`, { waitUntil: 'domcontentloaded' });
    return await run(page);
  } catch (error) {
    console.error('FAILED STATE:', await page.evaluate(()=>({ready:App._isReady,status:Storage.getSyncStatus(),tokenPresent:!!localStorage.getItem('elistly_token'),clientPresent:!!backendClient,error:document.getElementById('mainContent')?.textContent})));
    throw error;
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

async function testConfirmedSaveAndSerialRevision() {
  await withPage(async page => {
    const result = await page.evaluate(async () => {
      const first = {entities:{first:true}}, second = {entities:{second:true}};
      backendClient = {auth:{getUser:async()=>({data:{user:{id:'user-1'}}}),getSession:async()=>({data:{session:{access_token:'token',user:{id:'user-1'}}}})}};
      window.ELISTLY_API_URL='/mock';
      Storage._cachedUserId='user-1'; Storage._cachedUpdatedAt='base'; Storage._accountVerified=true;
      Storage._writeConfirmed('user-1',{entities:{original:true}},'base');
      const requests=[]; let release;
      window.fetch=async (_url,opts)=>{
        requests.push({body:JSON.parse(opts.body),headers:opts.headers});
        if(requests.length===1) await new Promise(resolve=>{release=resolve});
        const revision=`rev-${requests.length}`;
        return new Response(JSON.stringify({payload:JSON.parse(opts.body).payload,updated_at:revision}),{status:200,headers:{'Access-Control-Expose-Headers':'ETag',ETag:`"${revision}"`}});
      };
      const a=Storage.setAppData(first), b=Storage.setAppData(second);
      await new Promise(resolve=>setTimeout(resolve,20));
      const before=requests.length; release();await Promise.all([a,b]);
      return {before,requests,confirmed:Storage._readConfirmed('user-1'),dirty:Storage._isDirty};
    });
    assert.equal(result.before,1);
    assert.deepEqual(result.requests.map(req=>req.headers['If-Match']),['"base"','"rev-1"']);
    assert.deepEqual(result.confirmed,{format:'server-ack-v1',payload:{entities:{second:true}},revision:'rev-2'});
    assert.equal(result.dirty,false);
  });
}
async function testFailedSaveRetainsOnlyAcknowledgedCacheAndInMemoryDraft() {
  await withPage(async page=>{
    const result=await page.evaluate(async()=>{
      backendClient={auth:{getUser:async()=>({data:{user:{id:'user-1'}}}),getSession:async()=>({data:{session:{access_token:'token',user:{id:'user-1'}}}})}};
      window.ELISTLY_API_URL='/mock';
      const old={entities:{saved:true}},draft={entities:{draft:true}};
      Storage._cachedUserId='user-1';Storage._cached=old;Storage._cachedUpdatedAt='base';Storage._accountVerified=true;
      Storage._writeConfirmed('user-1',old,'base');
      window.fetch=async()=>new Response(JSON.stringify({error:'conflict'}),{status:412});
      let error;try{await Storage.setAppData(draft)}catch(e){error=e.message}
      const during={cached:Storage._cached,confirmed:Storage._readConfirmed('user-1'),status:Storage.getSyncStatus().state,dirty:Storage._isDirty,error};
      Storage._clearInMemoryAccountState();
      window.fetch=async()=>{throw Error('offline')};
      const reload=await Storage.getAppData();await Storage._refreshPromise.catch(()=>{});
      return {during,reload,confirmed:Storage._readConfirmed('user-1')};
    });
    assert.match(result.during.error,/Account changed/);
    assert.equal(result.during.status,'conflict');assert.equal(result.during.dirty,true);
    assert.deepEqual(result.during.cached.entities,{draft:true});
    assert.deepEqual(result.during.confirmed.payload.entities,{saved:true});
    assert.deepEqual(result.reload.entities,{saved:true});
    assert.deepEqual(result.confirmed.payload.entities,{saved:true});
  });
}
async function testFailedRetryChecksLatestWithoutRebasing() {
  await withPage(async page=>{
    const result=await page.evaluate(async()=>{
      backendClient={auth:{getUser:async()=>({data:{user:{id:'user-1'}}}),getSession:async()=>({data:{session:{access_token:'token',user:{id:'user-1'}}}})}};
      window.ELISTLY_API_URL='/mock';Storage._cachedUserId='user-1';Storage._cachedUpdatedAt='base';Storage._accountVerified=true;
      Storage._writeConfirmed('user-1',{entities:{saved:true}},'base');
      window.fetch=async()=>new Response('{}',{status:503});
      try{await Storage.setAppData({entities:{draft:true}})}catch(_){}
      const methods=[];
      window.fetch=async (_url,opts)=>{methods.push(opts.method);return new Response(JSON.stringify({payload:{entities:{remote:true}},updated_at:'new'}),{headers:{'Access-Control-Expose-Headers':'ETag',ETag:'"new"'}})};
      let error;try{await Storage.retrySave()}catch(e){error=e.message}
      return {methods,error,draft:Storage._cached,confirmed:Storage._readConfirmed('user-1'),state:Storage.getSyncStatus().state};
    });
    assert.deepEqual(result.methods,['GET']);assert.match(result.error,/Account changed/);
    assert.deepEqual(result.draft.entities,{draft:true});assert.deepEqual(result.confirmed.payload.entities,{saved:true});assert.equal(result.state,'conflict');
  });
}
async function testHistoricalCopiesAreNeverReplayInputs() {
  await withPage(async page=>{
    const result=await page.evaluate(async()=>{
      backendClient={auth:{getUser:async()=>({data:{user:{id:'user-1'}}}),getSession:async()=>({data:{session:{access_token:'token',user:{id:'user-1'}}}})}};
      window.ELISTLY_API_URL='/mock';
      const historical='[{"payload":{"entities":{"private":true}}}]';
      localStorage.setItem('elistlyData:outbox:user-1',historical);
      const requests=[];
      window.fetch=async (_url,opts)=>{requests.push(opts.method);return new Response(JSON.stringify({payload:{entities:{remote:true}},updated_at:'server'}),{headers:{'Access-Control-Expose-Headers':'ETag',ETag:'"server"'}})};
      const data=await Storage.getAppData();
      return {data,requests,historical:localStorage.getItem('elistlyData:outbox:user-1'),confirmed:Storage._readConfirmed('user-1')};
    });
    assert.deepEqual(result.data.entities,{remote:true});assert.deepEqual(result.requests,['GET']);
    assert.equal(result.historical,'[{"payload":{"entities":{"private":true}}}]');
    assert.deepEqual(result.confirmed.payload.entities,{remote:true});
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
    assert.equal(observed.failed.hidden, false);
    assert.match(observed.failed.text, /Changes could not be synced.*Refresh account data/);
    assert.equal(observed.failed.state, 'failed');
    assert.equal(observed.failed.live, 'polite');
  });
}

async function testSyncStatusIsAccessibleInTheApplication() {
  await withPage(async page => {
    const observed = await page.evaluate(() => {
      Storage._setSyncStatus('failed', 'Changes could not be synced. Local changes are retained.');
      const status = document.getElementById('syncStatus');
      return status && { text: status.textContent, state: status.dataset.state, live: status.getAttribute('aria-live') };
    });

    assert.match(observed.text, /Changes could not be synced.*Refresh account data/);
    assert.equal(observed.state, 'failed');
    assert.equal(observed.live, 'polite');
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
    await page.waitForFunction(() => !Storage._isDirty && Storage.getSyncStatus().state === 'synced');
    const persistedAfterNamingSave = structuredClone(remote);

    // A real page reload with no account cache must fetch the saved remote data.
    await page.evaluate(() => {
      localStorage.removeItem('elistlyData');
      localStorage.removeItem(Storage._getUserCacheKey('user-1'));
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
        return route.fulfill({ status: 200, headers:{'Access-Control-Expose-Headers':'ETag',ETag:`\"2026-09-15T00:00:0${writes.length}.000Z\"`}, contentType: 'application/json', body: JSON.stringify({ payload: remote, updated_at: `2026-09-15T00:00:0${writes.length}.000Z` }) });
      }
      return route.fulfill({ status: 200, headers:{'Access-Control-Expose-Headers':'ETag',ETag:'\"2026-09-15T00:00:00.000Z\"'}, contentType: 'application/json', body: JSON.stringify({ payload: remote, updated_at: '2026-09-15T00:00:00.000Z' }) });
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
    await page.waitForFunction(() => !Storage._isDirty && Storage.getSyncStatus().state === 'synced');
    await page.evaluate(() => {
      localStorage.removeItem('elistlyData');
      localStorage.removeItem(Storage._getUserCacheKey('empty-active-user'));
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
        return route.fulfill({ status: 200, headers:{'Access-Control-Expose-Headers':'ETag',ETag:`\"2026-09-15T00:10:0${writes.length}.000Z\"`}, contentType: 'application/json', body: JSON.stringify({ payload: remote, updated_at: `2026-09-15T00:10:0${writes.length}.000Z` }) });
      }
      return route.fulfill({ status: 200, headers:{'Access-Control-Expose-Headers':'ETag',ETag:'\"2026-09-15T00:10:00.000Z\"'}, contentType: 'application/json', body: JSON.stringify({ payload: remote, updated_at: '2026-09-15T00:10:00.000Z' }) });
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
      localStorage.setItem(Storage._getUserCacheKey('user-legacy'), JSON.stringify({format:'server-ack-v1',payload:saved,revision:'2026-09-15T00:00:00.000Z'}));
      Storage._cached = null;
      Storage._cachedUserId = null;
      Storage._isDirty = false;
      Storage._saveChain = Promise.resolve();
      backendClient = { auth: {
        getUser: async () => ({ data: { user: { id: 'user-legacy' } } }),
        getSession: async () => ({ data: { session: { access_token: 'token', user: { id: 'user-legacy' } } } })
      } };
      window.ELISTLY_API_URL = '/mock';
      window.fetch = async url => String(url).endsWith('/admin/me')
        ? new Response(JSON.stringify({ admin: false }), { status: 200 })
        : new Response(JSON.stringify({ payload: saved, updated_at: '2026-09-15T00:00:00.000Z' }), { status: 200,headers:{'Access-Control-Expose-Headers':'ETag',ETag:'\"2026-09-15T00:00:00.000Z\"'} });
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
      Storage._saveChain = Promise.resolve();
      await App.init();
      return { hydrated, reloaded: structuredClone(App.data) };
    });
    for (const snapshot of [observed.hydrated, observed.reloaded]) {
      assert.deepEqual(Object.keys(snapshot.entities), ['computer-legacy'], 'a legacy detached type must not erase its saved devices');
      assert.deepEqual(snapshot.entityTypes.computer.categories, [], 'a legacy detached type must not be guessed or reassigned');
    }
  });
}

async function run() {
  await testConfirmedSaveAndSerialRevision();
  await testFailedSaveRetainsOnlyAcknowledgedCacheAndInMemoryDraft();
  await testFailedRetryChecksLatestWithoutRebasing();
  await testHistoricalCopiesAreNeverReplayInputs();
  await testHealthySyncStatusIsHiddenWhileFailuresRemainAccessible();
  await testSyncStatusIsAccessibleInTheApplication();
  await testRemoteHydrationRetainsUnknownTopLevelAccountData();
  await testWorkspaceOnlyAccountDataSurvivesInitNamingSaveAndReload();
  await testEmptyActiveWorkspaceHydratesInactiveWorkspaceAndAccountSettings();
  await testLegacyDetachedTypeCategorySurvivesWorkspaceHydration();
}
run().then(()=>console.log('PASS revision persistence')).catch(error=>{console.error(`FAIL revision persistence: ${error.stack||error.message}`);process.exitCode=1});
