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
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/app.html`, { waitUntil: 'domcontentloaded' });
    await run(page);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

async function testCsvImportParsesQuotedUnicodeRowsWithoutMutatingData() {
  await withPage(async page => {
    const observed = await page.evaluate(() => {
      App.data = {
        settings: {},
        categories: { hardware: { id: 'hardware', label: 'Hardware' } },
        entityTypes: { device: { id: 'device', label: 'Device', category: 'hardware', fields: [{ name: 'serial', label: 'Serial', type: 'text' }, { name: 'notes', label: 'Notes', type: 'textarea' }] } },
        entities: {}
      };
      const before = structuredClone(App.data);
      const parsed = App.parseCsvImport('\uFEFFSerial,Notes\r\nA-1,"First\r\n東京"\r\n');
      return { before, after: App.data, parsed };
    });
    assert.deepEqual(observed.after, observed.before, 'parsing a CSV must not mutate application data');
    assert.deepEqual(observed.parsed, { headers: ['Serial', 'Notes'], rows: [['A-1', 'First\r\n東京']] });
  });
}

async function testCsvImportBuildsAReadOnlyMappedPreviewAndCreatesOnlyConfirmedValidRows() {
  await withPage(async page => {
    const observed = await page.evaluate(async () => {
      App.data = {
        version: '1', settings: {},
        categories: { hardware: { id: 'hardware', label: 'Hardware' } },
        entityTypes: {
          device: {
            id: 'device', label: 'Device', category: 'hardware', fields: [
              { name: 'serial', label: 'Serial', type: 'text', required: true },
              { name: 'count', label: 'Count', type: 'number' },
              { name: 'state', label: 'State', type: 'dropdown', options: [{ value: 'ready', label: 'Ready' }] },
              { name: 'notes', label: 'Notes', type: 'textarea' },
              { name: 'tags', label: 'Tags', type: 'text' }
            ],
            associations: [{ name: 'owner', label: 'Owner', association: { targetType: 'person' } }]
          },
          person: { id: 'person', label: 'Person', category: 'hardware', fields: [] }
        },
        entities: { ada: { id: 'ada', type: 'person', name: 'Ada Lovelace' } }
      };
      const before = structuredClone(App.data);
      const preview = App.createCsvImportPreview('device', 'Serial,Count,State,Notes,Tags,Owner,Ignored\r\nA-1,2,Ready,"First\n東京",alpha; beta,Ada Lovelace (ada),x\r\n,not-a-number,Wrong,,,Missing,z\r\n', { 0: 'serial', 1: 'count', 2: 'state', 3: 'notes', 4: 'tags', 5: 'owner' });
      const afterPreview = structuredClone(App.data);
      const validPreview = App.createCsvImportPreview('device', 'Serial,Count,State,Notes,Tags,Owner\r\nA-1,2,Ready,"First\n東京",alpha; beta,Ada Lovelace (ada)\r\n', { 0: 'serial', 1: 'count', 2: 'state', 3: 'notes', 4: 'tags', 5: 'owner' });
      const saved = [];
      const original = Storage.setAppDataForImport;
      Storage.setAppDataForImport = async candidate => { saved.push(structuredClone(candidate)); return true; };
      let rejected;
      try { await App.confirmCsvImport(preview, null); } catch (error) { rejected = error.message; }
      const result = await App.confirmCsvImport(validPreview, null);
      Storage.setAppDataForImport = original;
      return { before, afterPreview, preview, result, rejected, after: App.data, saved };
    });
    assert.deepEqual(observed.afterPreview, observed.before, 'preview must not mutate application data');
    assert.deepEqual(observed.preview.ignored, ['Ignored']);
    assert.equal(observed.preview.rows[0].errors.length, 0);
    const rowErrors = observed.preview.rows[1].errors.join(' ');
    assert.match(rowErrors, /Serial is required/i);
    assert.match(rowErrors, /Count must be a number/i);
    assert.match(rowErrors, /State must match a configured option/i);
    assert.match(rowErrors, /Owner does not identify an existing Person/i);
    assert.match(observed.rejected, /validation errors/i);
    assert.deepEqual(observed.result, { created: 1, rejected: 0 });
    assert.equal(Object.values(observed.after.entities).filter(entity => entity.type === 'device').length, 1);
    assert.equal(observed.after.entities.ada.name, 'Ada Lovelace', 'import must not modify association targets');
    assert.equal(observed.saved.length, 1, 'all valid rows must persist as one candidate');
  });
}

async function testCsvImportRejectsMalformedBoundedDuplicateAndStaleInputsWithoutSaving() {
  await withPage(async page => {
    const observed = await page.evaluate(async () => {
      App.data = { version: '1', settings: {}, categories: {}, entityTypes: { device: { id: 'device', label: 'Device', fields: [{ name: 'serial', label: 'Serial', type: 'text' }] } }, entities: {} };
      const before = structuredClone(App.data);
      const errors = [];
      for (const source of ['Serial\n"unterminated', 'Serial,Other\nx,y']) {
        try {
          if (source.includes('Other')) App.createCsvImportPreview('device', source, { 0: 'serial', 1: 'serial' });
          else App.parseCsvImport(source);
        } catch (error) { errors.push(error.message); }
      }
      const limits = App.csvImportLimits;
      App.csvImportLimits = { ...limits, maxRows: 0 };
      try { App.parseCsvImport('Serial\nx'); } catch (error) { errors.push(error.message); }
      App.csvImportLimits = limits;
      const preview = App.createCsvImportPreview('device', 'Serial\nx', { 0: 'serial' });
      App.data.entities.existing = { id: 'existing', type: 'device', serial: 'different' };
      try { await App.confirmCsvImport(preview, null); } catch (error) { errors.push(error.message); }
      return { before, after: App.data, errors };
    });
    assert.match(observed.errors[0], /unterminated quoted cell/i);
    assert.match(observed.errors[1], /mapped more than once/i);
    assert.match(observed.errors[2], /0-row limit/i);
    assert.match(observed.errors[3], /preview is stale/i);
    assert.equal(observed.after.entities.existing.serial, 'different', 'stale confirmation must create nothing');
  });
}

async function run() {
  await testCsvImportParsesQuotedUnicodeRowsWithoutMutatingData();
  await testCsvImportBuildsAReadOnlyMappedPreviewAndCreatesOnlyConfirmedValidRows();
  await testCsvImportRejectsMalformedBoundedDuplicateAndStaleInputsWithoutSaving();
}

run().then(() => console.log('PASS CSV import')).catch(error => { console.error(`FAIL CSV import: ${error.stack || error.message}`); process.exitCode = 1; });
