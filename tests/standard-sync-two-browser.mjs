import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium } from '../worker/node_modules/playwright/index.mjs';
import { PGlite } from '../worker/node_modules/@electric-sql/pglite/dist/index.js';
import { createWorker } from '../worker/src/index.js';
const root = path.resolve(import.meta.dirname, '..');
const db = new PGlite();
await db.exec(fs.readFileSync(path.join(root, 'neon/schema.sql'), 'utf8'));
const sql = async (parts, ...values) => (await db.query(parts.reduce((text, part, i) => text + part + (i < values.length ? `$${i + 1}` : ''), ''), values)).rows;
const token = 'test.' + Buffer.from(JSON.stringify({ sub: 'owner', exp: 4102444800 })).toString('base64url') + '.test';
const worker = createWorker({createSql: () => sql, authenticate: async request => request.headers.get('Authorization') === `Bearer ${token}` ? {id:'owner'} : null, checkAdmin: async () => false});
let offline = false;
let delayedGet = null;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      if (offline) { res.writeHead(503).end('{}'); return; }
      if (url.pathname === '/api/app-data' && req.method === 'GET' && delayedGet) await delayedGet;
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const response = await worker.fetch(new Request('https://api.test' + url.pathname.slice(4), {method:req.method, headers:req.headers, body:['GET','HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks).toString()}), {ELISTLY_ALLOWED_ORIGINS:`http://127.0.0.1:${server.address().port}`});
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text()); return;
    }
    if (url.pathname === '/sync-harness') {res.setHeader('Content-Type', 'text/html'); res.end('<script src="/config.js"></script><script src="/lib/db.js"></script><script src="/app.js"></script><script>App.init=async()=>ensureBackendClient()</script>'); return;}
    if (url.pathname === '/config.js') {res.setHeader('Content-Type','application/javascript'); res.end(`window.ELISTLY_API_URL=location.origin+'/api';window.NEON_AUTH_URL=location.origin+'/auth';`); return;}
    const file = path.resolve(root, '.' + url.pathname);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {res.writeHead(404).end(); return;}
    res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':'text/html'); res.end(fs.readFileSync(file));
  } catch (error) {console.error(error);res.writeHead(500).end();}
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
const pages = [];
async function row() {return (await db.query("SELECT payload FROM app_data WHERE user_id='owner'")).rows[0];}
async function load(page) {return page.evaluate(() => Storage.getAppData());}
async function save(page, name) {return page.evaluate(async name => {const draft = structuredClone(Storage._cached);draft.entities.record.name = name;try {await Storage.setAppData(draft);return null;} catch (error) {return error.message;}}, name);}
try {
  const data = {version:'test',settings:{},categories:{},entityTypes:{},entities:{record:{id:'record',name:'Server original'}}};
  await db.query("INSERT INTO app_data(user_id,payload,updated_at) VALUES ('owner',$1::jsonb,'2026-09-17T06:11:53.746204Z')",[JSON.stringify(data)]);
  for (let i=0;i<2;i++) {const context=await browser.newContext();await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());const page=await context.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/sync-harness`);await page.evaluate(token=>localStorage.setItem('elistly_token',token),token);pages.push(page);}
  const [a,b]=pages;
  await a.evaluate(() => {localStorage.setItem('elistlyData:user:owner', JSON.stringify({entities:{old:{}}}));localStorage.setItem('elistlyData:outbox:owner', JSON.stringify([{id:'old',payload:{entities:{old:{}}},expectedUpdatedAt:null}]));localStorage.setItem('elistlyData:recovery:owner', JSON.stringify([{localPayload:{entities:{old:{}}}}]));});
  assert.deepEqual((await load(a)).entities,data.entities,'server wins on startup even with old local snapshots');
  await a.evaluate(() => Storage._refreshPromise);
  let releaseGet;
  delayedGet = new Promise(resolve => { releaseGet = resolve; });
  await db.query("UPDATE app_data SET payload=$1::jsonb, updated_at=clock_timestamp() WHERE user_id='owner'", [JSON.stringify({...data, entities:{record:{id:'record',name:'Newer server'}}})]);
  const fast = await Promise.race([load(a), new Promise((_, reject) => setTimeout(() => reject(new Error('confirmed cache startup blocked on GET')), 300))]);
  assert.equal(fast.entities.record.name, 'Server original');
  assert.equal(await a.evaluate(() => Storage.getSyncStatus().state), 'refreshing');
  releaseGet(); delayedGet = null;
  await a.evaluate(() => Storage._refreshPromise);
  assert.equal(await a.evaluate(() => Storage._cached.entities.record.name), 'Newer server');
  assert.equal(await a.evaluate(() => Storage.getSyncStatus().state),'synced');
  assert.equal(await save(a,'saved A'),null);
  assert.equal((await load(b)).entities.record.name,'saved A');
  assert.equal(await save(b,'saved B'),null);
  await load(a); await a.evaluate(() => Storage._refreshPromise);
  assert.equal(await a.evaluate(() => Storage._cached.entities.record.name),'saved B');
  assert.equal(await save(a,'winner'),null);
  const stale = await save(b,'unsaved draft');
  assert.match(stale,/changed|refresh/i);
  assert.equal((await row()).payload.entities.record.name,'winner');
  assert.equal(await b.evaluate(() => Storage.getSyncStatus().state),'conflict');
  assert.equal(await b.evaluate(() => Storage._cached.entities.record.name),'unsaved draft');
  offline=true;
  const fail=await save(a,'offline draft');assert.match(fail,/save|connection|offline/i);
  assert.equal(await a.evaluate(() => Storage.getSyncStatus().state),'failed');
  assert.equal((await row()).payload.entities.record.name,'winner');
  assert.equal((await load(pages[0])).entities.record.name, 'offline draft', 'reopening must preserve the unsaved live draft');
  assert.equal(await a.evaluate(() => Storage._readConfirmed('owner').payload.entities.record.name),'winner','only acknowledged data is persisted');
  offline=false;
  await load(a); await a.evaluate(() => Storage._refreshPromise);
  assert.equal(await a.evaluate(() => Storage._cached.entities.record.name),'offline draft', 'refresh must not discard unsaved draft');
  assert.equal(await a.evaluate(() => Storage._readConfirmed('owner').payload.entities.record.name),'winner');
  assert.equal(await a.evaluate(() => localStorage.getItem('elistlyData:outbox:owner') !== null),true,'legacy unsent data must be left for explicit export');
  console.log('PASS two isolated Chrome profiles, real Worker + PGlite, fast confirmed cache, stale preconditions, offline failure, legacy preservation');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));await db.close();}
