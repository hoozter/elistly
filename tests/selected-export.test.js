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
 await withPage(async page=>{
  const result=await page.evaluate(async()=>{
   App.data={version:'test',settings:{privateSetting:'exclude'},entities:{one:{id:'one',name:'Selected'}},entityTypes:{},categories:{}};
   App.showExportModal();
   const modal=document.getElementById('exportModal');
   const hasSettings=!!modal.querySelector('[name="exportSettings"]');
   modal.querySelector('[name="exportEntities"]').checked=true;
   let content;const original=URL.createObjectURL;URL.createObjectURL=blob=>{content=blob.text();return 'blob:test';};
   const click=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=()=>{};
   App.processExport();URL.createObjectURL=original;HTMLAnchorElement.prototype.click=click;
   return {hasSettings,payload:JSON.parse(await content),notice:modal.textContent};
  });
  assert.equal(result.hasSettings,false,'selected-data export does not offer account settings');
  assert.equal(Object.hasOwn(result.payload,'settings'),false);
  assert.equal(result.payload.entities.one.name,'Selected');
  assert.match(result.notice,/Profile/);
 });
 console.log('PASS selected export excludes settings and points to Profile backup');
}
run().catch(error=>{console.error(error);process.exitCode=1;});
