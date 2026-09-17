'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://local').pathname.slice(1) || 'app.html';
  if (name === 'config.js') return res.writeHead(200, {'Content-Type':'application/javascript'}).end('');
  const file = path.resolve(root, name);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
  res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
    const page = await browser.newPage({serviceWorkers:'block'});
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}/app.html`);
    const before = await page.evaluate(() => {
      document.querySelectorAll('.modal').forEach(el => el.remove());
      const registration = {hardwareIdentity:'a'.repeat(64),inventorySnapshot:{collectedAt:'2026-09-16T12:00:00Z',ramBytes:17179869184,lastInteractiveUser:{username:'TEST\\example',time:'2026-09-16T12:00:00Z'}}};
      App.data = {settings:{},categories:{devices:{id:'devices',label:'Devices',icon:'devices'}},entityTypes:{computer:{id:'computer',label:'Computer',categories:['devices'],fields:[{name:'notes',label:'Notes',type:'text'}]}},entities:{test:{id:'test',type:'computer',name:'Test computer',notes:'Before',_elistlyRegistration:registration}}};
      window.saved=[];
      App.saveData=()=>window.saved.push(structuredClone(App.data));
      App.loadView('devices');
      App.showEntityForm('computer','test');
      return registration;
    });
    await page.locator('#entityModal button').filter({hasText:/^editEdit$/}).click();
    await page.locator('#entityModal [name="notes"]').fill('After');
    await page.locator('#entityModal button[type="submit"]').click();
    const saved = await page.evaluate(()=>window.saved.at(-1)?.entities.test);
    assert.equal(saved.notes,'After');
    assert.deepEqual(saved._elistlyRegistration,before,'ordinary field editing must preserve invisible collected facts');
    console.log('PASS: registered snapshot survives ordinary browser edit/save without requiring visible fields');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
