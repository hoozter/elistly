'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8').split("window.addEventListener('beforeunload'")[0];
const payload = name => ({entities:{record:{name}}});
function gate() { let release; const promise = new Promise(resolve => {release=resolve;}); return {promise,release}; }
function harness(fetch) {
  const entries = new Map();
  const localStorage = {get length(){return entries.size;}, key:i=>[...entries.keys()][i], getItem:k=>entries.get(k) ?? null, setItem:(k,v)=>entries.set(k,String(v)), removeItem:k=>entries.delete(k)};
  const user = {id:'owner'};
  const session = {user,access_token:'test.'+Buffer.from(JSON.stringify({sub:'owner',exp:4102444800})).toString('base64url')+'.test'};
  const context = vm.createContext({console,structuredClone,AbortSignal,Response,FormData,Blob,atob,localStorage,fetch,CustomEvent:class {},window:{ELISTLY_API_URL:'https://test/api',dispatchEvent(){}},CURRENT_VERSION:'test'});
  context.client = {auth:{getSession:async()=>({data:{session}}),getUser:async()=>({data:{user}})}};
  vm.runInContext(source + '\nthis.store = Storage; backendClient = this.client;', context);
  const store = context.store;
  store._cachedUserId='owner';store._cached=payload('old');store._cachedUpdatedAt='rev0';store._accountVerified=true;
  store._writeConfirmed('owner',payload('old'),'rev0');
  return {store,localStorage};
}
function response(name, revision='rev1', status=200) { return new Response(JSON.stringify({payload:payload(name),updated_at:revision}),{status,headers:{ETag:`"${revision}"`}}); }

test('quick edits serialize, acknowledge both, and keep only confirmed data in persistent cache', async()=>{
  const started=gate(), release=gate(), writes=[];
  const {store}=harness(async(_url, options)=>{
    const data=JSON.parse(options.body).payload; writes.push({name:data.entities.record.name,match:options.headers['If-Match']});
    if (writes.length===1) {started.release();await release.promise;}
    return response(data.entities.record.name,`rev${writes.length}`);
  });
  const first=store.setAppData(payload('first'));
  await started.promise;
  assert.equal((await store.getAppData()).entities.record.name,'first');
  assert.equal(store._accountVerified,true,'reopening a verified pending draft must not disable subsequent edits');
  const second=store.setAppData(payload('second'));
  const done=Promise.allSettled([first,second]);
  assert.equal(store._readConfirmed('owner').payload.entities.record.name,'old');
  release.release();
  const results=await done;
  assert.equal(results.every(r=>r.status==='fulfilled'),true,'both user edits must save');
  assert.deepEqual(writes,[{name:'first',match:'"rev0"'},{name:'second',match:'"rev1"'}]);
  assert.equal(store._cached.entities.record.name,'second');
  assert.equal(store._readConfirmed('owner').payload.entities.record.name,'second');
  assert.equal(store._isDirty,false);
});

test('a refresh started during a save cannot replace its acknowledgement', async()=>{
  const putStarted=gate(), putRelease=gate(), getRelease=gate();
  const {store}=harness(async(_url, options)=>{
    if (options.method==='PUT') {putStarted.release();await putRelease.promise;return response('saved','rev1');}
    await getRelease.promise;return response('old','rev0');
  });
  const saving=store.setAppData(payload('saved'));await putStarted.promise;
  await store.getAppData();const refreshing=store._refreshPromise;
  putRelease.release();await saving;getRelease.release();await refreshing;
  assert.equal(store._cached.entities.record.name,'saved','late old GET must not undo saved data');
  assert.equal(store._cachedUpdatedAt,'rev1');
  assert.equal(store._readConfirmed('owner').payload.entities.record.name,'saved');
});

test('reopening data returns the open unsaved draft, never the older confirmed cache', async()=>{
  const {store}=harness(async()=>new Response('{}',{status:503}));
  await assert.rejects(store.setAppData(payload('draft')));
  assert.equal((await store.getAppData()).entities.record.name,'draft');
  assert.equal(store._readConfirmed('owner').payload.entities.record.name,'old');
  assert.equal(store.getSyncStatus().state,'failed');
  await store._refreshPromise?.catch(()=>{});
});

test('failed save retries the latest draft without losing subsequent edits', async()=>{
  let offline=true, revision='rev0', name='old', puts=0;
  const {store}=harness(async(_url, options)=>{
    if (offline) return new Response('{}',{status:503});
    if (options.method==='PUT') {puts++;assert.equal(options.headers['If-Match'],'"rev0"');name=JSON.parse(options.body).payload.entities.record.name;revision='rev1';}
    return response(name,revision);
  });
  await assert.rejects(store.setAppData(payload('draft')));
  await assert.rejects(store.setAppData(payload('latest draft')));
  assert.equal(store._cached.entities.record.name,'latest draft');
  offline=false;await store.retrySave();
  assert.equal(puts,1);
  assert.equal(name,'latest draft');assert.equal(store._isDirty,false);
});

test('historical unsaved copies survive sign-out until explicitly approved for discard', async()=>{
  const {store,localStorage}=harness(async()=>response('old','rev0'));
  const key='elistlyData:recovery:owner', value=JSON.stringify([{payload:payload('historical draft')}]);
  localStorage.setItem(key,value);
  await assert.rejects(store.prepareForSignOut(), /preserved local/i);
  assert.equal(localStorage.getItem(key),value);
  await store.prepareForSignOut({discardHistoricalCopies:[{key,value}]});
  assert.equal(localStorage.getItem(key),null);
});

test('retry verifies a lost acknowledgement without writing again', async()=>{
  let name='old',revision='rev0',puts=0;
  const {store}=harness(async(_url,options)=>{
    if(options.method==='PUT') {puts++;name=JSON.parse(options.body).payload.entities.record.name;revision='rev1';throw new Error('response lost after commit');}
    return response(name,revision);
  });
  await assert.rejects(store.setAppData(payload('saved despite lost response')));
  await store.retrySave();
  assert.equal(puts,1);assert.equal(store._isDirty,false);
  assert.equal(store._readConfirmed('owner').revision,'rev1');
});

test('retry does not rebase a draft over another browser save', async()=>{
  let puts=0;
  const {store}=harness(async(_url,options)=>{
    if(options.method==='PUT') {puts++;return new Response('{}',{status:412});}
    return response('other browser','rev2');
  });
  await assert.rejects(store.setAppData(payload('my unsaved draft')));
  await assert.rejects(store.retrySave(), /Account changed/);
  assert.equal(puts,1);assert.equal(store._cached.entities.record.name,'my unsaved draft');
  assert.equal(store.getSyncStatus().state,'conflict');assert.equal(store._isDirty,true);
  assert.equal((await store.discardDraftAndRefresh()).entities.record.name,'other browser');
  assert.equal(store._isDirty,false);assert.equal(store._cachedUpdatedAt,'rev2');
});

test('sign-out consent cannot discard a historical copy changed after confirmation', async()=>{
  const {store,localStorage}=harness(async()=>response('old','rev0'));
  const key='elistlyData:outbox:owner',before=JSON.stringify([{payload:payload('first')}]),after=JSON.stringify([{payload:payload('new copy')}]);
  localStorage.setItem(key,before);const consent=store.getHistoricalCopies();localStorage.setItem(key,after);
  await assert.rejects(store.prepareForSignOut({discardHistoricalCopies:consent}), /Preserved local/);
  assert.equal(localStorage.getItem(key),after);
});
