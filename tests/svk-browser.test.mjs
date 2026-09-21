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
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'elistly-svk-browser-'));
const db=new PGlite(); await db.exec(fs.readFileSync(path.join(root,'neon/schema.sql'),'utf8'));
const fixture=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/svk/01-installation.json')));
fixture.hostname='<img src=x onerror=window.__svkXss=1>';
const filename='<img onerror=alert(1)>.json';
fs.mkdirSync(path.join(dir,'Inventory'));fs.writeFileSync(path.join(dir,'Inventory',filename),JSON.stringify(fixture));
fs.copyFileSync(path.join(root,'tests/fixtures/svk/02-service-missing-identity.json'),path.join(dir,'Inventory','missing.json'));
fs.writeFileSync(path.join(dir,'Inventory','broken.json'),'bad');fs.writeFileSync(path.join(dir,'Inventory','report.json.pending'),'incomplete');fs.writeFileSync(path.join(dir,'Inventory','notes.txt'),'not a report');
const sql=async(strings,...values)=>(await db.query(strings.reduce((s,v,i)=>s+v+(i<values.length?'$'+(i+1):''),''),values)).rows;
const token='test.'+Buffer.from(JSON.stringify({sub:'browser-owner',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.test';
const worker=createWorker({createSql:()=>sql,authenticate:async req=>req.headers.get('Authorization')==='Bearer '+token ? {id:'browser-owner'} : null,checkAdmin:async()=>false});
let lostResponse=false, refreshHook=null;
const server=http.createServer(async(req,res)=>{
 try {
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname.startsWith('/api/')) {
   const chunks=[];for await(const c of req) chunks.push(c);
   const raw=Buffer.concat(chunks).toString();
   const response=await worker.fetch(new Request('https://api.test'+url.pathname.slice(4)+url.search,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:raw}),{ELISTLY_ALLOWED_ORIGINS:`http://127.0.0.1:${server.address().port}`});
   if(lostResponse && url.pathname==='/api/inventory-import' && !JSON.parse(raw).preview) {lostResponse=false;res.writeHead(503).end();return;}
   if(refreshHook && url.pathname==='/api/app-data' && req.method==='GET') {const hook=refreshHook;refreshHook=null;await hook();}
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;
  }
  if(url.pathname==='/config.js') {res.setHeader('Content-Type','application/javascript');res.end(`window.ELISTLY_API_URL=location.origin+'/api';window.NEON_AUTH_URL=location.origin+'/auth';`);return;}
  const file=path.resolve(root,'.'+url.pathname);
  if(!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {res.writeHead(404).end();return;}
  res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream');res.end(fs.readFileSync(file));
 } catch(error) {console.error(error.message);res.writeHead(500).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN || '/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
const page=await browser.newPage();
let dialogs=0;page.on('dialog',async d=>{dialogs++;await d.dismiss();});
await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
try {
 // Seed the actual IT preset into an isolated database before authenticating.
 await page.goto(`http://127.0.0.1:${server.address().port}/app.html`);
 const payload=await page.evaluate(()=>({version:'1.12.1',onboardingDone:true,currentWorkspaceId:'main',settings:App.normalizeSettings({}),workspaces:{main:{name:'Synthetic lab',categories:window.ELISTLY_PRESETS.it.categories,entityTypes:window.ELISTLY_PRESETS.it.entityTypes,entities:{}}}}));
 await db.query('INSERT INTO app_data(user_id,payload) VALUES ($1,$2::jsonb)',['browser-owner',JSON.stringify(payload)]);
 await page.evaluate(token=>localStorage.setItem('elistly_token',token),token);await page.reload();
 await page.waitForFunction(()=>App.data.currentWorkspaceId==='main' && !ElistlyStorage._isDirty);
 await page.evaluate(()=>App.showSvkInventoryImport());
 const modal=page.locator('#svkImportModal');
 await page.waitForFunction(()=>!document.querySelector('#svkFolder').disabled);
 await modal.locator('#svkFolder').setInputFiles(path.join(dir,'Inventory'));
 await modal.getByText('Preview only.',{exact:false}).waitFor();
 assert.match(await modal.locator('#svkPreview').textContent(),/New/);
 assert.match(await modal.locator('#svkAttention').textContent(),/Incomplete.*pending/);
 assert.equal((await db.query('SELECT count(*) FROM inventory_import_reports')).rows[0].count,0);
 await modal.getByRole('button',{name:'Import all eligible reports',exact:true}).click();
 await modal.getByText('1 files confirmed durably saved.',{exact:false}).waitFor();
 assert.match(await modal.locator('#svkSafe').textContent(),/<img onerror=alert\(1\)>\.json/);
 assert.match(await modal.locator('#svkAttention').textContent(),/missing.json/);
 assert.equal(await modal.locator('img').count(),0);assert.equal(dialogs,0);
 const [stored]=(await db.query('SELECT payload FROM app_data WHERE user_id=$1',['browser-owner'])).rows;
 const device=Object.values(stored.payload.workspaces.main.entities)[0];assert.equal(device.hostname,fixture.hostname);
 const downloadPromise=page.waitForEvent('download');await modal.getByRole('button',{name:'Download receipt'}).click();
 const downloaded=await downloadPromise;const receipt=JSON.parse(fs.readFileSync(await downloaded.path(),'utf8'));
 assert.equal(receipt.safeToArchiveOrDelete.length,1);assert.equal(receipt.needsAttention.length,4);
 await page.reload();await page.waitForFunction(()=>App.data.currentWorkspaceId==='main');
 await page.evaluate(id=>App.showSvkInventoryHistory(id),device.id);
 await page.locator('#svkHistoryModal').getByText('Last inventoried:',{exact:false}).waitFor();
 assert.match(await page.locator('#svkHistoryModal').textContent(),/2026-09-21T09:00:00.0000000Z/);
 await page.locator('#svkHistoryModal').getByRole('button',{name:'Close',exact:true}).click();
 // Multi-file fallback; interrupted POST stays attention, retry confirms receipt.
 const next=structuredClone(fixture);next.reportId=crypto.randomUUID();next.collectedAt='2026-09-21T09:01:00.0000000Z';next.inventorySnapshot.collectedAt=next.collectedAt;
 const nextPath=path.join(dir,'next.json');fs.writeFileSync(nextPath,JSON.stringify(next));
 await page.evaluate(()=>App.showSvkInventoryImport());await page.waitForFunction(()=>!document.querySelector('#svkFiles').disabled);
 await modal.locator('#svkFiles').setInputFiles([nextPath]);await modal.getByText('Preview only.',{exact:false}).waitFor();
 lostResponse=true;await modal.getByRole('button',{name:'Import all eligible reports',exact:true}).click();
 await modal.getByText('0 files confirmed durably saved.',{exact:false}).waitFor();assert.match(await modal.locator('#svkAttention').textContent(),/unconfirmed/);
 await modal.getByRole('button',{name:'Preview / retry selection'}).click();await modal.getByText('Preview only.',{exact:false}).waitFor();
 assert.match(await modal.locator('#svkPreview').textContent(),/Already imported/);
 await modal.getByRole('button',{name:'Import all eligible reports',exact:true}).click();await modal.getByText('1 files confirmed durably saved.',{exact:false}).waitFor();
 assert.equal((await db.query('SELECT count(*) FROM inventory_import_reports')).rows[0].count,2);
 assert.equal(dialogs,0);
 // An ordinary save that completes during refresh must not be overwritten.
 await modal.getByRole('button',{name:'Preview / retry selection'}).click();await modal.getByText('Preview only.',{exact:false}).waitFor();
 refreshHook=async()=>{
  const current=(await db.query('SELECT payload FROM app_data WHERE user_id=$1',['browser-owner'])).rows[0].payload;
  current.workspaces.main.entities[device.id].name='Intervening saved name';current.entities={...current.workspaces.main.entities};
  const saved=(await db.query('UPDATE app_data SET payload=$1::jsonb,updated_at=clock_timestamp() WHERE user_id=$2 RETURNING payload,updated_at::text AS updated_at',[JSON.stringify(current),'browser-owner'])).rows[0];
  await page.evaluate(row=>{ElistlyStorage._writeUserCache('browser-owner',row.payload,row.updated_at);ElistlyStorage._cached=row.payload;App.applyRemoteSyncData(row.payload);},saved);
 };
 await modal.getByRole('button',{name:'Import all eligible reports',exact:true}).click();
 await modal.getByText('Inventory changed during refresh.',{exact:false}).waitFor();
 assert.equal(await page.evaluate(id=>App.data.entities[id].name,device.id),'Intervening saved name');
 assert.match(await modal.locator('#svkSafe').textContent(),/next.json/);
 if(process.env.SVK_SCREENSHOT) {
  await page.screenshot({path:process.env.SVK_SCREENSHOT});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:process.env.SVK_SCREENSHOT.replace(/\.png$/, '-mobile.png')});
 }
 await page.evaluate(()=>{ElistlyStorage._clearInMemoryAccountState();App.clearAccountRuntime();});
 assert.equal(await page.locator('#svkImportModal').count(),0);
 console.log('PASS: real folder input and multi-file fallback, preview without writes, persisted import/reload/history, two filename lists, hostile text, downloadable receipt, lost response and confirmed retry');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));await db.close();fs.rmSync(dir,{recursive:true,force:true});}
