import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '../worker/node_modules/@electric-sql/pglite/dist/index.js';
import { createWorker } from '../worker/src/index.js';
const db = new PGlite();
await db.exec(fs.readFileSync(new URL('../neon/schema.sql',import.meta.url),'utf8'));
const report=JSON.parse(fs.readFileSync(new URL('./fixtures/svk/01-installation.json',import.meta.url)));
const account={currentWorkspaceId:'main',workspaces:{main:{name:'Synthetic workspace',categories:{devices:{id:'devices',label:'Devices'}},entityTypes:{computer:{id:'computer',label:'Computer',category:'devices',fields:[],associations:[]}},entities:{}}}};
await db.query('INSERT INTO app_data(user_id,payload) VALUES ($1,$2::jsonb)',['owner',JSON.stringify(account)]);
let interrupt=false, corruptRead=false;
const sql=async(strings,...values)=>{
 const query=strings.reduce((s,v,i)=>s+v+(i<values.length?'$'+(i+1):''),'');
 const rows=(await db.query(query,values)).rows;
 if (interrupt && query.includes('INSERT INTO inventory_import_reports')) {interrupt=false;throw new Error('connection lost after commit');}
 if(corruptRead && query.includes('SELECT report_id, content_digest') && rows.length) return [{...rows[0],report:{...rows[0].report,hostname:'corrupted'}}];
 return rows;
};
const env={ELISTLY_ALLOWED_ORIGINS:'https://test.example'};
const worker=createWorker({createSql:()=>sql,authenticate:async req=>req.headers.get('Authorization')==='Bearer owner-test' ? {id:'owner'} : req.headers.get('Authorization')==='Bearer other-test' ? {id:'other'} : null});
const request=(path,body,token='owner-test',method=body?'POST':'GET')=>worker.fetch(new Request('https://api.test'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}),env);
const file=(r=report,filename='DEPLOYDATA/Inventory/report.json')=>({filename,content:JSON.stringify(r)});
const batch=(files,preview=false,workspaceId='main')=>({workspaceId,preview,files});
const send=async body=>{const r=await request('/inventory-import',body); assert.equal(r.status,200,await r.clone().text());return (await r.json()).results;};
assert.equal((await request('/inventory-import',batch([file()]),'invalid')).status,401);
assert.equal((await request('/inventory-import',batch([file()]),'other-test')).status,404);
assert.equal((await request('/inventory-import',batch([file()],false,'absent'))).status,404);
let results=await send(batch([file()],true));assert.equal(results[0].disposition,'New');assert.equal(results[0].safe,false);
assert.equal((await db.query('SELECT count(*) FROM inventory_import_reports')).rows[0].count,0);
results=await send(batch([file(),{filename:'bad.json',content:'bad'},file(report,'unfinished.pending')]));
assert.deepEqual(results.map(r=>r.safe),[true,false,false]);assert.ok(results[0].importedAt);
const device=results[0].deviceId;
assert.equal((await send(batch([file()])))[0].disposition,'Already imported');
let changed=structuredClone(report);changed.hostname='changed';
assert.match((await send(batch([file(changed)])))[0].reason,/different content/);
// Distinct concurrent reports share one device. Same-ID retries converge on one receipt.
const newer=structuredClone(report);newer.reportId=crypto.randomUUID();newer.collectedAt='2026-09-21T09:01:00.0000001Z';newer.inventorySnapshot.collectedAt=newer.collectedAt;
const newer2=structuredClone(newer);newer2.reportId=crypto.randomUUID();
const concurrent=await Promise.all([send(batch([file(newer)])),send(batch([file(newer)])),send(batch([file(newer2)]))]);
assert.ok(concurrent.every(r=>r[0].safe),JSON.stringify(concurrent));
assert.equal((await db.query('SELECT count(*) FROM inventory_import_reports')).rows[0].count,3);
let row=(await request('/app-data').then(r=>r.json()));
assert.equal(Object.keys(row.payload.workspaces.main.entities).length,1);
Object.assign(row.payload.workspaces.main.entities[device],{name:'Manual name',notes:'Keep',assignedTo:'person-1',location:'Room 2'});
// An ordinary save can remove any imported JSON metadata without losing receipts.
const saved=await request('/app-data',{payload:row.payload,expectedUpdatedAt:row.updated_at},'owner-test','PUT');assert.equal(saved.status,200);
assert.equal((await send(batch([file()])))[0].safe,true);
const older=structuredClone(report);older.reportId=crypto.randomUUID();older.collectedAt='2026-09-20T09:00:00.0000000Z';older.inventorySnapshot.collectedAt=older.collectedAt;older.model=null;older.inventorySnapshot.device.model=null;older.inventorySnapshot.ramBytes=null;
assert.equal((await send(batch([file(older)])))[0].safe,true);
row=await request('/app-data').then(r=>r.json());
assert.equal(row.payload.workspaces.main.entities[device].name,'Manual name');assert.equal(row.payload.workspaces.main.entities[device].model,'Example Laptop');assert.equal(row.payload.workspaces.main.entities[device].assignedTo,'person-1');
const equal=structuredClone(newer);equal.reportId=crypto.randomUUID();equal.inventorySnapshot.ramBytes=1;
assert.match((await send(batch([file(equal)])))[0].reason,/same collection time/);
const future=structuredClone(report);future.reportId=crypto.randomUUID();future.collectedAt='2099-01-01T00:00:00Z';future.inventorySnapshot.collectedAt=future.collectedAt;
assert.match((await send(batch([file(future)])))[0].reason,/Future/);
const interrupted=structuredClone(newer);interrupted.reportId=crypto.randomUUID();interrupt=true;
assert.equal((await send(batch([file(interrupted)])))[0].safe,false);
assert.equal((await send(batch([file(interrupted)])))[0].safe,true);
corruptRead=true;assert.equal((await send(batch([file(interrupted)])))[0].safe,false);corruptRead=false;
const observations=await request('/inventory-import/observations?workspaceId=main&deviceId='+device).then(r=>r.json());
assert.equal(observations.observations.length,5);assert.ok(observations.observations.some(r=>r.report.inventorySnapshot.ramBytes===null));assert.ok(observations.observations.some(r=>r.report.inventorySnapshot.ramBytes===17179869184));
assert.equal((await request('/inventory-import/observations?workspaceId=main&deviceId='+device,null,'other-test')).status,404);
// Failed authoritative readback after a successful write is never safe.
const unread=structuredClone(newer);unread.reportId=crypto.randomUUID();corruptRead=true;
assert.equal((await send(batch([file(unread)])))[0].safe,false);corruptRead=false;
assert.equal((await send(batch([file(unread)])))[0].safe,true);
// Equivalent normalized BIOS identifiers with different legacy hashes require review.
const normalized=structuredClone(newer);normalized.reportId=crypto.randomUUID();
normalized.inventorySnapshot.device.uuid=normalized.inventorySnapshot.device.uuid.toUpperCase();
normalized.serialNumber=normalized.serialNumber.toLowerCase();normalized.inventorySnapshot.device.serialNumber=normalized.serialNumber;
normalized.hardwareIdentity=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(normalized.inventorySnapshot.device.uuid+'|'+normalized.serialNumber)))].map(b=>b.toString(16).padStart(2,'0')).join('');
assert.match((await send(batch([file(normalized)])))[0].reason,/normalization mismatch/);
assert.equal((await request('/inventory-import',batch(Array(11).fill(file())))).status,422);
assert.equal((await request('/inventory-import',{...batch([file()]),ownerUserId:'someone'})).status,422);
// A failure in the receipt insert rolls back the entity mutation too.
await db.exec(`ALTER TABLE inventory_import_reports ADD CONSTRAINT synthetic_failure CHECK (report->>'hostname' <> 'FAIL-SAVE')`);
const broken=structuredClone(newer);broken.reportId=crypto.randomUUID();broken.hostname='FAIL-SAVE';broken.collectedAt='2026-09-21T09:02:00Z';broken.inventorySnapshot.collectedAt=broken.collectedAt;
const before=await request('/app-data').then(r=>r.json());
assert.equal((await send(batch([file(broken)])))[0].safe,false);
assert.deepEqual(await request('/app-data').then(r=>r.json()),before);
// Receipts survive an editable-device deletion and explicitly restore the same device ID.
row=await request('/app-data').then(r=>r.json());
delete row.payload.workspaces.main.entities[device];
assert.equal((await request('/app-data',{payload:row.payload,expectedUpdatedAt:row.updated_at},'owner-test','PUT')).status,200);
results=await send(batch([file()],true));
assert.equal(results[0].disposition,'Restore deleted device');assert.equal(results[0].safe,false);
assert.equal((await request('/app-data').then(r=>r.json())).payload.workspaces.main.entities[device],undefined);
results=(await Promise.all([send(batch([file()])),send(batch([file()]))])).map(r=>r[0]);
assert.ok(results.every(r=>r.safe));assert.ok(results.some(r=>r.disposition==='Restore deleted device'));assert.ok(results.every(r=>r.deviceId===device));
row=await request('/app-data').then(r=>r.json());
assert.equal(row.payload.workspaces.main.entities[device].hostname,report.hostname);assert.equal(row.payload.workspaces.main.entities[device].notes,undefined);
// A later report for the deleted historical device also restores that same device and adds one receipt.
delete row.payload.workspaces.main.entities[device];
assert.equal((await request('/app-data',{payload:row.payload,expectedUpdatedAt:row.updated_at},'owner-test','PUT')).status,200);
const recovery=structuredClone(newer);recovery.reportId=crypto.randomUUID();recovery.collectedAt='2026-09-21T09:03:00Z';recovery.inventorySnapshot.collectedAt=recovery.collectedAt;
assert.equal((await send(batch([file(recovery)],true)))[0].disposition,'Restore deleted device');
results=await send(batch([file(recovery)]));
assert.equal(results[0].disposition,'Restore deleted device');assert.equal(results[0].deviceId,device);assert.equal(results[0].safe,true);
assert.equal((await db.query('SELECT count(*) FROM inventory_import_reports')).rows[0].count,7);
// An exact existing receipt repairs the observed production IT schema without
// changing preview state, and keeps later manual choices intact.
const actual=structuredClone(report);
actual.reportId=crypto.randomUUID();actual.collectedAt='2026-09-21T09:04:00Z';actual.inventorySnapshot.collectedAt=actual.collectedAt;actual.hostname='SVK-PF5EQWQ5';actual.model='21M7002HMX';actual.inventorySnapshot.device.model=actual.model;
actual.inventorySnapshot.cpu={model:'Intel(R) Core(TM) Ultra 5 125U',cores:12,logicalProcessors:14};actual.inventorySnapshot.ramBytes=16619384832;
const actualSchema=()=>({id:'computer',label:'Computer',category:'devices',presetIds:['it'],enableNameGen:true,nameGen:{prefix:'LER',prefixEnabled:true,suffixType:'number',componentsOrder:[{type:'field',name:'indexYear'},{type:'field',name:'cpu'},{type:'field',name:'ram'}]},fields:[
 {name:'indexYear',label:'Year',type:'dropdown',required:true,partOfName:true,options:[{value:'2025',nameValue:'Y5'}]},
 {name:'cpu',label:'CPU',type:'dropdown',required:true,partOfName:true,options:[{value:'Intel Core i5',nameValue:'5'},{value:'Intel Core i7',nameValue:'7'},{value:'Intel Core i9',nameValue:'9'},{value:'Intel Core 7 Ultra',nameValue:'7U'},{value:'Intel Core 9 Ultra',nameValue:'9U'}]},
 {name:'ram',label:'RAM',type:'dropdown',required:true,partOfName:true,options:[{value:'8GB',nameValue:'8'},{value:'16GB',nameValue:'16'},{value:'32GB',nameValue:'32'},{value:'64GB',nameValue:'64'}]},
 {name:'processorDescription',label:'Processor details',type:'textarea'}, {name:'graphicsAdapters',label:'Graphics adapters',type:'textarea'}, {name:'windowsVersion',label:'Windows version',type:'text'}, {name:'windowsBuild',label:'Windows build',type:'text'},
],associations:[]});
row=await request('/app-data').then(r=>r.json());
row.payload.workspaces.main.entityTypes.computer=actualSchema();
assert.equal((await request('/app-data',{payload:row.payload,expectedUpdatedAt:row.updated_at},'owner-test','PUT')).status,200);
assert.equal((await send(batch([file(actual)])))[0].safe,true);
row=await request('/app-data').then(r=>r.json());
row.payload.workspaces.main.entityTypes.computer=actualSchema();
row.payload.workspaces.main.entities[device]={id:device,type:'computer',hostname:actual.hostname,autoName:'LER'};
delete row.payload.entities;delete row.payload.entityTypes;
assert.equal((await request('/app-data',{payload:row.payload,expectedUpdatedAt:row.updated_at},'owner-test','PUT')).status,200);
const beforeRepair=await request('/app-data').then(r=>r.json());
results=await send(batch([file(actual)],true));assert.equal(results[0].disposition,'Repair imported device');assert.equal(results[0].safe,false);
assert.deepEqual(await request('/app-data').then(r=>r.json()),beforeRepair);
results=await send(batch([file(actual)]));assert.equal(results[0].disposition,'Repaired import');assert.equal(results[0].safe,true);
row=await request('/app-data').then(r=>r.json());
assert.deepEqual({cpu:row.payload.workspaces.main.entities[device].cpu,ram:row.payload.workspaces.main.entities[device].ram,autoName:row.payload.workspaces.main.entities[device].autoName},{cpu:'Intel Core Ultra 5',ram:'16GB',autoName:'LER5U16'});
assert.equal(row.payload.workspaces.main.entityTypes.computer.fields.find(field=>field.name==='cpu').collection.capability,'processor.summary');
assert.deepEqual(row.payload.entityTypes,row.payload.workspaces.main.entityTypes);
assert.equal((await send(batch([file(actual)],true)))[0].disposition,'Already imported');
assert.equal((await send(batch([file(actual)])))[0].disposition,'Already imported');
row=await request('/app-data').then(r=>r.json());row.payload.workspaces.main.entities[device].cpu='Intel Core i7';delete row.payload.workspaces.main.entities[device].ram;row.payload.workspaces.main.entities[device].autoName='MANUAL';
assert.equal((await request('/app-data',{payload:row.payload,expectedUpdatedAt:row.updated_at},'owner-test','PUT')).status,200);
assert.equal((await send(batch([file(actual)],true)))[0].disposition,'Repair imported device');
assert.equal((await send(batch([file(actual)])))[0].disposition,'Repaired import');
row=await request('/app-data').then(r=>r.json());assert.deepEqual({cpu:row.payload.workspaces.main.entities[device].cpu,ram:row.payload.workspaces.main.entities[device].ram,autoName:row.payload.workspaces.main.entities[device].autoName},{cpu:'Intel Core i7',ram:'16GB',autoName:'MANUAL'});
// A schema-only migration is still a repair and must be persisted and synced.
for (const field of row.payload.workspaces.main.entityTypes.computer.fields) delete field.collection;
delete row.payload.entityTypes;
assert.equal((await request('/app-data',{payload:row.payload,expectedUpdatedAt:row.updated_at},'owner-test','PUT')).status,200);
assert.equal((await send(batch([file(actual)],true)))[0].disposition,'Repair imported device');
assert.equal((await send(batch([file(actual)])))[0].disposition,'Repaired import');
row=await request('/app-data').then(r=>r.json());
assert.equal(row.payload.workspaces.main.entityTypes.computer.fields.find(field=>field.name==='ram').collection.capability,'memory.total');
assert.deepEqual(row.payload.entityTypes,row.payload.workspaces.main.entityTypes);
assert.equal((await send(batch([file(actual)])))[0].disposition,'Already imported');
console.log('PASS: real PostgreSQL schema/SQL, preview, scoped auth, mixed batch, concurrent retries, manual fields, old/null history, equal/future conflict, commit interruption, receipt corruption, atomic rollback, history readback, deleted-device restoration, exact-receipt schema repair, nonmutating repair preview, idempotence, manual field preservation, and schema-only repair persistence');
await db.close();
