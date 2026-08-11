#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('/home/campbell/node_modules/playwright');
const root = path.resolve(__dirname, '..');

const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://x').pathname.replace(/^\/+/, '') || 'app.html';
  if (name === 'config.js') return res.writeHead(404).end();
  const file = path.resolve(root, name);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(fs.readFileSync(file));
});
const report = {
  schema: 'elistly.device-intake.v1', collectedAt: '2026-08-07T10:00:00.000Z',
  collector: { name: 'Elistly Windows Device Intake Collector', version: '1.0.0' },
  collection: { mode: 'local-only', networkDirectoryLookup: false, fields: ['computer.hostname'] },
  person: { displayName: '<img src=x onerror=window.__xss=1>', email: 'alex@example.com' },
  computer: { hostname: 'LAPTOP-01', windowsDomain: 'ACME', manufacturer: 'Dell', serialNumber: 'ABC123' }
};
const initial = { version: '1', settings: {}, categories: {}, entityTypes: {}, entities: {
  pc1: { id: 'pc1', type: 'computer', name: 'Serial PC', manufacturer: 'Dell', serialNumber: 'abc123', hostname: 'OTHER' },
  pc2: { id: 'pc2', type: 'computer', name: 'Host PC', hostname: 'laptop-01', windowsDomain: 'acme' }
}, workspaces: { default: { name: 'Default', categories: {}, entityTypes: {}, entities: {} } }, currentWorkspaceId: 'default' };

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/app.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(data => { App.data = data; localStorage.setItem('elistlyData', JSON.stringify(data)); window.__xss = 0; App.showDeviceIntake(); }, initial);
    assert.match(await page.locator('#deviceIntakeModal').textContent(), /local-only.*does not contact/i);
    assert.equal(await page.locator('#deviceCollectorDownload').getAttribute('download'), 'Elistly-Windows-Device-Intake-v1.0.2.zip');
    await page.locator('#deviceIntakeFile').setInputFiles({ name: 'report.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(report)) });
    await page.getByText('Choose the computer record').waitFor();
    assert.equal(await page.locator('#confirmDeviceIntake').isDisabled(), true);
    assert.equal(await page.locator('#deviceIntakePreview img').count(), 0, 'hostile report text must not create markup');
    assert.equal(await page.evaluate(() => window.__xss), 0);
    assert.deepEqual(await page.evaluate(() => App.data), initial, 'preview must be inert');
    await page.getByRole('radio', { name: /Serial PC/ }).check();
    assert.match(await page.locator('[data-device-intake-fields="computer"]').textContent(), /hostname.*overwritten.*OTHER.*LAPTOP-01/is);
    assert.match(await page.locator('[data-device-intake-fields="computer"]').textContent(), /id.*retained/is);
    await page.locator('#confirmDeviceIntake').click();
    await page.getByText('Device intake saved.').waitFor();
    assert.equal(await page.evaluate(() => App.data.entities.pc1.hostname), 'LAPTOP-01');
    await page.evaluate(() => App.showEntityForm('computer', 'pc1'));
    assert.match(await page.locator('#entityModal').textContent(), /Hostname\s+LAPTOP-01/i, 'imported fields must be visible in the normal entity view');
    assert.match(await page.locator('#entityModal').textContent(), /Serial number\s+ABC123/i, 'serial must be visible in the normal entity view');
    await page.evaluate(() => App.closeModal('entityModal'));

    await page.evaluate(data => { App.data = data; localStorage.setItem('elistlyData', JSON.stringify(data)); App.showDeviceIntake(); Storage.setAppDataForImport = async () => { throw new Error('simulated write failure'); }; }, initial);
    await page.locator('#deviceIntakeFile').setInputFiles({ name: 'report.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...report, computer: { manufacturer: 'Lenovo', serialNumber: 'NEW123' } })) });
    await page.locator('#confirmDeviceIntake:not([disabled])').click();
    await page.getByText(/not saved.*simulated write failure/i).waitFor();
    assert.deepEqual(await page.evaluate(() => App.data), initial, 'failed save must restore existing data');

    await page.evaluate(data => {
      App.data = data;
      localStorage.setItem('elistlyData', JSON.stringify(data));
      App.showDeviceIntake();
      Storage.setAppDataForImport = async candidate => {
        Storage._cached = candidate;
        const error = new Error('The import was saved remotely, but the local cache could not be updated. Reload before continuing.');
        error.remoteCommitted = true;
        throw error;
      };
    }, initial);
    await page.locator('#deviceIntakeFile').setInputFiles({ name: 'report.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...report, computer: { manufacturer: 'Lenovo', serialNumber: 'COMMITTED123' } })) });
    await page.locator('#confirmDeviceIntake:not([disabled])').click();
    await page.getByText(/saved remotely.*local cache.*reload/i).waitFor();
    assert.equal(await page.evaluate(() => App.data.entities['computer-2026-08-07'].serialNumber), 'COMMITTED123', 'post-commit cache warning must retain the remotely committed candidate');
    assert.equal((await page.locator('body').textContent()).includes('original data was restored'), false, 'post-commit warning must not claim rollback');
    console.log('PASS device-intake-browser');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
