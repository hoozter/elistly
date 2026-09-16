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
    browser = await chromium.launch({executablePath:'/usr/bin/google-chrome', headless:true, args:['--no-sandbox']});
    const page = await browser.newPage({serviceWorkers:'block'});
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}/app.html`);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const mode of ['editor', 'confirmation']) {
      await page.evaluate(() => {
        document.querySelectorAll('.modal').forEach(el => el.remove());
        App.data = {settings:{}, categories:{devices:{id:'devices',label:'Devices',icon:'devices'}}, entityTypes:{computer:{id:'computer',label:'Computer',categories:['devices'],fields:[]}}, entities:{test:{id:'test',type:'computer',name:'Disposable test'}, keep:{id:'keep',type:'computer',name:'Keep me'}}};
        window.saved = [];
        App.saveData = () => window.saved.push(structuredClone(App.data));
        App.loadView('devices');
      });
      if (mode === 'editor') {
        await page.evaluate(() => App.showEntityForm('computer', 'test'));
        await page.locator('#entityModal button').filter({hasText: /^editEdit$/}).click();
        await page.locator('#entityModal button').filter({hasText: /^deleteDelete$/}).click();
      } else {
        await page.evaluate(() => App.deleteEntity('test'));
        await page.locator('#confirmDeleteModal').getByRole('button', {name:'Delete',exact:true}).click();
      }
      await page.waitForTimeout(300);
      assert.deepEqual(errors, [], `${mode}: no browser exception`);
      assert.equal(await page.locator('#entityModal, #confirmDeleteModal').count(), 0);
      assert.doesNotMatch(await page.locator('#mainContent').innerText(), /Disposable test/);
      assert.match(await page.locator('#mainContent').innerText(), /Keep me/);
      assert.deepEqual(await page.evaluate(() => window.saved.map(data => Object.keys(data.entities))), [['keep']]);
      console.log(`PASS ${mode}: saved only intended deletion, closed dialog, refreshed inventory without reload`);
    }
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
