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

async function testCategoryViewProvidesAccessibleLocalBulkSelectionControls() {
  await withPage(async page => {
    const result = await page.evaluate(() => {
      App.data = {
        settings: {},
        categories: { devices: { id: 'devices', label: 'Devices', icon: 'devices' } },
        entityTypes: { computer: { id: 'computer', label: 'Computer', categories: ['devices'], fields: [] } },
        entities: {
          alpha: { id: 'alpha', type: 'computer', name: 'Alpha laptop' },
          beta: { id: 'beta', type: 'computer', name: 'Beta laptop' }
        }
      };
      App.renderCategoryView('devices');
      return {
        selectAll: document.querySelector('[data-select-all-visible]')?.getAttribute('aria-label'),
        entitySelections: [...document.querySelectorAll('[data-entity-selection]')].map(control => ({ id: control.value, label: control.getAttribute('aria-label') })),
        count: document.querySelector('[data-selected-count]')?.textContent,
        selectedExportDisabled: document.querySelector('[data-selected-csv-export]')?.disabled
      };
    });
    assert.deepEqual(result, {
      selectAll: 'Select all visible entities',
      entitySelections: [
        { id: 'alpha', label: 'Select Alpha laptop' },
        { id: 'beta', label: 'Select Beta laptop' }
      ],
      count: '0 selected',
      selectedExportDisabled: true
    });
  });
}

async function testSelectedCsvExportUsesVisibleSortedEntitiesAndExistingSafeSerializer() {
  await withPage(async page => {
    const result = await page.evaluate(() => {
      App.data = {
        settings: {},
        categories: { devices: { id: 'devices', label: 'Devices', icon: 'devices' } },
        entityTypes: { computer: { id: 'computer', label: 'Computer', categories: ['devices'], fields: [{ name: 'serial', label: 'Serial', type: 'text' }] } },
        entities: {
          alpha: { id: 'alpha', type: 'computer', name: '=Alpha laptop', serial: '=danger' },
          beta: { id: 'beta', type: 'computer', name: 'Beta laptop', serial: 'B-2' },
          hidden: { id: 'hidden', type: 'computer', name: 'Archive', serial: 'H-3' }
        }
      };
      App.renderCategoryView('devices');
      document.querySelector('[data-filter-type]').value = 'computer';
      App.updateAdvancedFilterControls();
      document.querySelector('[data-sort-direction]').value = 'desc';
      document.getElementById('searchInput').value = 'laptop';
      App.updateAdvancedFilterResults();
      App._selectedEntityIds = new Set(['beta', 'alpha', 'hidden']);
      return App.createSelectedCategoryCsvExport('devices', 'computer', App._visibleBulkSelectionEntities);
    });
    assert.equal(result.content, '\uFEFFID,Type,Name,Serial\r\nbeta,computer,Beta laptop,B-2\r\nalpha,computer,\'=Alpha laptop,\'=danger\r\n');
  });
}

async function testSelectionComposesWithVisibleFiltersAndResetsWithoutSaving() {
  await withPage(async page => {
    await page.evaluate(() => {
      App.data = { settings: {}, categories: { devices: { id: 'devices', label: 'Devices', icon: 'devices' }, books: { id: 'books', label: 'Books', icon: 'menu_book' } }, entityTypes: { computer: { id: 'computer', label: 'Computer', categories: ['devices'], fields: [{ name: 'rank', label: 'Rank', type: 'number' }] }, book: { id: 'book', label: 'Book', categories: ['books'], fields: [] } }, entities: { alpha: { id: 'alpha', type: 'computer', name: 'Alpha laptop', rank: 2 }, beta: { id: 'beta', type: 'computer', name: 'Beta laptop', rank: 1 }, book: { id: 'book', type: 'book', name: 'Book' } } };
      window.__saveCalls = 0;
      App.saveData = () => { window.__saveCalls += 1; };
      App.renderCategoryView('devices');
      document.getElementById('authSignInModal')?.remove();
    });
    await page.locator('[data-filter-type]').selectOption('computer');
    await page.locator('[data-sort-field]').selectOption('rank');
    await page.locator('[data-sort-direction]').selectOption('desc');
    await page.locator('[data-select-all-visible]').check();
    let observed = await page.evaluate(() => ({ count: document.querySelector('[data-selected-count]').textContent, selected: [...document.querySelectorAll('[data-entity-selection]:checked')].map(input => input.value), exportEnabled: !document.querySelector('[data-selected-csv-export]').disabled, saves: window.__saveCalls }));
    assert.deepEqual(observed, { count: '2 selected', selected: ['alpha', 'beta'], exportEnabled: true, saves: 0 });
    if (process.env.ELISTLY_BULK_SELECTION_SCREENSHOT) await page.screenshot({ path: process.env.ELISTLY_BULK_SELECTION_SCREENSHOT, fullPage: true });
    await page.locator('[data-entity-selection][value="beta"]').uncheck();
    await page.evaluate(() => { document.getElementById('searchInput').value = 'beta'; App.updateAdvancedFilterResults(); });
    observed = await page.evaluate(() => ({ count: document.querySelector('[data-selected-count]').textContent, visible: [...document.querySelectorAll('[data-entity-selection]')].map(input => input.value), exportDisabled: document.querySelector('[data-selected-csv-export]').disabled, saves: window.__saveCalls }));
    assert.deepEqual(observed, { count: '0 selected', visible: ['beta'], exportDisabled: true, saves: 0 });
    await page.evaluate(() => App.renderCategoryView('books'));
    assert.deepEqual(await page.evaluate(() => ({ count: document.querySelector('[data-selected-count]').textContent, saves: window.__saveCalls })), { count: '0 selected', saves: 0 });
  });
}

