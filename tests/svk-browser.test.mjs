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
fixture.inventorySnapshot.cpu.model='Intel(R) Core(TM) Ultra 5 125U';
fixture.inventorySnapshot.ramBytes=16619384832;
const filename='<img onerror=alert(1)>.json';
fs.mkdirSync(path.join(dir,'Inventory'));fs.writeFileSync(path.join(dir,'Inventory',filename),JSON.stringify(fixture));
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
 const payload=await page.evaluate(()=>{
  const preset=structuredClone(window.ELISTLY_PRESETS.it);const computer=preset.entityTypes.computer;
  for(const capability of ['computer.manufacturer','computer.model','processor.summary','memory.total','graphics.adapters','windows.edition','windows.version','windows.build','bios.serial-number']){
   if(!computer.fields.some(field=>field.collection?.provider==='windows'&&field.collection.capability===capability)) computer.fields.push({name:`reported_${capability.replaceAll('.','_')}`,label:capability,type:'text',collection:{provider:'windows',capability}});
  }
  computer.presetIds=['it'];
  // Stored pre-mapping IT schemas lack these annotations; do not idealize the fixture.
  for (const field of computer.fields.filter(field=>['cpu','ram'].includes(field.name))) delete field.collection;
  return {version:'1.12.1',onboardingDone:true,currentWorkspaceId:'main',settings:App.normalizeSettings({}),workspaces:{main:{name:'Synthetic lab',categories:preset.categories,entityTypes:preset.entityTypes,entities:{}}}};
 });
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
 assert.equal(await modal.locator('img').count(),0);assert.equal(dialogs,0);
 const [stored]=(await db.query('SELECT payload FROM app_data WHERE user_id=$1',['browser-owner'])).rows;
 const computerType=stored.payload.workspaces.main.entityTypes.computer;
 const device=Object.values(stored.payload.workspaces.main.entities)[0];assert.equal(device.hostname,fixture.hostname);
 const mapped=capability=>device[computerType.fields.find(field=>field.collection?.provider==='windows'&&field.collection.capability===capability)?.name];
 assert.equal(mapped('computer.manufacturer'),fixture.manufacturer);assert.equal(mapped('computer.model'),fixture.model);assert.equal(mapped('processor.summary'),'Intel Core Ultra 5');assert.equal(mapped('memory.total'),'16GB');assert.equal(mapped('graphics.adapters'),'Example Graphics');assert.equal(mapped('windows.edition'),fixture.windowsEdition);assert.equal(mapped('windows.version'),'10.0.26200');assert.equal(mapped('windows.build'),'26200');assert.equal(mapped('bios.serial-number'),fixture.serialNumber);
 assert.ok(device.autoName);assert.equal(device.name,undefined);
 const downloadPromise=page.waitForEvent('download');await modal.getByRole('button',{name:'Download receipt'}).click();
 const downloaded=await downloadPromise;const receipt=JSON.parse(fs.readFileSync(await downloaded.path(),'utf8'));
 assert.equal(receipt.safeToArchiveOrDelete.length,1);assert.equal(receipt.needsAttention.length,3);
 // Edit immediately after import, without a reload that would hide a stale in-memory revision.
 await page.waitForFunction(()=>!document.querySelector('#svkFiles').disabled);
 await modal.getByRole('button',{name:'Close',exact:true}).click();
 const recoveryBefore=await page.evaluate(()=>localStorage.getItem(ElistlyStorage.USER_RECOVERY_PREFIX+'browser-owner'));
 for (const notes of ['First post-import edit','Second post-import edit']) {
  await page.evaluate(id=>{App.showEntityForm('computer',id);App.showEntityEditMode(true);},device.id);
  await page.locator('#entityForm [name="notes"]').fill(notes);

  await page.locator('#entityForm').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  await page.locator('#entityModal').waitFor({state:'detached'});
  await page.waitForFunction(()=>!ElistlyStorage._isDirty && ElistlyStorage.getSyncStatus().state==='synced');
  const saved=(await db.query('SELECT payload FROM app_data WHERE user_id=$1',['browser-owner'])).rows[0].payload.workspaces.main.entities[device.id];
  assert.equal(saved.notes,notes,'post-import edits must reach the account without reloading first');

 }
 assert.equal(await page.evaluate(()=>localStorage.getItem(ElistlyStorage.USER_RECOVERY_PREFIX+'browser-owner')),recoveryBefore,'normal post-import edits must not be archived as conflicts');
 await page.reload();await page.waitForFunction(()=>App.data.currentWorkspaceId==='main'&&ElistlyStorage._accountVerified);
 assert.equal(await page.evaluate(id=>App.data.entities[id].notes,device.id),'Second post-import edit');
 await page.evaluate(id=>App.showSvkInventoryHistory(id),device.id);
 await page.locator('#svkHistoryModal').getByText('Last inventoried:',{exact:false}).waitFor();
 assert.match(await page.locator('#svkHistoryModal').textContent(),/2026-09-21T09:00:00.0000000Z/);
 await page.locator('#svkHistoryModal').getByRole('button',{name:'Close',exact:true}).click();
 // Re-import repairs an existing prefix-only record without deleting it or changing its receipt.
 const stale=(await db.query('SELECT payload FROM app_data WHERE user_id=$1',['browser-owner'])).rows[0].payload;
 const staleWorkspace=stale.workspaces.main;
 delete staleWorkspace.entities[device.id].cpu;delete staleWorkspace.entities[device.id].ram;
 staleWorkspace.entities[device.id].autoName='PC';
 for(const field of staleWorkspace.entityTypes.computer.fields.filter(field=>['cpu','ram'].includes(field.name))) delete field.collection;
 staleWorkspace.entityTypes.computer.fields.find(field=>field.name==='cpu').options=staleWorkspace.entityTypes.computer.fields.find(field=>field.name==='cpu').options.filter(option=>option.value!=='Intel Core Ultra 5');
 stale.entities=structuredClone(staleWorkspace.entities);stale.entityTypes=structuredClone(staleWorkspace.entityTypes);
 await db.query('UPDATE app_data SET payload=$1::jsonb,updated_at=clock_timestamp() WHERE user_id=$2',[JSON.stringify(stale),'browser-owner']);
 await page.reload();await page.waitForFunction(id=>App.data.entities[id]?.autoName==='PC'&&!ElistlyStorage._isDirty,device.id);
 await page.evaluate(()=>App.showSvkInventoryImport());await page.waitForFunction(()=>!document.querySelector('#svkFiles').disabled);
 await modal.locator('#svkFiles').setInputFiles([path.join(dir,'Inventory',filename)]);
 await modal.getByText('Preview only.',{exact:false}).waitFor();
 assert.match(await modal.locator('#svkPreview').textContent(),/Repair/i);
 assert.equal((await db.query('SELECT payload FROM app_data WHERE user_id=$1',['browser-owner'])).rows[0].payload.workspaces.main.entities[device.id].autoName,'PC');
 await modal.getByRole('button',{name:'Import all eligible reports',exact:true}).click();await modal.getByText('1 files confirmed durably saved.',{exact:false}).waitFor();
 await page.reload();await page.waitForFunction(id=>App.data.entities[id]?.autoName==='PC5U16',device.id);
 assert.deepEqual(await page.evaluate(id=>({cpu:App.data.entities[id].cpu,ram:App.data.entities[id].ram}),device.id),{cpu:'Intel Core Ultra 5',ram:'16GB'});
 assert.equal((await db.query('SELECT count(*) FROM inventory_import_reports')).rows[0].count,1);
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
  await page.evaluate(row=>{ElistlyStorage._writeConfirmed('browser-owner',row.payload,row.updated_at);ElistlyStorage._cachedUpdatedAt=row.updated_at;ElistlyStorage._cached=row.payload;App.applyRemoteSyncData(row.payload);},saved);
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
 // Deleting the computer and explicitly importing the same file must restore its visible record.
 await page.reload();
 await page.waitForFunction(id=>App.data.entities[id]?.hostname && ElistlyStorage._accountVerified && !ElistlyStorage._isDirty,device.id);
 await page.evaluate(id=>App.deleteEntity(id),device.id);
 const deletionSaved=page.waitForResponse(r=>r.url().endsWith('/api/app-data')&&r.request().method()==='PUT');
 await page.locator('#confirmDeleteModal').getByRole('button',{name:'Delete',exact:true}).click();
 assert.equal((await deletionSaved).status(),200,'deletion must be acknowledged by the account');
 await page.waitForFunction(id=>!App.data.entities[id] && !ElistlyStorage._isDirty && ElistlyStorage.getSyncStatus().state==='synced',device.id);
 assert.equal((await db.query('SELECT payload FROM app_data WHERE user_id=$1',['browser-owner'])).rows[0].payload.workspaces.main.entities[device.id],undefined);
 await page.evaluate(()=>App.showSvkInventoryImport());
 await page.waitForFunction(()=>!document.querySelector('#svkFiles').disabled);
 await modal.locator('#svkFiles').setInputFiles([nextPath]);
 await modal.getByText('Preview only.',{exact:false}).waitFor();
 assert.match(await modal.locator('#svkPreview').textContent(),/Restore deleted device/);
 assert.equal(await page.evaluate(id=>!!App.data.entities[id],device.id),false);
 await modal.getByRole('button',{name:'Import all eligible reports',exact:true}).click();
 await modal.getByText('1 files confirmed durably saved.',{exact:false}).waitFor();
 await page.waitForFunction(id=>App.data.entities[id]?.hostname,device.id);
 assert.equal(await page.evaluate(()=>Object.keys(App.data.entities).length),1);
 assert.equal(await page.evaluate(id=>App.data.entities[id].name,device.id),undefined);assert.ok(await page.evaluate(id=>App.data.entities[id].autoName,device.id));assert.equal(await page.evaluate(id=>App.data.entities[id].assignedTo,device.id),undefined);
 assert.equal((await db.query('SELECT count(*) FROM inventory_import_reports')).rows[0].count,2);
 await page.reload();
 await page.waitForFunction(id=>App.data.entities[id]?.hostname,device.id);
 // A manually saved computer is reviewable in the actual dialog, with saved values kept by default.
 const manual=structuredClone(fixture);manual.reportId=crypto.randomUUID();manual.serialNumber='BROWSER-MANUAL-1';manual.inventorySnapshot.device.serialNumber=manual.serialNumber;manual.inventorySnapshot.device.uuid=crypto.randomUUID();
 manual.hardwareIdentity=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(manual.inventorySnapshot.device.uuid+'|'+manual.serialNumber)))].map(b=>b.toString(16).padStart(2,'0')).join('');
 const manualPath=path.join(dir,'manual.json');fs.writeFileSync(manualPath,JSON.stringify(manual));
 const current=(await db.query('SELECT payload FROM app_data WHERE user_id=$1',['browser-owner'])).rows[0].payload;
 current.workspaces.main.entities.manual={id:'manual',type:'computer',name:'My saved PC',hostname:manual.hostname,serialNumber:manual.serialNumber,model:'Manual model'};current.entities={...current.workspaces.main.entities};
 await db.query('UPDATE app_data SET payload=$1::jsonb,updated_at=clock_timestamp() WHERE user_id=$2',[JSON.stringify(current),'browser-owner']);
 await page.reload();await page.waitForFunction(()=>App.data.entities.manual?.model==='Manual model'&&!ElistlyStorage._isDirty);
 await page.evaluate(()=>App.showSvkInventoryImport());await page.waitForFunction(()=>!document.querySelector('#svkFiles').disabled);
 await modal.locator('#svkFiles').setInputFiles([manualPath]);await modal.getByText('Preview only.',{exact:false}).waitFor();
 assert.match(await modal.locator('#svkPreview').textContent(),/My saved PC/);
 assert.match(await modal.locator('#svkPreview').textContent(),/Manual model/);
 const modelChoice=modal.locator('.svk-review-field').filter({hasText:/^ model: saved/}).locator('input');
 assert.equal(await modelChoice.isChecked(),false);
 await modelChoice.check();
 await modal.getByRole('button',{name:'Import all eligible reports',exact:true}).click();await modal.getByText('1 files confirmed durably saved.',{exact:false}).waitFor();
 assert.equal((await db.query('SELECT payload FROM app_data WHERE user_id=$1',['browser-owner'])).rows[0].payload.workspaces.main.entities.manual.model,manual.model);
 assert.equal((await db.query('SELECT payload FROM app_data WHERE user_id=$1',['browser-owner'])).rows[0].payload.workspaces.main.entities.manual.name,'My saved PC');
 // Same hostname alone is a review candidate, never automatic identity proof.
 const hostOnly=structuredClone(manual);hostOnly.reportId=crypto.randomUUID();hostOnly.hostname='HOST-ONLY-BROWSER';
 hostOnly.serialNumber='HOST-ONLY-BROWSER-SERIAL';hostOnly.inventorySnapshot.device.serialNumber=hostOnly.serialNumber;
 hostOnly.inventorySnapshot.device.uuid=crypto.randomUUID();
 hostOnly.hardwareIdentity=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(hostOnly.inventorySnapshot.device.uuid+'|'+hostOnly.serialNumber)))].map(b=>b.toString(16).padStart(2,'0')).join('');
 const hostPath=path.join(dir,'host-only.json');fs.writeFileSync(hostPath,JSON.stringify(hostOnly));
 const withHost=(await db.query('SELECT payload FROM app_data WHERE user_id=$1',['browser-owner'])).rows[0].payload;
 withHost.workspaces.main.entities.hostOnly={id:'hostOnly',type:'computer',name:'Hand named',hostname:hostOnly.hostname,model:'Hand picked',assignedTo:'chosen-person'};
 withHost.entities={...withHost.workspaces.main.entities};
 await db.query('UPDATE app_data SET payload=$1::jsonb,updated_at=clock_timestamp() WHERE user_id=$2',[JSON.stringify(withHost),'browser-owner']);
 await page.reload();await page.waitForFunction(()=>App.data.entities.hostOnly?.model==='Hand picked'&&!ElistlyStorage._isDirty);
 await page.evaluate(()=>App.showSvkInventoryImport());await page.waitForFunction(()=>!document.querySelector('#svkFiles').disabled);
 await modal.locator('#svkFiles').setInputFiles([hostPath]);await modal.getByText('Preview only.',{exact:false}).waitFor();
 assert.match(await modal.locator('#svkPreview').textContent(),/Matched by hostname/);
 assert.match(await modal.locator('#svkPreview').textContent(),/Hand picked/);
 assert.match(await modal.locator('#svkPreview').textContent(),/A hostname can be reused/);
 if(process.env.SVK_REVIEW_SCREENSHOT) {await page.waitForTimeout(350);await modal.locator('.modal-content').screenshot({path:process.env.SVK_REVIEW_SCREENSHOT});}
 const importButton=modal.getByRole('button',{name:'Import all eligible reports',exact:true});
 assert.equal(await importButton.isDisabled(),true);
 await modal.locator('.svk-review-identity input').check();
 assert.equal(await importButton.isEnabled(),true);
 await modal.locator('.svk-review-field').filter({hasText:/^ model: saved/}).locator('input').check();
 await importButton.click();await modal.getByText('1 files confirmed durably saved.',{exact:false}).waitFor();
 let hostStored=(await db.query('SELECT payload FROM app_data WHERE user_id=$1',['browser-owner'])).rows[0].payload.workspaces.main.entities.hostOnly;
 assert.equal(hostStored.model,hostOnly.model);assert.equal(hostStored.name,'Hand named');assert.equal(hostStored.manufacturer,undefined);assert.equal(hostStored.assignedTo,'chosen-person');
 await modal.getByRole('button',{name:'Preview / retry selection'}).click();await modal.getByText('Preview only.',{exact:false}).waitFor();
 await importButton.click();await modal.getByText('1 files confirmed durably saved.',{exact:false}).waitFor();
 hostStored=(await db.query('SELECT payload FROM app_data WHERE user_id=$1',['browser-owner'])).rows[0].payload.workspaces.main.entities.hostOnly;
 assert.equal(hostStored.manufacturer,undefined,'rejected blank field must stay blank on retry');
 await page.reload();await page.waitForFunction(model=>App.data.entities.hostOnly?.model===model,hostOnly.model);
 assert.equal(await page.evaluate(()=>App.data.entities.hostOnly.manufacturer),undefined,'rejected field remains absent after reload');
 assert.equal(await page.evaluate(()=>App.data.entities.hostOnly.assignedTo),'chosen-person');
 // The exact Lenovo factory file works in the real dialog, without a BIOS UUID.
 const factoryPath=path.join(root,'tests/fixtures/svk/03-factory-uuidless.json');
 await page.evaluate(()=>App.showSvkInventoryImport());await page.waitForFunction(()=>!document.querySelector('#svkFiles').disabled);
 await modal.locator('#svkFiles').setInputFiles([factoryPath]);await modal.getByText('Preview only.',{exact:false}).waitFor();
 assert.match(await modal.locator('#svkPreview').textContent(),/Create new Computer/);
 assert.equal(await modal.locator('.svk-target').inputValue(),'new');
 await importButton.click();await modal.getByText('1 files confirmed durably saved.',{exact:false}).waitFor();
 assert.equal((await db.query('SELECT count(*) FROM inventory_import_reports WHERE report_id=$1',['90166e1a-3bed-4415-8642-397cf22f589d'])).rows[0].count,1);
 assert.ok(Object.values((await db.query('SELECT payload FROM app_data WHERE user_id=$1',['browser-owner'])).rows[0].payload.workspaces.main.entities).some(e=>e.hostname==='SVK-PF5D4W92'));
 await page.waitForFunction(()=>ElistlyStorage._accountVerified && !ElistlyStorage._isDirty);
 await page.evaluate(()=>App.closeModal('svkImportModal'));
 // Exercise the visible retry path against the actual Worker/database after a failed PUT.
 let abortSave=true;
 await page.route('**/api/app-data',route=>{
  if(abortSave && route.request().method()==='PUT') {abortSave=false;return route.abort();}
  return route.fallback();
 });
 await page.evaluate(id=>{App.data.entities[id].notes='Retry from visible status';App.saveData();},device.id);
 await page.waitForFunction(()=>ElistlyStorage.getSyncStatus().state==='failed' && ElistlyStorage._isDirty);
 await page.locator('#syncStatus').getByRole('button',{name:'Retry save',exact:true}).click();
 await page.waitForFunction(()=>ElistlyStorage.getSyncStatus().state==='synced' && !ElistlyStorage._isDirty);
 assert.equal((await db.query('SELECT payload FROM app_data WHERE user_id=$1',['browser-owner'])).rows[0].payload.workspaces.main.entities[device.id].notes,'Retry from visible status');
 // Sign-out offers export/discard consent; cancelling preserves both the copy and login.
 const oldCopy=JSON.stringify([{payload:{entities:{old:{name:'Preserved draft'}}}}]);
 await page.evaluate(value=>localStorage.setItem('elistlyData:recovery:browser-owner',value),oldCopy);
 await page.evaluate(()=>App.handleSignOut());
 const signout=page.locator('#syncSignOutModal');await signout.waitFor({state:'visible'});
 const backupPromise=page.waitForEvent('download');await signout.getByRole('button',{name:'Download a copy',exact:true}).click();
 const backup=await backupPromise;const backupData=JSON.parse(fs.readFileSync(await backup.path(),'utf8'));
 assert.equal(backupData.historical[0].value,oldCopy);
 await signout.getByRole('button',{name:'Cancel',exact:true}).click();
 assert.equal(await page.evaluate(()=>localStorage.getItem('elistlyData:recovery:browser-owner')),oldCopy);
 assert.equal(await page.evaluate(()=>localStorage.getItem('elistly_token')),token);
 assert.equal(dialogs,0);
 await page.evaluate(()=>{ElistlyStorage._clearInMemoryAccountState();App.clearAccountRuntime();});
 assert.equal(await page.locator('#svkImportModal').count(),0);
 console.log('PASS: real import/edits/receipts/retry, visible save retry against Worker + database, historical sign-out export/cancel, no native dialogs');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));await db.close();fs.rmSync(dir,{recursive:true,force:true});}
