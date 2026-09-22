import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateSvkReport, planSvkImport, canonicalJson } from '../worker/src/svk-inventory.js';
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/svk/01-installation.json', import.meta.url)));
const now = Date.parse('2026-09-22T00:00:00Z');
const validate = value => validateSvkReport(JSON.stringify(value), now);
const payload = () => ({currentWorkspaceId:'main', workspaces:{main:{entityTypes:{computer:{}},entities:{}}}});
test('accepts producer precision and verifies content and identity hashes', async () => {
 const valid = await validate(fixture);
 assert.equal(valid.collectedKey, '2026-09-21T09:00:00.0000000Z');
 assert.match(valid.digest, /^[a-f0-9]{64}$/);
 assert.equal((await validate(Object.fromEntries(Object.entries(fixture).reverse()))).digest, valid.digest);
});
test('strict schema, identities, bounds, dates and contradictions', async () => {
 const invalid = [
  r=>r.schema='elistly.device-intake.v1', r=>r.extra=true,
  r=>r.hardwareIdentity='a'.repeat(64), r=>r.reportId='bad',
  r=>r.inventorySnapshot.device.uuid='not-a-uuid', r=>r.serialNumber='N/A',
  r=>r.collectedAt='2026-02-30T00:00:00Z', r=>r.collectedAt='2026-09-23T00:00:00Z',
  r=>r.inventorySnapshot.collectedAt='2026-09-21T09:00:00.0000001Z',
  r=>r.inventorySnapshot.ramBytes=-1,r=>r.inventorySnapshot.cpu.cores=1.5,
  r=>r.inventorySnapshot.cpu.cores=32,r=>r.inventorySnapshot.graphicsAdapters=Array(9).fill('x'),
  r=>r.hostname='x'.repeat(257),r=>r.collection.networkUsed=true,
  r=>r.inventorySnapshot.lastInteractiveUser={name:'person'},r=>r.provisioning.finished=true,
  r=>r.provisioning.phase='service-observation', r=>delete r.model,
  r=>r.inventorySnapshot.device.model='different',r=>r.collector.formatVersion=2,
 ];
 for (const mutate of invalid) {const r=structuredClone(fixture); mutate(r); await assert.rejects(validate(r), undefined, mutate.toString());}
 await assert.rejects(validateSvkReport(' '.repeat(65537)),/64 KiB/);
 await assert.rejects(validate(JSON.parse(fs.readFileSync(new URL('./fixtures/svk/02-service-missing-identity.json',import.meta.url)))), /identity/i);
});
test('canonical content ignores object key order only', () => {
 assert.equal(canonicalJson({b:1,a:[null,'x']}),canonicalJson({a:[null,'x'],b:1}));
});
test('creates one computer and leaves manual values untouched on observations', async () => {
 const v=await validate(fixture), p=payload();
 const first=planSvkImport(p,'main',v,[]);
 assert.equal(first.disposition,'New');
 assert.equal(Object.keys(first.payload.workspaces.main.entities).length,1);
 const entity=first.payload.workspaces.main.entities[first.deviceId];
 Object.assign(entity,{name:'Manual',assignedTo:'person',location:'desk',notes:'keep'});
 const before=structuredClone(first.payload);
 const next=planSvkImport(first.payload,'main',v,[{device_id:first.deviceId,hardware_identity:v.report.hardwareIdentity,report:v.report}]);
 assert.equal(next.disposition,'Update observations'); assert.deepEqual(next.payload,before);
 assert.deepEqual(p,payload());
});
test('refuses ambiguous, manual and legacy identity matches but restores a deleted historical device',async()=>{
 const v=await validate(fixture);
 for (const entities of [
  {a:{id:'a',type:'computer',serialNumber:fixture.serialNumber}},
  {a:{id:'a',type:'computer',_elistlyRegistration:{hardwareIdentity:'other',inventorySnapshot:fixture.inventorySnapshot}}},
  {a:{id:'a',type:'computer',_elistlyRegistration:{hardwareIdentity:fixture.hardwareIdentity}},b:{id:'b',type:'computer',_elistlyRegistration:{hardwareIdentity:fixture.hardwareIdentity}}},
 ]) {const p=payload(); p.workspaces.main.entities=entities; assert.throws(()=>planSvkImport(p,'main',v,[]),/review|collision|multiple/i);}
 const contradictory=structuredClone(fixture);contradictory.hostname='different';
 assert.throws(()=>planSvkImport(payload(),'main',v,[{device_id:'gone',hardware_identity:fixture.hardwareIdentity,report:contradictory}]),/same collection time/i);
 const restored=planSvkImport(payload(),'main',v,[{device_id:'gone',hardware_identity:fixture.hardwareIdentity,report:fixture}]);
 assert.equal(restored.disposition,'Restore deleted device');assert.ok(restored.payload.workspaces.main.entities.gone);
 const collision=payload();collision.workspaces.main.entities.live={id:'live',type:'computer',serialNumber:fixture.serialNumber};
 assert.throws(()=>planSvkImport(collision,'main',v,[{device_id:'gone',hardware_identity:fixture.hardwareIdentity,report:fixture}]),/collision|review/i);
 assert.throws(()=>planSvkImport(payload(),'other',v,[]),/workspace/i);
});
test('equal-time contradictory observations require attention; older reports remain history',async()=>{
 const v=await validate(fixture),p=payload(); p.workspaces.main.entities.a={id:'a',type:'computer'};
 const old=structuredClone(fixture); old.inventorySnapshot.ramBytes=null;
 assert.throws(()=>planSvkImport(p,'main',v,[{device_id:'a',hardware_identity:fixture.hardwareIdentity,report:old}]),/same collection time/i);
 old.collectedAt='2026-09-21T10:00:00.0000000Z'; old.inventorySnapshot.collectedAt=old.collectedAt;
 assert.equal(planSvkImport(p,'main',v,[{device_id:'a',hardware_identity:fixture.hardwareIdentity,report:old}]).deviceId,'a');
});

test('generic serials and malformed UUIDs fail even with matching producer hashes',async()=>{
 for (const serial of ['N/A','unknown','000000','FFFFFFFF','To Be Filled By O.E.M.']) {
  const r=structuredClone(fixture);r.serialNumber=serial;r.inventorySnapshot.device.serialNumber=serial;
  r.hardwareIdentity=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(r.inventorySnapshot.device.uuid+'|'+serial)))].map(b=>b.toString(16).padStart(2,'0')).join('');
  await assert.rejects(validate(r),/identity/i);
 }
 const precise=structuredClone(fixture);precise.collectedAt='2026-09-21T09:00:00.0000001Z';precise.inventorySnapshot.collectedAt=precise.collectedAt;
 assert.equal((await validate(precise)).collectedKey,precise.collectedAt);
});
