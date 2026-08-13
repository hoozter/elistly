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

async function testCategoryCsvExportUsesConfiguredColumnsAndSafeDeterministicCsv() {
  await withPage(async page => {
    const observed = await page.evaluate(() => {
      App.data = {
        settings: {},
        categories: { hardware: { id: 'hardware', label: 'Hardware, Lab' } },
        entityTypes: {
          device: {
            id: 'device', label: 'Device', category: 'hardware',
            fields: [
              { name: 'serial', label: 'Serial, Number', type: 'text' },
              { name: 'purchased', label: 'Purchased', type: 'date' },
              { name: 'state', label: 'State', type: 'dropdown' },
              { name: 'notes', label: 'Notes', type: 'textarea' },
              { name: 'tags', label: 'Tags', type: 'text' },
              { name: 'metadata', label: 'Metadata', type: 'text' }
            ],
            associations: [{ name: 'owner', label: 'Owner', association: { targetType: 'person' } }]
          },
          person: { id: 'person', label: 'Person', categoryId: 'people', fields: [] }
        },
        entities: {
          zed: { id: 'zed', type: 'device', name: '=Zed', serial: 'A,"B"', purchased: '2026-01-02', state: 'Ready', notes: 'First\r\nSecond', tags: ['α', 'beta'], metadata: { z: { nested: 1 }, a: 2 }, owner: 'ada' },
          ada: { id: 'ada', type: 'person', name: 'Ada Lovelace' },
          empty: { id: 'empty', type: 'device', name: 'Empty', serial: null, tags: [], owner: null },
          other: { id: 'other', type: 'person', name: 'Other' }
        },
        auth: { token: 'not-exported' }, outbox: [{ id: 'not-exported' }], runtimeConfig: { secret: true }
      };
      const before = structuredClone(App.data);
      const first = App.createCategoryCsvExport('hardware', 'device');
      const second = App.createCategoryCsvExport('hardware', 'device');
      return { before, after: App.data, first, second };
    });

    assert.deepEqual(observed.after, observed.before, 'CSV export must not mutate application data');
    assert.deepEqual(observed.first, observed.second, 'CSV serialization must be deterministic');
    assert.equal(observed.first.filename, 'elistly-hardware-lab-device-inventory.csv');
    assert.equal(observed.first.mimeType, 'text/csv;charset=utf-8');
    assert.equal(observed.first.content, '\uFEFFID,Type,Name,"Serial, Number",Purchased,State,Notes,Tags,Metadata,Owner\r\nzed,device,\'=Zed,"A,""B""",2026-01-02,Ready,"First\r\nSecond",α; beta,"{""a"":2,""z"":{""nested"":1}}",Ada Lovelace (ada)\r\nempty,device,Empty,,,,,,,\r\n');
  });
}

async function testCategoryCsvExportRejectsInvalidViewsAndBoundsBeforeDownload() {
  await withPage(async page => {
    const observed = await page.evaluate(() => {
      App.data = {
        settings: {}, categories: { hardware: { id: 'hardware', label: 'Hardware' } },
        entityTypes: { device: { id: 'device', label: 'Device', category: 'hardware', fields: [] } },
        entities: { one: { id: 'one', type: 'device', name: 'One' } }
      };
      const errors = [];
      for (const args of [['missing', 'device'], ['hardware', 'missing']]) {
        try { App.createCategoryCsvExport(...args); } catch (error) { errors.push(error.message); }
      }
      const originalLimits = App.csvExportLimits;
      App.csvExportLimits = { maxRows: 0, maxColumns: 100, maxCellLength: 100, maxBytes: 1000 };
      try { App.createCategoryCsvExport('hardware', 'device'); } catch (error) { errors.push(error.message); }
      App.csvExportLimits = { maxRows: 100, maxColumns: 2, maxCellLength: 100, maxBytes: 1000 };
      try { App.createCategoryCsvExport('hardware', 'device'); } catch (error) { errors.push(error.message); }
      App.csvExportLimits = { maxRows: 100, maxColumns: 100, maxCellLength: 2, maxBytes: 1000 };
      try { App.createCategoryCsvExport('hardware', 'device'); } catch (error) { errors.push(error.message); }
      App.csvExportLimits = { maxRows: 100, maxColumns: 100, maxCellLength: 100, maxBytes: 2 };
      try { App.createCategoryCsvExport('hardware', 'device'); } catch (error) { errors.push(error.message); }
      App.csvExportLimits = originalLimits;
      return errors;
    });
    assert.deepEqual(observed, [
      'Choose a category and entity type to export.',
      'Choose a category and entity type to export.',
      'CSV export exceeds the 0-row limit.',
      'CSV export exceeds the 2-column limit.',
      'CSV export exceeds the 2-character cell limit.',
      'CSV export exceeds the 2-byte limit.'
    ]);
  });
}

async function testCategoryCsvExportDownloadsTheDeclaredFileWithoutSaving() {
  await withPage(async page => {
    const observed = await page.evaluate(() => {
      App.data = {
        settings: {}, categories: { hardware: { id: 'hardware', label: 'Hardware' } },
        entityTypes: { device: { id: 'device', label: 'Device', category: 'hardware', fields: [] } },
        entities: { one: { id: 'one', type: 'device', name: 'One' } }
      };
      const before = structuredClone(App.data);
      const downloads = [];
      const originalCreateObjectURL = URL.createObjectURL;
      const originalRevokeObjectURL = URL.revokeObjectURL;
      const originalClick = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = blob => { downloads.push({ blob }); return 'blob:csv'; };
      URL.revokeObjectURL = () => {};
      HTMLAnchorElement.prototype.click = function () { downloads[0].filename = this.download; };
      const result = App.downloadCategoryCsvExport('hardware', 'device');
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
      HTMLAnchorElement.prototype.click = originalClick;
      return { result, before, after: App.data, download: { filename: downloads[0]?.filename, type: downloads[0]?.blob.type } };
    });
    assert.equal(observed.result, true);
    assert.deepEqual(observed.after, observed.before, 'downloading CSV must not save or mutate application data');
    assert.deepEqual(observed.download, { filename: 'elistly-hardware-device-inventory.csv', type: 'text/csv;charset=utf-8' });
  });
}

async function run() {
  await testCategoryCsvExportUsesConfiguredColumnsAndSafeDeterministicCsv();
  await testCategoryCsvExportRejectsInvalidViewsAndBoundsBeforeDownload();
  await testCategoryCsvExportDownloadsTheDeclaredFileWithoutSaving();
}

run().then(() => console.log('PASS CSV export')).catch(error => { console.error(`FAIL CSV export: ${error.stack || error.message}`); process.exitCode = 1; });
