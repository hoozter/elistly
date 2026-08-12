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

const hostile = '<img src=x onerror=window.__deviceIntakeXss=1>';
const report = {
  schema: 'elistly.device-intake.v1',
  collectedAt: '2026-08-07T10:00:00.000Z',
  collector: { name: 'Elistly Windows Device Intake Collector', version: '1.0.2' },
  collection: { mode: 'local-only', networkDirectoryLookup: false, fields: ['computer.hostname'] },
  person: { displayName: hostile, accountName: 'campbell', email: 'campbell@example.test' },
  computer: {
    hostname: 'LAPTOP-01', windowsDomain: 'ACME', accountName: 'campbell', manufacturer: 'Dell',
    model: 'Latitude 7450', graphicsAdapters: ['Intel Graphics', 'NVIDIA RTX'], windowsEdition: 'Windows 11', serialNumber: 'ABC123'
  }
};
const initial = {
  version: '1', settings: {},
  categories: { devices: { id: 'devices', label: 'Devices' }, people: { id: 'people', label: 'People' } },
  entityTypes: {
    computer: {
      id: 'computer', label: 'Computer', category: 'devices', icon: 'computer', enableNameGen: false,
      fields: [
        { name: 'hostname', label: 'Hostname', type: 'text' },
        { name: 'manufacturer', label: 'Manufacturer', type: 'text' },
        { name: 'model', label: 'Model', type: 'text' },
        { name: 'gpu', label: 'Graphics', type: 'textarea' },
        { name: 'serialNumber', label: 'Serial number', type: 'text' },
        { name: 'notes', label: 'Notes', type: 'textarea' }
      ],
      associations: [{ name: 'assignedTo', label: 'Assigned To', type: 'association', association: { kind: 'belongs_to', targetType: 'person' } }]
    },
    person: {
      id: 'person', label: 'Person', category: 'people', icon: 'person', enableNameGen: false,
      fields: [{ name: 'name', label: 'Name', type: 'text' }], associations: []
    }
  },
  entities: {
    person1: { id: 'person1', type: 'person', name: 'Existing Person' },
    existingComputer: { id: 'existingComputer', type: 'computer', hostname: 'EXISTING-PC', model: 'Older model' }
  }
};

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/app.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(data => {
      App.data = structuredClone(data);
      localStorage.setItem('elistlyData', JSON.stringify(data));
      window.__deviceIntakeXss = 0;
    }, initial);

    await page.evaluate(() => App.showSettingsModal());
    const settings = page.locator('#settingsModal');
    assert.equal(await settings.locator('#deviceCollectorDownload').getAttribute('download'), 'Elistly-Windows-Device-Intake-v1.0.2.zip');
    assert.match(await settings.textContent(), /Device Collector.*local-only.*administrator/is);
    assert.equal(await settings.locator('#deviceIntakeFile').count(), 0, 'Settings must not contain report selection');
    assert.doesNotMatch(await settings.textContent(), /Confirm import|Upload the report/i);
    const beforeFieldUpgrade = await page.evaluate(() => JSON.stringify(App.data));
    await settings.getByRole('button', { name: 'Add recommended Windows fields' }).click();
    const confirmFields = page.locator('#confirmModal');
    assert.match(await confirmFields.textContent(), /Processor.*Memory.*Windows build/is);
    assert.doesNotMatch(await confirmFields.textContent(), /Hostname.*Manufacturer.*Serial number/is, 'already configured collection fields must not be proposed again');
    assert.equal(await page.evaluate(() => JSON.stringify(App.data)), beforeFieldUpgrade, 'opening the recommendation must not mutate application data');
    await confirmFields.getByRole('button', { name: 'Add fields' }).click();
    const upgraded = await page.evaluate(() => ({
      people: Object.values(App.data.entities).filter(entity => entity.type === 'person'),
      fields: App.data.entityTypes.computer.fields
    }));
    assert.deepEqual(upgraded.people, [initial.entities.person1], 'field setup must not create or alter Persons');
    assert.deepEqual(upgraded.fields.find(field => field.name === 'hostname'), initial.entityTypes.computer.fields.find(field => field.name === 'hostname'), 'existing legacy aliases must remain unchanged');
    assert.ok(upgraded.fields.some(field => field.name === 'processorSummary' && field.collection?.capability === 'processor.summary'));
    assert.deepEqual(upgraded.fields.find(field => field.name === 'serialNumber'), initial.entityTypes.computer.fields.find(field => field.name === 'serialNumber'), 'existing serial field must remain unchanged');
    assert.ok(upgraded.fields.filter(field => !initial.entityTypes.computer.fields.some(existing => existing.name === field.name)).every(field => field.required === false), 'new recommended fields must all be optional');
    await page.evaluate(data => { App.data = structuredClone(data); localStorage.setItem('elistlyData', JSON.stringify(data)); }, initial);
    await page.evaluate(() => App.closeModal('settingsModal'));
    await settings.waitFor({ state: 'detached' });

    await page.evaluate(() => App.showEntityForm('computer', 'existingComputer'));
    assert.equal(await page.locator('#entityModal #deviceIntakeFile').count(), 0, 'existing Computer editing is out of scope');
    await page.evaluate(() => App.closeModal('entityModal'));
    await page.locator('#entityModal').waitFor({ state: 'detached' });

    const ordering = await page.evaluate(async sourceReport => {
      App.showEntityForm('computer');
      const form = document.getElementById('entityForm');
      const result = form.querySelector('.device-intake-result');
      const first = structuredClone(sourceReport);
      first.computer.hostname = 'FIRST-PC';
      first.computer.serialNumber = 'FIRST123';
      const second = structuredClone(sourceReport);
      second.computer.hostname = 'SECOND-PC';
      second.computer.serialNumber = 'SECOND123';
      const delayedFile = { size: 100, text: () => new Promise(resolve => setTimeout(() => resolve(JSON.stringify(first)), 50)) };
      const latestFile = { size: 100, text: async () => JSON.stringify(second) };
      await Promise.all([
        App.readDeviceIntakeDraftReport({ target: { files: [delayedFile] } }, App.data.entityTypes.computer, form, result),
        App.readDeviceIntakeDraftReport({ target: { files: [latestFile] } }, App.data.entityTypes.computer, form, result)
      ]);
      return { hostname: form.elements.hostname.value, result: result.textContent };
    }, report);
    assert.equal(ordering.hostname, 'SECOND-PC');
    assert.doesNotMatch(ordering.result, /FIRST-PC/, 'a slower stale file read must not replace the latest proposal');
    await page.evaluate(() => App.closeModal('entityModal'));
    await page.locator('#entityModal').waitFor({ state: 'detached' });

    await page.evaluate(() => App.showEntityForm('computer'));
    const manualForm = page.locator('#entityForm');
    await manualForm.locator('[name="hostname"]').fill('MANUAL-ONLY');
    await manualForm.locator('[name="notes"]').fill('Created without a report');
    await manualForm.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Entity created successfully').waitFor();
    await page.locator('#entityModal').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => Object.values(App.data.entities).some(entity => entity.type === 'computer' && entity.hostname === 'MANUAL-ONLY' && entity.notes === 'Created without a report')), true, 'manual Add Computer remains unchanged');

    const beforeDraftImport = await page.evaluate(() => JSON.stringify(App.data));
    await page.evaluate(() => App.showEntityForm('computer'));
    const form = page.locator('#entityForm');
    assert.equal(await form.locator('#deviceIntakeFile').count(), 1, 'new Computer form exposes report selection');
    assert.deepEqual(await form.locator('select[name="assignedTo"] option').evaluateAll(options => options.map(option => [option.value, option.textContent])), [
      ['', '— None —'], ['person1', 'Existing Person']
    ]);
    await form.locator('[name="hostname"]').fill('MANUAL-PC');
    await form.locator('[name="model"]').fill('Manually selected model');
    await form.locator('#deviceIntakeFile').setInputFiles({ name: 'report.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(report)) });
    await form.locator('.device-intake-result').getByText(/Imported 3 fields/i).waitFor();
    assert.equal(await form.locator('[name="hostname"]').inputValue(), 'MANUAL-PC', 'existing hostname draft must not be overwritten');
    assert.equal(await form.locator('[name="model"]').inputValue(), 'Manually selected model', 'existing model draft must not be overwritten');
    assert.equal(await form.locator('[name="manufacturer"]').inputValue(), 'Dell');
    assert.equal(await form.locator('[name="gpu"]').inputValue(), 'Intel Graphics; NVIDIA RTX');
    assert.equal(await form.locator('[name="serialNumber"]').inputValue(), 'ABC123');
    assert.equal(await form.locator('[name="windowsEdition"]').count(), 0, 'missing schema fields must not be synthesized');
    assert.equal(await form.locator('select[name="assignedTo"]').inputValue(), '', 'collected account must not select a Person');
    assert.match(await form.locator('.device-intake-account-context').textContent(), /campbell.*campbell@example\.test.*ACME/is);
    assert.equal(await form.locator('.device-intake-result img, .device-intake-result script, .device-intake-result svg').count(), 0, 'report text must not create active markup');
    assert.equal(await page.evaluate(() => window.__deviceIntakeXss), 0);
    assert.match(await form.locator('details.device-intake-unmapped').textContent(), /Not imported.*windowsEdition.*No existing field/is);
    assert.equal(await page.evaluate(() => JSON.stringify(App.data)), beforeDraftImport, 'draft import must not mutate application data');

    await form.locator('.device-intake-conflict[data-field="hostname"]').getByRole('button', { name: 'Keep current' }).click();
    await form.locator('.device-intake-conflict[data-field="model"]').getByRole('button', { name: 'Use collected' }).click();
    assert.equal(await form.locator('[name="hostname"]').inputValue(), 'MANUAL-PC');
    assert.equal(await form.locator('[name="model"]').inputValue(), 'Latitude 7450');

    await form.getByRole('button', { name: 'Cancel' }).click();
    await page.locator('#confirmModal').getByRole('button', { name: 'Discard' }).click();
    await page.locator('#entityModal').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => JSON.stringify(App.data)), beforeDraftImport, 'Cancel must persist nothing');

    await page.evaluate(() => App.showEntityForm('computer'));
    const invalidForm = page.locator('#entityForm');
    await invalidForm.locator('#deviceIntakeFile').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"schema":"wrong"}') });
    assert.match(await invalidForm.locator('.device-intake-result').textContent(), /unsupported schema/i);
    assert.equal(await page.evaluate(() => JSON.stringify(App.data)), beforeDraftImport, 'invalid report must persist nothing');
    await page.evaluate(() => App.closeModal('entityModal'));
    await page.locator('#entityModal').waitFor({ state: 'detached' });

    const countsBeforeSave = await page.evaluate(() => ({
      computers: Object.values(App.data.entities).filter(entity => entity.type === 'computer').length,
      people: Object.values(App.data.entities).filter(entity => entity.type === 'person').length
    }));
    await page.evaluate(() => {
      window.__deviceIntakeSaveCalls = 0;
      const ordinarySave = App.saveEntity.bind(App);
      App.saveEntity = (...args) => {
        window.__deviceIntakeSaveCalls += 1;
        return ordinarySave(...args);
      };
      App.showEntityForm('computer');
    });
    const saveForm = page.locator('#entityForm');
    await saveForm.locator('#deviceIntakeFile').setInputFiles({ name: 'report.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(report)) });
    await saveForm.locator('.device-intake-result').getByText(/Imported 5 fields/i).waitFor();
    await saveForm.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Entity created successfully').waitFor();
    const saved = await page.evaluate(() => {
      const entity = Object.values(App.data.entities).find(item => item.type === 'computer' && item.serialNumber === 'ABC123');
      return {
        entity,
        saveCalls: window.__deviceIntakeSaveCalls,
        computers: Object.values(App.data.entities).filter(item => item.type === 'computer').length,
        people: Object.values(App.data.entities).filter(item => item.type === 'person').length
      };
    });
    assert.equal(saved.saveCalls, 1, 'normal entity Save path must be invoked exactly once');
    assert.equal(saved.computers, countsBeforeSave.computers + 1);
    assert.equal(saved.people, countsBeforeSave.people, 'import must not create a Person');
    assert.equal(saved.entity.assignedTo, undefined, 'Person association remains None');
    assert.equal(saved.entity.model, 'Latitude 7450');

    await page.reload({ waitUntil: 'domcontentloaded' });
    const persisted = await page.evaluate(() => {
      App.data = JSON.parse(localStorage.getItem('elistlyData'));
      const entity = Object.values(App.data.entities).find(item => item.type === 'computer' && item.serialNumber === 'ABC123');
      if (entity) App.showEntityForm('computer', entity.id);
      return entity;
    });
    assert.equal(persisted.model, 'Latitude 7450', 'saved Computer survives refresh');
    assert.equal(await page.locator('#entityModal #deviceIntakeFile').count(), 0);
    await page.locator('#entityViewActions').getByRole('button', { name: 'Edit' }).click();
    assert.equal(await page.locator('#entityForm [name="model"]').inputValue(), 'Latitude 7450', 'saved Computer remains editable in the normal form');

    console.log('PASS device-intake-browser');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
