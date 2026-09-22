import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {chromium} from '../worker/node_modules/playwright/index.mjs';
import {PGlite} from '../worker/node_modules/@electric-sql/pglite/dist/index.js';
import {createWorker} from '../worker/src/index.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'elistly-sync-'));
const db=new PGlite(path.join(dir,'db')); await db.exec(fs.readFileSync(path.join(root,'neon/schema.sql'),'utf8'));
const sql=async(strings,...values)=>{try{return (await db.query(strings.reduce((s,v,i)=>s+v+(i<values.length?'$'+(i+1):''),''),values)).rows;}catch(error){console.error('Synthetic SQL failure:',error.message);throw error;}};
const tokens=Object.fromEntries(['owner','other'].map(id=>[id,'test.'+Buffer.from(JSON.stringify({sub:id,exp:4102444800})).toString('base64url')+'.test']));
const worker=createWorker({createSql:()=>sql,authenticate:async req=>{const id=Object.keys(tokens).find(id=>req.headers.get('Authorization')==='Bearer '+tokens[id]);return id?{id}:null;},checkAdmin:async()=>false});
let failedRead=false, failedWrite=false, lostWrite=false, writes=0, readGate=null, adminGate=null;
const server=http.createServer(async(req,res)=>{
 try {
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname.startsWith('/api/')) {
   if(req.method==='GET' && url.pathname==='/api/app-data' && readGate) await readGate;
   if(url.pathname==='/api/admin/me' && adminGate) await adminGate;
   if(url.pathname==='/api/app-data' && ((failedRead && req.method==='GET') || (failedWrite && req.method==='PUT'))) {res.writeHead(503).end('{}');return;}
   const chunks=[];for await(const c of req) chunks.push(c);
   const response=await worker.fetch(new Request('https://api.test'+url.pathname.slice(4),{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks).toString()}),{ELISTLY_ALLOWED_ORIGINS:`http://127.0.0.1:${server.address().port}`});
   if(req.method==='PUT') writes++;
   if(lostWrite && req.method==='PUT' && response.ok) {lostWrite=false;res.writeHead(503).end('{}');return;}
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;
  }
  if(url.pathname==='/sync-harness') {res.setHeader('Content-Type','text/html');res.end('<script src="/config.js"></script><script src="/lib/db.js"></script><script src="/app.js"></script><script>App.init=async()=>ensureBackendClient();</script>');return;}
  if(url.pathname==='/config.js') {res.setHeader('Content-Type','application/javascript');res.end(`window.ELISTLY_API_URL=location.origin+'/api';window.NEON_AUTH_URL=location.origin+'/auth';`);return;}
  const file=path.resolve(root,'.'+url.pathname);
  if(!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {res.writeHead(404).end();return;}
  res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream');res.end(fs.readFileSync(file));
 } catch(error) {console.error(error.message);res.writeHead(500).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
const contexts=[await browser.newContext(),await browser.newContext()];
const pages=[];
async function row(){return (await db.query("SELECT payload, updated_at::text AS updated_at FROM app_data WHERE user_id='owner'")).rows[0];}
async function load(page){return page.evaluate(async()=>{const data=await Storage.getAppData();try{await Storage._refreshPromise;}catch(_){}return Storage._cached || data;});}
async function save(page,name){return page.evaluate(async name=>{const data=structuredClone(Storage._cached);data.entities.record.name=name;try{await Storage.setAppData(data);return null;}catch(e){return e.message;}},name);}
try {
 for(const context of contexts){await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());const page=await context.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/sync-harness`);await page.evaluate(token=>localStorage.setItem('elistly_token',token),tokens.owner);pages.push(page);}
 const [work,home]=pages;
 const data={version:'test',settings:{},entityTypes:{},categories:{},entities:{record:{id:'record',name:'Server original'}}};
 await db.query("INSERT INTO app_data(user_id,payload,updated_at) VALUES ('owner',$1::jsonb,'2026-09-17T06:11:53.746204Z')",[JSON.stringify(data)]);
 await home.evaluate(()=>localStorage.setItem('elistlyData:outbox:owner',JSON.stringify([{id:'obsolete',payload:{entities:{obsolete:{name:'Old local'}}},expectedUpdatedAt:null,createdAt:'2026-09-15T00:00:00Z'}])));
 assert.deepEqual((await load(home)).entities,data.entities);
 const recovery=await home.evaluate(()=>Storage.getConflictRecovery());
 assert.equal(recovery.outbox[0].expectedUpdatedAt,null);
 assert.equal(recovery.outbox[0].createdAt,'2026-09-15T00:00:00Z');
 assert.equal(writes,0,'startup must not overwrite remote');
 assert.equal(await save(home,'Home edit'),null);
 assert.equal((await load(work)).entities.record.name,'Home edit');
 assert.equal(await save(work,'Work edit'),null);
 assert.equal((await load(home)).entities.record.name,'Work edit');
 // Two independent browser profiles race on the same server revision.
 const results=await Promise.all([save(work,'Work concurrent'),save(home,'Home concurrent')]);
 assert.equal(results.filter(x=>x===null).length,1,'exactly one conditional write succeeds');
 const loser=results[0]===null?home:work;
 const winner=(await row()).payload;
 assert.deepEqual((await load(loser)).entities,winner.entities);
 assert.ok(await loser.evaluate(()=>Storage.getConflictRecovery()));
 // Current pending state remains usable offline and synchronizes on retry.
 failedWrite=true;assert.ok(await save(work,'Offline edit'));assert.ok(await save(work,'Offline edit 2'));failedRead=true;
 assert.equal((await load(work)).entities.record.name,'Offline edit 2');
 failedRead=false;failedWrite=false;
 assert.equal((await load(work)).entities.record.name,'Offline edit 2');
 await work.evaluate(()=>Storage.retryPendingSaves());
 assert.equal((await row()).payload.entities.record.name,'Offline edit 2');
 // A successful commit with a lost response is acknowledged by exact readback.
 lostWrite=true;assert.ok(await save(work,'Lost response'));
 const writesBeforeRead=writes;
 assert.equal((await load(work)).entities.record.name,'Lost response');
 assert.equal(await work.evaluate(()=>Storage._readOutbox('owner').length),0);
 assert.equal(writes,writesBeforeRead,'readback must not replay a confirmed payload');
 // A second tab must not attach stale edits as children of the first tab's queue.
 const sibling=await contexts[0].newPage();await sibling.goto(`http://127.0.0.1:${server.address().port}/sync-harness`);await load(sibling);
 await load(work);failedWrite=true;assert.ok(await save(work,'First tab pending'));
 assert.ok(await save(sibling,'Stale second tab'));
 failedWrite=false;
 try {await work.evaluate(()=>Storage.retryPendingSaves());}catch(_){}
 try {await sibling.evaluate(()=>Storage.retryPendingSaves());}catch(_){}
 assert.equal((await row()).payload.entities.record.name,'First tab pending','a stale tab cannot overwrite another tab by borrowing its acknowledgement');
 // Exercise the real app's cached first render while account GET and unrelated admin are held.
 const fixture=await work.evaluate(()=>{
  const categories={hardware:{id:'hardware',label:'Hardware',icon:'devices',enabled:true}};
  const entityTypes={device:{id:'device',label:'Device',icon:'computer',enabled:true,categories:['hardware'],fields:[],associations:[]}};
  const entities={one:{id:'one',type:'device',name:'Fresh visible inventory'}};
  return {version:CURRENT_VERSION,onboardingDone:true,settings:App.normalizeSettings({}),categories,entityTypes,entities,workspaces:{default:{name:'Lab',categories,entityTypes,entities}},currentWorkspaceId:'default'};
 });
 await db.query("UPDATE app_data SET payload=$1::jsonb, updated_at=clock_timestamp() WHERE user_id='owner'",[JSON.stringify(fixture)]);
 const remoteRow=await row();const cachedFixture=structuredClone(fixture);
 cachedFixture.entities.one.name='Cached visible inventory';cachedFixture.workspaces.default.entities.one.name='Cached visible inventory';
 const uiContext=await browser.newContext();
 await uiContext.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await uiContext.addInitScript(({token,payload})=>{localStorage.setItem('elistly_token',token);localStorage.setItem('elistlyData:user:owner',JSON.stringify(payload));localStorage.setItem('elistlyData:userUpdated:owner','2026-09-01T00:00:00.000000Z');},{token:tokens.owner,payload:cachedFixture});
 let releaseRead,releaseAdmin;readGate=new Promise(r=>releaseRead=r);adminGate=new Promise(r=>releaseAdmin=r);
 const ui=await uiContext.newPage();await ui.goto(`http://127.0.0.1:${server.address().port}/app.html`,{waitUntil:'domcontentloaded'});
 await ui.waitForFunction(()=>App._isReady);
 const warmMs=await ui.evaluate(()=>performance.now());
 assert.match(await ui.locator('#mainContent').textContent(),/Cached visible inventory/);
 assert.match(await ui.locator('#syncStatus').textContent(),/Refreshing/);
 assert.equal(await ui.locator('#mainContent').evaluate(el=>el.inert),true);
 const beforeRefreshWrites=writes;const refreshStart=Date.now();readGate=null;releaseRead();
 await ui.waitForFunction(()=>Storage._accountVerified===true);
 assert.match(await ui.locator('#mainContent').textContent(),/Fresh visible inventory/);
 assert.equal(await ui.locator('#mainContent').evaluate(el=>el.inert),false);
 assert.equal(writes,beforeRefreshWrites,'cache display must not save normalized stale data');
 const freshMs=Date.now()-refreshStart;adminGate=null;releaseAdmin();
 await ui.screenshot({path:path.join(root,'.hermes/sync-repair-warm.png')});
 // Recovery review must actually overlay the viewport, close, and reopen without changing either copy.
 await ui.evaluate(recovery=>{
  localStorage.setItem(Storage.USER_RECOVERY_PREFIX+'owner',JSON.stringify([recovery]));
  Storage._conflictRecovery=recovery;
  App.renderSyncStatus();
 },recovery);
 const recoveryBefore=await ui.evaluate(()=>localStorage.getItem(Storage.USER_RECOVERY_PREFIX+'owner'));
 const accountBefore=await row();
 for (const viewport of [{width:1280,height:720},{width:390,height:844}]) {
  await ui.setViewportSize(viewport);
  await ui.getByRole('button',{name:'Review preserved local changes'}).click();
  const dialog=ui.locator('#syncRecoveryModal');
  assert.equal(await dialog.evaluate(el=>getComputedStyle(el).position),'fixed','recovery review must overlay the app, not render below its viewport');
  await dialog.getByRole('button',{name:'Keep both copies'}).click({timeout:2000});
  await dialog.waitFor({state:'detached'});
  assert.equal(await ui.evaluate(()=>localStorage.getItem(Storage.USER_RECOVERY_PREFIX+'owner')),recoveryBefore);
  assert.deepEqual(await row(),accountBefore);
  assert.equal(await ui.locator('#mainContent').evaluate(el=>el.inert),false);
 }
 // Removing the recovery archive must clear the notice, but never delete account inventory.
 await ui.setViewportSize({width:1280,height:720});
 await ui.getByRole('button',{name:'Review preserved local changes'}).click();
 const backupEvent=ui.waitForEvent('download');
 await ui.getByRole('button',{name:'Download local backup',exact:true}).click();
 const backup=await backupEvent;
 const archive=JSON.parse(fs.readFileSync(await backup.path(),'utf8'));
 assert.deepEqual(archive.records,JSON.parse(recoveryBefore));
 await ui.getByRole('button',{name:'Remove downloaded browser copy',exact:true}).click();
 await ui.getByRole('button',{name:'I saved the archive — remove browser copy',exact:true}).click();
 await ui.locator('#syncRecoveryModal').waitFor({state:'detached'});
 assert.equal(await ui.evaluate(()=>localStorage.getItem(Storage.USER_RECOVERY_PREFIX+'owner')),null);
 assert.equal(await ui.getByRole('button',{name:'Review preserved local changes'}).count(),0);
 assert.deepEqual(await row(),accountBefore);
 // Empty cache must not offer destructive setup before or after populated refresh.
 const emptyContext=await browser.newContext();
 await emptyContext.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await emptyContext.addInitScript(token=>{localStorage.setItem('elistly_token',token);localStorage.setItem('elistlyData:user:owner',JSON.stringify({entities:{},categories:{},entityTypes:{}}));},tokens.owner);
 readGate=new Promise(r=>releaseRead=r);
 const empty=await emptyContext.newPage();await empty.goto(`http://127.0.0.1:${server.address().port}/app.html`,{waitUntil:'domcontentloaded'});
 await empty.waitForFunction(()=>App._isReady);
 // Exceed the old 100 ms setup timer while the authoritative response is held.
 await empty.waitForTimeout(150);
 const prematureSetup=await empty.locator('#onboardingModal').count();
 readGate=null;releaseRead();
 assert.equal(prematureSetup,0,'unverified empty cache must not offer setup');await empty.waitForFunction(()=>Storage._accountVerified);
 assert.equal(await empty.locator('#onboardingModal').count(),0,'populated authoritative account must not offer setup');
 assert.match(await empty.locator('#mainContent').textContent(),/Fresh visible inventory/);
 // Cold real-app startup with an isolated browser and no cached account snapshot.
 const coldContext=await browser.newContext();await coldContext.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await coldContext.addInitScript(token=>localStorage.setItem('elistly_token',token),tokens.owner);
 const cold=await coldContext.newPage();await cold.goto(`http://127.0.0.1:${server.address().port}/app.html`,{waitUntil:'domcontentloaded'});await cold.waitForFunction(()=>App._isReady && Storage._accountVerified);
 const coldMs=await cold.evaluate(()=>performance.now());
 assert.match(await cold.locator('#mainContent').textContent(),/Fresh visible inventory/);
 // A genuinely empty authoritative account still receives setup, isolated from owner.
 const newContext=await browser.newContext();await newContext.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await newContext.addInitScript(token=>localStorage.setItem('elistly_token',token),tokens.other);
 const newcomer=await newContext.newPage();await newcomer.goto(`http://127.0.0.1:${server.address().port}/app.html`,{waitUntil:'domcontentloaded'});
 await newcomer.locator('#onboardingModal').waitFor({state:'visible'});
 assert.equal(await newcomer.evaluate(()=>Storage._accountVerified),true);
 assert.equal((await row()).payload.entities.one.name,'Fresh visible inventory','another account setup does not mutate owner');
 console.log(JSON.stringify({environment:'loopback real app + Worker + file-backed PGlite; headless Chrome; external assets blocked',warmFirstRenderMs:Math.round(warmMs),freshAfterReleasingHeldGETMs:freshMs,coldFirstFreshRenderMs:Math.round(coldMs)}));
 console.log('PASS: durable PostgreSQL, independent profiles, null-base recovery, current offline queue, conflicts, lost response, stale same-profile tab');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));await db.close();fs.rmSync(dir,{recursive:true,force:true});}