async function testSelectedDeletionRequiresExplicitConfirmation() {
  await withPage(async page => {
    await page.evaluate(() => {
      App.data = { settings: {}, categories: { devices: { id: 'devices', label: 'Devices', icon: 'devices' } }, entityTypes: { computer: { id: 'computer', label: 'Computer', categories: ['devices'], fields: [] } }, entities: { alpha: { id: 'alpha', type: 'computer', name: 'Alpha laptop' }, beta: { id: 'beta', type: 'computer', name: 'Beta laptop' } } };
      window.__saveCalls = 0;
      App.saveData = () => { window.__saveCalls += 1; };
      App.renderCategoryView('devices');
      document.getElementById('authSignInModal')?.remove();
    });
    await page.locator('[data-filter-type]').selectOption('computer');
    await page.locator('[data-select-all-visible]').check();
    assert.equal(await page.locator('[data-selected-delete]').count(), 1, 'selection toolbar provides deletion action');
    await page.locator('[data-selected-delete]').click();
    assert.deepEqual(await page.evaluate(() => ({
      message: document.getElementById('confirmMessage')?.textContent,
      entities: Object.keys(App.data.entities).sort(),
      saves: window.__saveCalls
    })), { message: 'Delete 2 selected items? This cannot be undone.', entities: ['alpha', 'beta'], saves: 0 });
    await page.locator('#confirmModal .btn.btn-secondary').click();
    assert.deepEqual(await page.evaluate(() => ({
      count: document.querySelector('[data-selected-count]').textContent,
      entities: Object.keys(App.data.entities).sort(),
      saves: window.__saveCalls
    })), { count: '2 selected', entities: ['alpha', 'beta'], saves: 0 });
  });
}

async function testSelectedDeletionRemovesOnlyTheConfirmedSetAndPersists() {
  await withPage(async page => {
    await page.evaluate(() => {
      App.data = { settings: { keep: true }, categories: { devices: { id: 'devices', label: 'Devices', icon: 'devices' }, people: { id: 'people', label: 'People', icon: 'group' } }, entityTypes: { computer: { id: 'computer', label: 'Computer', categories: ['devices'], fields: [] }, person: { id: 'person', label: 'Person', categories: ['people'], fields: [] } }, entities: { alpha: { id: 'alpha', type: 'computer', name: 'Alpha laptop' }, beta: { id: 'beta', type: 'computer', name: 'Beta laptop' }, person: { id: 'person', type: 'person', name: 'Ada', deviceId: 'alpha' } } };
      window.__saveCalls = 0;
      App.saveData = () => { window.__saveCalls += 1; };
      App.renderCategoryView('devices');
      document.getElementById('authSignInModal')?.remove();
    });
    await page.locator('[data-filter-type]').selectOption('computer');
    await page.locator('[data-entity-selection][value="alpha"]').check();
    await page.locator('[data-selected-delete]').click();
    await page.locator('#confirmButton').click();
    assert.deepEqual(await page.evaluate(() => ({
      count: App._selectedEntityIds.size,
      entities: Object.keys(App.data.entities).sort(),
      linkedDevice: App.data.entities.person.deviceId,
      categories: Object.keys(App.data.categories).sort(),
      settings: App.data.settings,
      saves: window.__saveCalls
    })), { count: 0, entities: ['beta', 'person'], linkedDevice: 'alpha', categories: ['devices', 'people'], settings: { keep: true }, saves: 1 });
  });
}

async function testSelectedDeletionKeepsLocalStateCoherentWhenPersistenceFails() {
  await withPage(async page => {
    await page.evaluate(() => {
      App.data = { settings: {}, categories: { devices: { id: 'devices', label: 'Devices', icon: 'devices' } }, entityTypes: { computer: { id: 'computer', label: 'Computer', categories: ['devices'], fields: [] } }, entities: { alpha: { id: 'alpha', type: 'computer', name: 'Alpha laptop' }, beta: { id: 'beta', type: 'computer', name: 'Beta laptop' } } };
      window.__notifications = [];
      App.showNotification = (message, kind) => window.__notifications.push({ message, kind });
      Storage.setAppData = () => Promise.reject(new Error('persistence unavailable'));
      App.renderCategoryView('devices');
      document.getElementById('authSignInModal')?.remove();
    });
    await page.locator('[data-filter-type]').selectOption('computer');
    await page.locator('[data-entity-selection][value="alpha"]').check();
    await page.locator('[data-selected-delete]').click();
    await page.locator('#confirmButton').click();
    await page.waitForFunction(() => window.__notifications.some(notification => notification.kind === 'error'));
    assert.deepEqual(await page.evaluate(() => ({
      count: App._selectedEntityIds.size,
      entities: Object.keys(App.data.entities).sort(),
      errors: window.__notifications.filter(notification => notification.kind === 'error').map(notification => notification.message)
    })), { count: 0, entities: ['beta'], errors: ['Your changes could not be saved. Your local changes are still open.'] });
  });
}

async function run() {
  await testCategoryViewProvidesAccessibleLocalBulkSelectionControls();
  await testSelectedCsvExportUsesVisibleSortedEntitiesAndExistingSafeSerializer();
  await testSelectionComposesWithVisibleFiltersAndResetsWithoutSaving();
  await testSelectedDeletionRequiresExplicitConfirmation();
  await testSelectedDeletionRemovesOnlyTheConfirmedSetAndPersists();
  await testSelectedDeletionKeepsLocalStateCoherentWhenPersistenceFails();
}

run().then(() => console.log('PASS bulk selection')).catch(error => { console.error(`FAIL bulk selection: ${error.stack || error.message}`); process.exitCode = 1; });
