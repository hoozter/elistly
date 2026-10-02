#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('/home/campbell/node_modules/playwright');
const root = path.resolve(__dirname, '..');
(async () => {
  const server = http.createServer((request, response) => {
    const relative = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\/+/, '') || 'app.html';
    if (relative === 'config.js') return response.writeHead(404).end();
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return response.writeHead(404).end();
    response.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/app.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      App.data = {
        settings: {}, categories: { devices: { id: 'devices', label: 'Devices' }, people: { id: 'people', label: 'People' }, locations: { id: 'locations', label: 'Locations' } },
        entityTypes: {
          computer: { id: 'computer', label: 'Computer', category: 'devices', icon: 'computer', fields: [{ name: 'name', label: 'Name', type: 'text' }], associations: [
            { name: 'assignedTo', label: 'Assigned To', association: { kind: 'belongs_to', targetType: 'person' } },
            { name: 'locatedAt', label: 'Located At', association: { kind: 'belongs_to', targetType: 'building' } }
          ] },
          person: { id: 'person', label: 'Person', category: 'people', icon: 'person', fields: [{ name: 'name', label: 'Name', type: 'text' }], associations: [] },
          building: { id: 'building', label: 'Building', category: 'locations', icon: 'business', fields: [{ name: 'name', label: 'Name', type: 'text' }], associations: [] }
        },
        entities: {
          alice: { id: 'alice', type: 'person', name: 'Alice' }, bob: { id: 'bob', type: 'person', name: 'Bob' },
          office: { id: 'office', type: 'building', name: 'Office' },
          laptop: { id: 'laptop', type: 'computer', name: 'Laptop 01', assignedTo: 'alice', locatedAt: 'office' },
          phone: { id: 'phone', type: 'computer', name: 'Laptop 02', assignedTo: 'alice' }
        }
      };
      App.showEntityForm('person', 'alice');
    });
    assert.match(await page.locator('#entityView').textContent(), /Computers.*Laptop 01.*Laptop 02/s);
    assert.equal(await page.locator('#entityView .entity-related-item').count(), 2);
    await page.locator('#entityView .entity-related-item').first().click();
    assert.match(await page.locator('#entityModalTitle').textContent(), /Laptop 01/);
    await page.evaluate(() => { App.data.entities.laptop.assignedTo = 'bob'; document.getElementById('entityModal')?.remove(); App.showEntityForm('person', 'alice'); });
    assert.doesNotMatch(await page.locator('#entityView').textContent(), /Laptop 01/);
    await page.evaluate(() => { document.getElementById('entityModal')?.remove(); App.showEntityForm('person', 'bob'); });
    assert.match(await page.locator('#entityView').textContent(), /Laptop 01/);
    await page.evaluate(() => { document.getElementById('entityModal')?.remove(); App.showEntityForm('building', 'office'); });
    assert.match(await page.locator('#entityView').textContent(), /Laptop 01/);
    await page.evaluate(() => { App.data.entities.laptop.assignedTo = 'missing'; document.getElementById('entityModal')?.remove(); App.showEntityForm('person', 'bob'); });
    assert.doesNotMatch(await page.locator('#entityView').textContent(), /Laptop 01/);
    console.log('PASS reverse associations');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
