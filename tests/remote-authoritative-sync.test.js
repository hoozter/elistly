#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {chromium} = require('/home/campbell/node_modules/playwright');
const root=path.resolve(__dirname,'..');
async function withPage(test) {
  const server=http.createServer((req,res)=>{
    const relative=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/+/, '')||'app.html';
    const file=path.resolve(root,relative);
    if(!file.startsWith(`${root}${path.sep}`)||!fs.existsSync(file)||fs.statSync(file).isDirectory())return res.writeHead(404).end();
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
  const page=await browser.newPage();
  await page.route('**/config.js',route=>route.fulfill({contentType:'application/javascript',body:'window.ELISTLY_API_URL="/mock";window.NEON_AUTH_URL="/mock-auth";'}));
  try{await page.goto(`http://127.0.0.1:${server.address().port}/app.html`,{waitUntil:'domcontentloaded'});await test(page)}
  finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
}
async function configure(page){await page.evaluate(()=>{
  backendClient={auth:{getUser:async()=>({data:{user:{id:'account-a'}}}),getSession:async()=>({data:{session:{access_token:'test-token',user:{id:'account-a'}}}})}};
  window.ELISTLY_API_URL='/mock';
});}
async function testRemoteIsAuthoritativeAndHistoricalCopiesStayReadOnly(){await withPage(async page=>{
  await configure(page);
  const result=await page.evaluate(async()=>{
    localStorage.setItem('elistlyData:outbox:account-a','[{"payload":{"entities":{"historical":true}}}]');
    localStorage.setItem('elistlyData:user:account-a',JSON.stringify({entities:{old:true}}));
    const methods=[];window.fetch=async(_url,opts)=>{methods.push(opts.method);return new Response(JSON.stringify({payload:{entities:{remote:true}},updated_at:'rev'}),{headers:{ETag:'"rev"'}})};
    const data=await Storage.getAppData();
    return {data,methods,confirmed:Storage._readConfirmed('account-a'),historical:Storage.getHistoricalCopies(),legacy:Storage.getLegacyAccountCopies()};
  });
  assert.deepEqual(result.data.entities,{remote:true});assert.deepEqual(result.methods,['GET']);
  assert.deepEqual(result.confirmed,{format:'server-ack-v1',payload:{entities:{remote:true}},revision:'rev'});
  assert.equal(result.historical.length,1);assert.equal(result.legacy.length,2);
});}
async function testOfflineNeverPromotesOldCacheOrOutbox(){await withPage(async page=>{
  await configure(page);
  const result=await page.evaluate(async()=>{
    localStorage.setItem('elistlyData:user:account-a',JSON.stringify({entities:{unconfirmed:true}}));
    localStorage.setItem('elistlyData:outbox:account-a','[{"payload":{"entities":{"draft":true}}}]');
    window.fetch=async()=>{throw Error('offline')};
    let error;try{await Storage.getAppData()}catch(e){error=e.message}
    return {error,confirmed:Storage._readConfirmed('account-a'),state:Storage.getSyncStatus().state,historical:Storage.getHistoricalCopies()};
  });
  assert.match(result.error,/offline/);assert.equal(result.confirmed,null);
  assert.equal(result.state,'failed');assert.equal(result.historical.length,1);
});}
async function testConfirmedCacheDisplaysWhileFailedRefreshPreservesIt(){await withPage(async page=>{
  await configure(page);
  const result=await page.evaluate(async()=>{
    const cache={entities:{acknowledged:true}};Storage._writeConfirmed('account-a',cache,'rev-1');
    window.fetch=async()=>new Response('{}',{status:503});
    const initial=await Storage.getAppData();await Storage._refreshPromise.catch(()=>{});
    return {initial,after:Storage._readConfirmed('account-a'),state:Storage.getSyncStatus().state,verified:Storage._accountVerified};
  });
  assert.deepEqual(result.initial.entities,{acknowledged:true});assert.equal(result.after.revision,'rev-1');
  assert.equal(result.state,'failed');assert.equal(result.verified,false);
});}
async function testLateReadCannotRepopulateInvalidatedAccount(){await withPage(async page=>{
  await configure(page);
  const result=await page.evaluate(async()=>{
    let release,started;const waiting=new Promise(resolve=>{started=resolve});
    window.fetch=async()=>{started();await new Promise(resolve=>{release=resolve});return new Response(JSON.stringify({payload:{entities:{remote:true}},updated_at:'rev'}),{headers:{ETag:'"rev"'}})};
    const loading=Storage.getAppData().catch(e=>e.message);await waiting;
    Storage._clearInMemoryAccountState();release();return {error:await loading,cached:Storage._cached,confirmed:Storage._readConfirmed('account-a')};
  });
  assert.match(result.error,/Account changed/);assert.equal(result.cached,null);assert.equal(result.confirmed,null);
});}
async function testNoAutomaticConflictRebase(){await withPage(async page=>{
  await configure(page);
  const result=await page.evaluate(async()=>{
    Storage._cachedUserId='account-a';Storage._accountVerified=true;Storage._cachedUpdatedAt='base';
    Storage._writeConfirmed('account-a',{entities:{saved:true}},'base');
    const requests=[];
    window.fetch=async(_url,opts)=>{requests.push({method:opts.method,headers:opts.headers});return new Response('{}',{status:412})};
    let error;try{await Storage.setAppData({entities:{draft:true}})}catch(e){error=e.message}
    return {error,requests,cache:Storage._readConfirmed('account-a'),draft:Storage._cached,state:Storage.getSyncStatus().state};
  });
  assert.match(result.error,/Account changed/);assert.equal(result.requests.length,1);
  assert.equal(result.requests[0].headers['If-Match'],'"base"');
  assert.deepEqual(result.cache.payload.entities,{saved:true});assert.deepEqual(result.draft.entities,{draft:true});assert.equal(result.state,'conflict');
});}
async function run(){await testRemoteIsAuthoritativeAndHistoricalCopiesStayReadOnly();await testOfflineNeverPromotesOldCacheOrOutbox();await testConfirmedCacheDisplaysWhileFailedRefreshPreservesIt();await testLateReadCannotRepopulateInvalidatedAccount();await testNoAutomaticConflictRebase();console.log('PASS remote-authoritative sync');}
run().catch(error=>{console.error(error);process.exitCode=1});
