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

async function run() {
  await withPage(async page => {
    await configureAccount(page, () => {
      window.fetch = () => new Promise(resolve => { window.finishRefresh = resolve; });
    });
    const warm = await page.evaluate(async () => {
      const cached = { entities: { cached: {} } };
      localStorage.setItem('elistlyData:user:account-a', JSON.stringify(cached));
      localStorage.setItem('elistlyData:userUpdated:account-a', 'old');
      const started = performance.now();
      const data = await Storage.getAppData({ onRemoteSync: data => { window.adopted = data; return true; } });
      return { data, state: Storage.getSyncStatus().state, readStarted: !!window.finishRefresh, elapsed: performance.now()-started };
    });
    assert.equal(warm.readStarted, true);
    assert.equal(warm.state, 'refreshing', 'cached data must visibly be checking the server');
    assert.deepEqual(warm.data.entities, { cached: {} });
    assert.ok(warm.elapsed < 250, 'cached return must not wait for the held remote response');
    const fresh = await page.evaluate(async () => {
      finishRefresh(new Response(JSON.stringify({ payload: { entities: { fresh: {} } }, updated_at: 'new' }), {status:200}));
      await Storage._refreshPromise;
      return { adopted, state: Storage.getSyncStatus().state, revision: Storage._cachedUpdatedAt };
    });
    assert.deepEqual(fresh.adopted.entities, { fresh: {} });
    assert.equal(fresh.state,'synced');
    assert.equal(fresh.revision,'new');
    // A callback veto represents an open editor: neither its base nor cache may advance.
    const veto = await page.evaluate(async () => {
      await Storage.getAppData({onRemoteSync:()=>false});
      finishRefresh(new Response(JSON.stringify({payload:{entities:{elsewhere:{}}},updated_at:'newer'}),{status:200}));
      await Storage._refreshPromise;
      return {revision:Storage._cachedUpdatedAt,cached:Storage._cached,status:Storage.getSyncStatus().state};
    });
    assert.equal(veto.revision,'new','an unadopted refresh cannot authorize a stale editor overwrite');
    assert.deepEqual(veto.cached.entities,{fresh:{}});
    assert.equal(veto.status,'stale');
    const failed = await page.evaluate(async()=>{
      await Storage.getAppData();
      finishRefresh(new Response('{}',{status:503}));
      try {await Storage._refreshPromise;}catch(_){}
      return {cached:Storage._cached,state:Storage.getSyncStatus().state};
    });
    assert.deepEqual(failed.cached.entities,{fresh:{}});
    assert.equal(failed.state,'failed');
    const same = await page.evaluate(async()=>{
      let redraws=0;
      await Storage.getAppData({onRemoteSync:()=>{redraws++;}});
      finishRefresh(new Response(JSON.stringify({payload:{entities:{fresh:{}}},updated_at:'new'}),{status:200}));
      await Storage._refreshPromise;
      return {redraws,state:Storage.getSyncStatus().state};
    });
    assert.deepEqual(same,{redraws:0,state:'synced'});
  });
  await withPage(async page => {
    await configureAccount(page, () => {
      window.sent = [];
      window.fetch = async (_url, options) => {
        const body=JSON.parse(options.body); sent.push(body);
        return new Response(JSON.stringify({payload:body.payload,updated_at:sent.length===1?'restored-revision':'edited-revision'}),{status:200});
      };
    });
    const sent=await page.evaluate(async()=>{
      Storage._cachedUserId='account-a';Storage._cachedUpdatedAt='old-revision';
      await Storage.setAppDataForImport({entities:{restored:{}}},{userId:'account-a',accessToken:'test-token',expectedUpdatedAt:'old-revision'});
      await Storage.setAppData({entities:{edited:{}}});return window.sent;
    });
    assert.equal(sent[1].expectedUpdatedAt,'restored-revision','ordinary edit after restore uses the acknowledged restore revision');
  });
  console.log('PASS cached startup: immediate cached data, request started, visible refresh, safe adoption, failed/stale states, no unchanged redraw');
}
run().catch(error=>{console.error(error);process.exitCode=1;});
