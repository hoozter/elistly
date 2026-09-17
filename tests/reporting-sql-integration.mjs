// Run with PGLITE_MODULE pointing to an installed @electric-sql/pglite module.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createWorker } from '../worker/src/index.js';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
await db.exec(fs.readFileSync(new URL('../neon/schema.sql', import.meta.url),'utf8'));
const src=fs.readFileSync(new URL('../worker/test/device-reporting.spec.js',import.meta.url),'utf8');
const fixture=vm.runInNewContext(src.slice(src.indexOf('const token'),src.indexOf('async function request'))+';({facts, state:account(), env})');
await db.query('INSERT INTO app_data(user_id,payload) VALUES ($1,$2::jsonb)',['synthetic-owner',JSON.stringify(fixture.state)]);
const sql=async(strings,...values) => (await db.query(strings.reduce((s,v,i)=>s+v+(i<values.length?'$'+(i+1):''),''),values)).rows;
const worker=createWorker({createSql:()=>sql,authenticate:async(req)=> req.headers.get('Authorization')==='Bearer TEST_ACCOUNT' ? {id:'synthetic-owner'} : null});
const request=(path,method,token,body)=>worker.fetch(new Request('https://api.example.test'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}),fixture.env);
const created=await request('/device-reporting/tokens','POST','TEST_ACCOUNT',{deviceId:'device-1'});assert.equal(created.status,201);const credential=await created.json();
assert.equal((await request('/app-data','GET',credential.token)).status,401);
const reported=await request('/device-reporting/report','POST',credential.token,fixture.facts);assert.equal(reported.status,200,await reported.text());
const saved=(await db.query('SELECT payload FROM app_data WHERE user_id=$1',['synthetic-owner'])).rows[0].payload;
assert.equal(saved.workspaces.main.entities['device-1'].assignedTo,'Alice');
assert.equal(saved.workspaces.main.entities['device-1']._elistlyRegistration.inventorySnapshot.collectedAt,fixture.facts.inventorySnapshot.collectedAt);
const stale={...fixture.facts,inventorySnapshot:{...fixture.facts.inventorySnapshot,collectedAt:'2025-01-01T00:00:00.000Z'}};
assert.equal((await request('/device-reporting/report','POST',credential.token,stale)).status,409);
assert.equal((await request('/device-reporting/tokens/'+credential.tokenId,'DELETE','TEST_ACCOUNT')).status,200);
assert.equal((await request('/device-reporting/report','POST',credential.token,fixture.facts)).status,401);
const listed=await request('/device-reporting/tokens','GET','TEST_ACCOUNT');const metadata=(await listed.json()).tokens[0];assert.ok(metadata.revoked_at);assert.ok(metadata.last_used_at);assert.equal(metadata.token_hash,undefined);
// Explicit automatic enrollment returns a new device-bound secret; dr_ never does.
for (const automaticReporting of [false, true]) {
  const created = await request('/device-registration/tokens','POST','TEST_ACCOUNT',{workspaceId:'main',automaticReporting});
  assert.equal(created.status,201);
  const enrollment = await created.json();
  const enrolled = await request('/device-registration/register','POST',enrollment.token,fixture.facts);
  assert.equal(enrolled.status,200);
  const result = await enrolled.json();
  if (automaticReporting) {
    assert.match(result.reportingToken,/^dp_/);
    assert.equal((await request('/app-data','GET',result.reportingToken)).status,401);
    assert.equal((await request('/device-reporting/report','POST',result.reportingToken,fixture.facts)).status,200);
    const stored = (await db.query('SELECT * FROM device_reporting_tokens WHERE id=$1',[result.reportingTokenId])).rows[0];
    assert.equal(stored.device_id,'device-1');
    assert.equal(stored.workspace_id,'main');
    assert.equal(stored.owner_user_id,'synthetic-owner');
    assert.notEqual(stored.token_hash,result.reportingToken);
  } else assert.equal(result.reportingToken,undefined);
  await request('/device-registration/tokens/'+enrollment.tokenId,'DELETE','TEST_ACCOUNT');
  const before = (await db.query('SELECT count(*) FROM device_reporting_tokens')).rows[0].count;
  assert.equal((await request('/device-registration/register','POST',enrollment.token,fixture.facts)).status,401);
  assert.equal((await db.query('SELECT count(*) FROM device_reporting_tokens')).rows[0].count,before);
}
// A new device and its credential are committed together; authorization and CAS
// are rechecked at the write boundary, including revocation after the read.
const freshFacts={...fixture.facts,hardwareIdentity:'b'.repeat(64),serialNumber:'SERIAL-2',inventorySnapshot:{...fixture.facts.inventorySnapshot,device:{...fixture.facts.inventorySnapshot.device,serialNumber:'SERIAL-2'}}};
const grant=await (await request('/device-registration/tokens','POST','TEST_ACCOUNT',{workspaceId:'main',automaticReporting:true})).json();
const fresh=await request('/device-registration/register','POST',grant.token,freshFacts);
assert.equal(fresh.status,201);
const freshResult=await fresh.json();
assert.notEqual(freshResult.deviceId,'device-1');
assert.equal((await request('/device-reporting/report','POST',freshResult.reportingToken,fixture.facts)).status,403);
assert.equal((await request('/device-reporting/report','POST',freshResult.reportingToken,freshFacts)).status,200);
assert.equal((await request('/app-data','GET',grant.token)).status,401);
for (const conflict of ['revoked','revision']) {
  const grant=await (await request('/device-registration/tokens','POST','TEST_ACCOUNT',{workspaceId:'main',automaticReporting:true})).json();
  const before=(await db.query('SELECT count(*) FROM device_reporting_tokens')).rows[0].count;
  const racingSql=async (strings,...values)=>{
    if(strings.join(' ').includes('WITH active_token')) {
      if(conflict==='revoked') await db.query('UPDATE device_registration_tokens SET revoked_at=NOW() WHERE id=$1',[grant.tokenId]);
      else await db.query("UPDATE app_data SET updated_at=updated_at+interval '1 second' WHERE user_id=$1",['synthetic-owner']);
    }
    return sql(strings,...values);
  };
  const racingWorker=createWorker({createSql:()=>racingSql,authenticate:async()=>null});
  const response=await racingWorker.fetch(new Request('https://api.example.test/device-registration/register',{method:'POST',headers:{Authorization:'Bearer '+grant.token,'Content-Type':'application/json'},body:JSON.stringify(freshFacts)}),fixture.env);
  assert.equal(response.status,409);
  assert.equal((await db.query('SELECT count(*) FROM device_reporting_tokens')).rows[0].count,before);
}
// One-time registration must recheck authorization at the app-data write,
// after a successful initial lookup. Use the real owner revocation route.
const oneTimeFacts={...freshFacts,hardwareIdentity:'c'.repeat(64),serialNumber:'SERIAL-3',inventorySnapshot:{...freshFacts.inventorySnapshot,device:{...freshFacts.inventorySnapshot.device,serialNumber:'SERIAL-3'}}};
for (const conflict of ['revoked','expired','revision']) {
  const grant=await (await request('/device-registration/tokens','POST','TEST_ACCOUNT',{workspaceId:'main',automaticReporting:false})).json();
  assert.match(grant.token,/^dr_/);
  const reportsBefore=(await db.query('SELECT count(*) FROM device_reporting_tokens')).rows[0].count;
  let boundaryState; let writes=0;
  const racingSql=async (strings,...values)=>{
    if(strings.join(' ').includes('UPDATE app_data')) {
      writes++;
      if(conflict==='revoked') assert.equal((await request('/device-registration/tokens/'+grant.tokenId,'DELETE','TEST_ACCOUNT')).status,200);
      else if(conflict==='expired') await db.query("UPDATE device_registration_tokens SET expires_at=NOW()-interval '1 second' WHERE id=$1",[grant.tokenId]);
      else await db.query("UPDATE app_data SET updated_at=updated_at+interval '1 second' WHERE user_id=$1",['synthetic-owner']);
      boundaryState=(await db.query('SELECT payload, updated_at::text FROM app_data WHERE user_id=$1',['synthetic-owner'])).rows[0];
    }
    return sql(strings,...values);
  };
  const racingWorker=createWorker({createSql:()=>racingSql,authenticate:async()=>null});
  const response=await racingWorker.fetch(new Request('https://api.example.test/device-registration/register',{method:'POST',headers:{Authorization:'Bearer '+grant.token,'Content-Type':'application/json'},body:JSON.stringify(oneTimeFacts)}),fixture.env);
  assert.equal(writes,1,'test must reach the write after initial authorization');
  assert.equal(response.status,409,`dr_ ${conflict} must fail closed at the write boundary`);
  assert.deepEqual((await db.query('SELECT payload, updated_at::text FROM app_data WHERE user_id=$1',['synthetic-owner'])).rows[0],boundaryState,'refusal must not alter inventory or its revision');
  assert.equal((await db.query('SELECT last_used_at FROM device_registration_tokens WHERE id=$1',[grant.tokenId])).rows[0].last_used_at,null);
  assert.equal((await db.query('SELECT count(*) FROM device_reporting_tokens')).rows[0].count,reportsBefore);
}
const oneTimeGrant=await (await request('/device-registration/tokens','POST','TEST_ACCOUNT',{workspaceId:'main',automaticReporting:false})).json();
const reportsBeforeOneTime=(await db.query('SELECT count(*) FROM device_reporting_tokens')).rows[0].count;
const oneTimeRegistered=await request('/device-registration/register','POST',oneTimeGrant.token,oneTimeFacts);
assert.equal(oneTimeRegistered.status,201);
const oneTimeResult=await oneTimeRegistered.json();
assert.equal(oneTimeResult.created,true);
assert.equal(oneTimeResult.reportingToken,undefined);
assert.ok(oneTimeResult.updatedAt);
assert.ok((await db.query('SELECT last_used_at FROM device_registration_tokens WHERE id=$1',[oneTimeGrant.tokenId])).rows[0].last_used_at);
assert.equal((await db.query('SELECT count(*) FROM device_reporting_tokens')).rows[0].count,reportsBeforeOneTime);
const oneTimeRetry=await request('/device-registration/register','POST',oneTimeGrant.token,oneTimeFacts);
assert.equal(oneTimeRetry.status,200);
assert.deepEqual(await oneTimeRetry.json(),{ok:true,created:false,deviceId:oneTimeResult.deviceId});
console.log('PASS dr_ write boundary: owner revocation, expiry and revision refusal preserve inventory; active registration and retry retain registration-only contracts');
console.log('PASS automatic enrollment: new/existing devices, scoped hashed credentials, dr_ isolation, revoked and revision-conflict atomic refusal');
await db.close();
console.log('PASS actual PostgreSQL schema, credential issue, report write/readback, manual field retention, stale refusal, account isolation and revoke/readback');
