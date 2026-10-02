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
          person: { id: 'person', label: 'Person', category: 'people', icon: 'person', fields: [{ name: 'name', label: 'Name', type: 'text' }], associations: [
            { name: 'home', label: 'Building', association: { kind: 'belongs_to', targetType: 'building' } },
            { name: 'team', label: 'Team', association: { kind: 'belongs_to', targetType: 'team' } }
          ] },
          building: { id: 'building', label: 'Building', category: 'locations', icon: 'business', fields: [{ name: 'name', label: 'Name', type: 'text' }], associations: [] },
          team: { id: 'team', label: 'Team', category: 'people', fields: [{ name: 'name', label: 'Name', type: 'text' }], associations: [] },
          book: { id: 'book', label: 'Book', category: 'devices', fields: [{ name: 'name', label: 'Name', type: 'text' }], associations: [
            { name: 'reader', label: 'Borrower', association: { kind: 'belongs_to', targetType: 'person' } }
          ] }
        },
        entities: {
          alice: { id: 'alice', type: 'person', name: 'Alice', home: 'office', team: 'engineering' }, bob: { id: 'bob', type: 'person', name: 'Bob' },
          office: { id: 'office', type: 'building', name: 'Office' },
          engineering: { id: 'engineering', type: 'team', name: 'Engineering' },
          novel: { id: 'novel', type: 'book', name: 'Novel', reader: 'alice' },
          spare: { id: 'spare', type: 'computer', name: 'Unassigned laptop' },
          laptop: { id: 'laptop', type: 'computer', name: 'Laptop 01', assignedTo: 'alice', locatedAt: 'office' },
          phone: { id: 'phone', type: 'computer', name: 'Laptop 02', assignedTo: 'alice' }
        }
      };
      App.saveData = () => {};
      App.loadView = () => {};
      App.showEntityForm('person', 'alice');
    });
    assert.match(await page.locator('#entityView').textContent(), /Computers.*Laptop 01.*Laptop 02/s);
    assert.match(await page.locator('#entityView').textContent(), /Books.*Novel/s);
    assert.equal(await page.locator('#entityView .entity-related-item').count(), 3);
    assert.match(await page.locator('#entityView').textContent(), /Building.*Office.*Team.*Engineering/s);
    // A type added after this person exists gets a reciprocal section automatically.
    await page.evaluate(() => {
      App.data.entityTypes.agreement = { id: 'agreement', label: 'Agreement', category: 'devices', fields: [{ name: 'name', label: 'Name', type: 'text' }], associations: [
        { name: 'owner', label: 'Owner', association: { kind: 'belongs_to', targetType: 'person' } }
      ] };
      App.data.entities.signed = { id: 'signed', type: 'agreement', name: 'Signed contract', owner: 'alice' };
      document.getElementById('entityModal')?.remove();
      App.showEntityForm('person', 'alice');
    });
    assert.match(await page.locator('#entityView').textContent(), /Agreements.*Signed contract/s);
    await page.evaluate(() => App.showEntityEditMode(true));
    assert.equal(await page.locator('#entityEdit .entity-incoming-link').count(), 5);
    assert.equal(await page.locator('#entityEdit .entity-incoming-link input:checked').count(), 4);
    await page.locator('#entityEdit .entity-incoming-link[data-entity-id="spare"] input').check();
    assert.equal(await page.locator('#entityForm').getAttribute('data-dirty'), 'true');
    await page.locator('#entityEdit .entity-incoming-link[data-entity-id="laptop"] input').uncheck();
    await page.locator('#entityForm').evaluate(form => form.requestSubmit());
    assert.deepEqual(await page.evaluate(() => [App.data.entities.spare.assignedTo, App.data.entities.laptop.assignedTo]), ['alice', undefined]);
    await page.evaluate(() => { document.getElementById('entityModal')?.remove(); App.showEntityForm('person', 'alice'); });
    assert.match(await page.locator('#entityView').textContent(), /Unassigned laptop/);
    assert.doesNotMatch(await page.locator('#entityView').textContent(), /Laptop 01/);
    await page.evaluate(() => { document.getElementById('entityModal')?.remove(); App.showEntityForm('computer', 'spare'); App.showEntityEditMode(true); });
    await page.locator('#entityEdit select[name="assignedTo"]').selectOption('');
    await page.locator('#entityForm').evaluate(form => form.requestSubmit());
    assert.equal(await page.evaluate(() => App.data.entities.spare.assignedTo), undefined);
    await page.evaluate(() => { document.getElementById('entityModal')?.remove(); App.showEntityForm('person', 'alice'); });
    assert.doesNotMatch(await page.locator('#entityView').textContent(), /Unassigned laptop/);
    await page.evaluate(() => { document.getElementById('entityModal')?.remove(); App.showEntityForm('building', 'office'); });
    assert.match(await page.locator('#entityView').textContent(), /People.*Alice/s);
    await page.evaluate(() => { document.getElementById('entityModal')?.remove(); App.showEntityForm('team', 'engineering'); });
    assert.match(await page.locator('#entityView').textContent(), /People.*Alice/s);
    await page.evaluate(() => { document.getElementById('entityModal')?.remove(); App.showEntityForm('person', 'alice'); });
    await page.evaluate(() => App.showEntityEditMode(true));
    await page.locator('#entityEdit select[name="home"]').selectOption('');
    await page.locator('#entityEdit select[name="team"]').selectOption('');
    await page.locator('#entityForm').evaluate(form => form.requestSubmit());
    assert.deepEqual(await page.evaluate(() => [App.data.entities.alice.home, App.data.entities.alice.team]), [undefined, undefined]);
    await page.evaluate(() => { document.getElementById('entityModal')?.remove(); App.showEntityForm('person', 'alice'); });
    assert.doesNotMatch(await page.locator('#entityView').textContent(), /Office|Engineering/);
    await page.evaluate(() => { document.getElementById('entityModal')?.remove(); App.showEntityForm('person', 'alice'); });
    await page.evaluate(() => App.showEntityEditMode(true));
    await page.locator('#entityEdit .entity-incoming-link[data-entity-id="phone"] input').uncheck();
    await page.locator('#entityForm').evaluate(form => form.requestSubmit());
    assert.equal(await page.evaluate(() => App.data.entities.phone.assignedTo), undefined);
    await page.evaluate(() => { document.getElementById('entityModal')?.remove(); App.showEntityForm('person', 'alice'); });
    assert.match(await page.locator('#entityView').textContent(), /Books.*Novel/s);
    await page.evaluate(() => { document.getElementById('entityModal')?.remove(); App.showEntityForm('person', 'alice'); });
    await page.locator('#entityView .entity-related-item').first().click();
    assert.match(await page.locator('#entityModalTitle').textContent(), /Novel/);
    await page.evaluate(() => { App.data.entities.laptop.assignedTo = 'bob'; document.getElementById('entityModal')?.remove(); App.showEntityForm('person', 'alice'); });
    assert.doesNotMatch(await page.locator('#entityView').textContent(), /Laptop 01/);
    await page.evaluate(() => { document.getElementById('entityModal')?.remove(); App.showEntityForm('person', 'bob'); });
    assert.match(await page.locator('#entityView').textContent(), /Laptop 01/);
    await page.evaluate(() => App.removeLinksToDeletedEntities(['bob']));
    assert.equal(await page.evaluate(() => App.data.entities.laptop.assignedTo), undefined);
    await page.evaluate(() => { document.getElementById('entityModal')?.remove(); App.showEntityForm('building', 'office'); });
    assert.match(await page.locator('#entityView').textContent(), /Laptop 01/);
    await page.evaluate(() => { App.data.entities.laptop.assignedTo = 'missing'; document.getElementById('entityModal')?.remove(); App.showEntityForm('person', 'bob'); });
    assert.doesNotMatch(await page.locator('#entityView').textContent(), /Laptop 01/);
    await page.evaluate(() => {
      App.data.entityTypes.building.enabled = false;
      App.data.entities.alice.home = 'office';
      document.getElementById('entityModal')?.remove();
      App.showEntityForm('person', 'alice');
      App.showEntityEditMode(true);
    });
    assert.equal(await page.locator('#entityEdit select[name="home"]').inputValue(), 'office');
    assert.match(await page.locator('#entityEdit select[name="home"]').textContent(), /inactive/);
    await page.locator('#entityForm').evaluate(form => form.requestSubmit());
    assert.equal(await page.evaluate(() => App.data.entities.alice.home), 'office');
    console.log('PASS reverse associations');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
