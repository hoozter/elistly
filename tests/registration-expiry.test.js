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
    await page.evaluate(async () => {
      document.getElementById('authSignInModal')?.remove();
      window.ELISTLY_API_URL = location.origin;
      App.data.currentWorkspaceId = 'default';
      App.showSettingsModal();
      await App.showDeviceRegistrationModal();
      const container = document.querySelector('.device-registration-tokens');
      App.renderDeviceRegistrationTokens(container, [
        {id:'test1',label:'Permanent',expires_at:null},
        {id:'test2',label:'Scheduled',expires_at:'2099-01-01T00:00:00Z'},
        {id:'test3',label:'Old',expires_at:'2020-01-01T00:00:00Z'},
        {id:'test4',label:'Revoked',expires_at:null,revoked_at:'2026-01-01T00:00:00Z'}
      ], async () => {});
    });
    await page.locator('#deviceRegistrationModal summary').click();
    assert.equal(await page.getByLabel('Optional expiry', {exact:false}).inputValue(), '');
    const rows = await page.locator('.device-registration-token-list li').allTextContents();
    assert.match(rows[0], /Active; no automatic expiry/);
    assert.match(rows[1], /Active; expires/);
    assert.match(rows[2], /Expired/);
    assert.match(rows[3], /Revoked/);
    assert.equal(await page.getByRole('button',{name:'Revoke',exact:true}).count(), 2);
    assert.equal(await page.locator('#deviceRegistrationModal').getByRole('button',{name:'Save and download',exact:true}).count(), 1);
    for (const viewport of [{width:1280,height:720}, {width:390,height:844}]) {
      await page.setViewportSize(viewport);
      const panel = page.locator('#deviceRegistrationModal .modal-content');
      assert.equal(await panel.count(), 1, 'registration uses the shared modal panel');
      await page.evaluate(async () => { await Promise.all(document.getAnimations().map(animation => animation.finished)); });
      const box = await panel.boundingBox();
      assert.ok(box.width <= 680 && box.x >= 0 && box.x + box.width <= viewport.width);
      assert.ok(box.y >= 0 && box.y + box.height <= viewport.height);
      assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth), true, 'no horizontal overflow');
      const heading = await panel.locator('h3').boundingBox();
      const expiry = await page.locator('#registrationExpiry').boundingBox();
      assert.ok(expiry.y > heading.y + heading.height, 'form is below the header, not alongside it');
      await page.locator('#deviceRegistrationModal .modal-content').screenshot({path:`/tmp/elistly-registration-${viewport.width}.png`});
    }
    await page.getByRole('button',{name:'Done',exact:true}).click();
    await page.waitForFunction(() => !document.getElementById('deviceRegistrationModal'));
    assert.deepEqual(errors, []);
    console.log('PASS optional expiry defaults blank; permanent, scheduled, expired and revoked display correctly');
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
