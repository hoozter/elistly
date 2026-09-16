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
    await page.goto(`http://127.0.0.1:${server.address().port}/app.html`);
    await page.evaluate(() => {
      App.data = {settings:{}, categories:{devices:{id:'devices',label:'Devices',icon:'devices'}}, entityTypes:{computer:{id:'computer',label:'Computer',categories:['devices'],fields:[]}}, entities:{test:{id:'test',type:'computer',name:'Test laptop'}}};
      document.getElementById('authSignInModal')?.remove();
      App.renderCategoryView('devices');
    });
    const toggle = page.getByRole('button', {name:'Filters',exact:true});
    assert.equal(await toggle.count(), 1);
    const panel = page.locator('#inventoryFilters');
    assert.equal(await panel.isVisible(), false);
    await toggle.click();
    assert.equal(await panel.isVisible(), true);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await page.locator('[data-filter-type]').selectOption('computer');
    await toggle.click();
    assert.equal(await panel.isVisible(), false);
    await toggle.focus(); await page.keyboard.press('Enter');
    assert.equal(await panel.isVisible(), true);
    assert.equal(await page.locator('[data-filter-type]').inputValue(), 'computer');
    await toggle.click();
    await page.screenshot({path:'/tmp/elistly-filters-collapsed.png'});
    await toggle.click();
    await page.screenshot({path:'/tmp/elistly-filters-expanded.png'});
    assert.deepEqual(errors, []);
    console.log('PASS filters collapse by default, toggle by mouse/keyboard, preserve selection');
  } finally {await browser.close(); await new Promise(r => server.close(r));}
})().catch(e => {console.error(e); process.exitCode = 1;});
