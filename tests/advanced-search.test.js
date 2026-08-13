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
    const url = new URL(request.url, 'http://127.0.0.1');
    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'app.html';
    if (relativePath === 'config.js') return response.writeHead(404).end('Not found');
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

async function testConfiguredFieldFiltersUseTypedExactAndContainmentMatching() {
  await withPage(async page => {
    const result = await page.evaluate(() => {
      App.data = {
        categories: { devices: { id: 'devices', label: 'Devices', icon: 'devices' } },
        entityTypes: {
          computer: { id: 'computer', label: 'Computer', categories: ['devices'], fields: [
            { name: 'notes', label: 'Notes', type: 'textarea' },
            { name: 'quantity', label: 'Quantity', type: 'number' },
            { name: 'purchased', label: 'Purchased', type: 'date' },
            { name: 'status', label: 'Status', type: 'dropdown', options: [{ value: 'active', label: 'Active' }, { value: 'retired', label: 'Retired' }] },
            { name: 'managed', label: 'Managed', type: 'checkbox' },
            { name: 'tags', label: 'Tags', type: 'text' }
          ] }
        },
        entities: {
          alpha: { id: 'alpha', type: 'computer', name: 'Alpha laptop', notes: 'Primary developer machine', quantity: 0, purchased: '2024-01-15', status: 'active', managed: false, tags: ['office', 'priority'] },
          beta: { id: 'beta', type: 'computer', name: 'Beta laptop', notes: 'Shared machine', quantity: 2, purchased: '2025-02-03', status: 'retired', managed: true, tags: ['loaner'] }
        }, settings: {}
      };
      return {
        text: App.filterEntitiesForType('computer', { notes: { value: 'DEVELOPER' } }).map(entity => entity.id),
        number: App.filterEntitiesForType('computer', { quantity: { operator: 'equals', value: '0' } }).map(entity => entity.id),
        date: App.filterEntitiesForType('computer', { purchased: { operator: 'before', value: '2025-01-01' } }).map(entity => entity.id),
        dropdown: App.filterEntitiesForType('computer', { status: { value: 'active' } }).map(entity => entity.id),
        boolean: App.filterEntitiesForType('computer', { managed: { value: 'false' } }).map(entity => entity.id),
        array: App.filterEntitiesForType('computer', { tags: { value: 'priority' } }).map(entity => entity.id)
      };
    });
    assert.deepEqual(result, { text: ['alpha'], number: ['alpha'], date: ['alpha'], dropdown: ['alpha'], boolean: ['alpha'], array: ['alpha'] });
  });
}

async function testAssociationFiltersMatchStableIdsDespiteDuplicateLabels() {
  await withPage(async page => {
    const fixture = {
      entityTypes: {
        people: { id: 'people', label: 'People', fields: [] },
        computer: { id: 'computer', label: 'Computer', fields: [], associations: [{ name: 'owner', label: 'Owner', association: { targetType: 'people' } }] }
      },
      entities: {
        first: { id: 'first', type: 'people', name: 'Alex' },
        second: { id: 'second', type: 'people', name: 'Alex' },
        laptop: { id: 'laptop', type: 'computer', name: 'Laptop', owner: 'second' }
      }, categories: {}, settings: {}
    };
    const result = await page.evaluate(fixture => {
      App.data = fixture;
      return {
        byId: App.filterEntitiesForType('computer', { owner: { value: 'second' } }).map(entity => entity.id),
        missing: App.filterEntitiesForType('computer', { owner: { value: '__missing__' } }).map(entity => entity.id)
      };
    }, fixture);
    assert.deepEqual(result, { byId: ['laptop'], missing: [] });
  });
}

async function testSortByCompatibleFieldUsesTypedOrderingAndKeepsMissingValuesLast() {
  await withPage(async page => {
    const result = await page.evaluate(() => {
      App.data = {
        categories: { devices: { id: 'devices', label: 'Devices', icon: 'devices' } },
        entityTypes: { computer: { id: 'computer', label: 'Computer', categories: ['devices'], fields: [
          { name: 'rank', label: 'Rank', type: 'number' },
          { name: 'installed', label: 'Installed', type: 'date' },
          { name: 'managed', label: 'Managed', type: 'checkbox' },
          { name: 'notes', label: 'Notes', type: 'textarea' }
        ] } },
        entities: {
          zeta: { id: 'zeta', type: 'computer', name: 'Device 10', rank: 2, installed: '2024-02-01', managed: true },
          alpha: { id: 'alpha', type: 'computer', name: 'Device 2', rank: 0, installed: '2024-01-01', managed: false },
          beta: { id: 'beta', type: 'computer', name: 'Device 2', rank: 2, installed: 'invalid', managed: false },
          missing: { id: 'missing', type: 'computer', name: 'Device 1' }
        }, settings: {}
      };
      const entities = Object.values(App.data.entities);
      return {
        descriptors: App.getSortDescriptors('computer').map(field => field.name),
        names: App.sortEntities(entities, 'computer', { field: 'name', direction: 'asc' }).map(entity => entity.id),
        ranksAscending: App.sortEntities(entities, 'computer', { field: 'rank', direction: 'asc' }).map(entity => entity.id),
        ranksDescending: App.sortEntities(entities, 'computer', { field: 'rank', direction: 'desc' }).map(entity => entity.id),
        booleans: App.sortEntities(entities, 'computer', { field: 'managed', direction: 'asc' }).map(entity => entity.id),
        dates: App.sortEntities(entities, 'computer', { field: 'installed', direction: 'desc' }).map(entity => entity.id)
      };
    });
    assert.deepEqual(result, {
      descriptors: ['name', 'rank', 'installed', 'managed'],
      names: ['missing', 'alpha', 'beta', 'zeta'],
      ranksAscending: ['alpha', 'beta', 'zeta', 'missing'],
      ranksDescending: ['beta', 'zeta', 'alpha', 'missing'],
      booleans: ['alpha', 'beta', 'zeta', 'missing'],
      dates: ['zeta', 'alpha', 'beta', 'missing']
    });
  });
}

async function testCategorySortControlsComposeWithFiltersSearchAndStayReadOnly() {
  await withPage(async page => {
    const result = await page.evaluate(() => {
      App.data = {
        categories: { devices: { id: 'devices', label: 'Devices', icon: 'devices' } },
        entityTypes: { computer: { id: 'computer', label: 'Computer', categories: ['devices'], fields: [
          { name: 'rank', label: 'Rank', type: 'number' },
          { name: 'notes', label: '<img src=x onerror=alert(1)>', type: 'textarea' }
        ] } },
        entities: {
          alpha: { id: 'alpha', type: 'computer', name: 'Alpha laptop', rank: 2 },
          beta: { id: 'beta', type: 'computer', name: 'Beta laptop', rank: 1 }
        }, settings: {}
      };
      window.__saveCalls = 0;
      App.saveData = () => { window.__saveCalls += 1; };
      App.renderCategoryView('devices');
      return {
        sortControls: Boolean(document.querySelector('[data-sort-field]')) && Boolean(document.querySelector('[data-sort-direction]')),
        options: [...document.querySelectorAll('[data-sort-field] option')].map(option => option.textContent),
        saves: window.__saveCalls
      };
    });
    assert.deepEqual(result, { sortControls: true, options: ['Generated name'], saves: 0 });
    await page.locator('[data-filter-type]').selectOption('computer');
    await page.locator('[data-sort-field]').selectOption('rank');
    await page.locator('[data-sort-direction]').selectOption('desc');
    await page.evaluate(() => { document.getElementById('searchInput').value = 'laptop'; App.updateAdvancedFilterResults(); });
    const sorted = await page.evaluate(() => ({
      cards: [...document.querySelectorAll('.gallery-cards .mini-card')].map(card => card.textContent),
      saves: window.__saveCalls,
      hostileMarkup: document.querySelector('[data-sort-field]')?.innerHTML.includes('<img')
    }));
    assert.match(sorted.cards[0], /Alpha laptop/);
    assert.match(sorted.cards[1], /Beta laptop/);
    assert.equal(sorted.saves, 0);
    assert.equal(sorted.hostileMarkup, false);
    if (process.env.ELISTLY_SORT_SCREENSHOT) await page.screenshot({ path: process.env.ELISTLY_SORT_SCREENSHOT, fullPage: true });
  });
}

async function testCategoryAdvancedFiltersCombineWithHeaderSearchAndClearWithoutSaving() {
  await withPage(async page => {
    const result = await page.evaluate(() => {
      App.data = {
        categories: { devices: { id: 'devices', label: 'Devices', icon: 'devices' } },
        entityTypes: { computer: { id: 'computer', label: 'Computer', categories: ['devices'], fields: [{ name: 'status', label: 'Status', type: 'dropdown', options: [{ value: 'active', label: 'Active' }] }] } },
        entities: {
          alpha: { id: 'alpha', type: 'computer', name: 'Alpha laptop', status: 'active' },
          beta: { id: 'beta', type: 'computer', name: 'Beta laptop', status: 'active' }
        }, settings: {}
      };
      window.__saveCalls = 0;
      App.saveData = () => { window.__saveCalls += 1; };
      App.renderCategoryView('devices');
      return {
        controls: Boolean(document.querySelector('[data-advanced-filters]')),
        typePicker: Boolean(document.querySelector('[data-filter-type]')),
        initialCount: document.querySelector('[data-filter-result-count]')?.textContent
      };
    });
    assert.deepEqual(result, { controls: true, typePicker: true, initialCount: '2 items' });
    await page.locator('[data-filter-type]').selectOption('computer');
    await page.locator('[data-filter-name="status"]').selectOption('active');
    await page.evaluate(() => {
      document.getElementById('searchInput').value = 'alpha';
      App.updateAdvancedFilterResults();
    });
    const filtered = await page.evaluate(() => ({
      count: document.querySelector('[data-filter-result-count]')?.textContent,
      cards: [...document.querySelectorAll('.gallery-cards .mini-card')].map(card => card.textContent),
      saves: window.__saveCalls
    }));
    assert.equal(filtered.count, '1 item');
    assert.equal(filtered.cards.length, 1);
    assert.match(filtered.cards[0], /Alpha laptop/);
    assert.equal(filtered.saves, 0);
    if (process.env.ELISTLY_ADVANCED_SEARCH_SCREENSHOT) await page.screenshot({ path: process.env.ELISTLY_ADVANCED_SEARCH_SCREENSHOT, fullPage: true });
    await page.locator('[data-clear-advanced-filters]').click();
    const cleared = await page.evaluate(() => ({ count: document.querySelector('[data-filter-result-count]')?.textContent, field: document.querySelector('[data-filter-name="status"]')?.value, saves: window.__saveCalls }));
    assert.deepEqual(cleared, { count: '1 item', field: undefined, saves: 0 });
  });
}

Promise.resolve()
  .then(testConfiguredFieldFiltersUseTypedExactAndContainmentMatching)
  .then(testAssociationFiltersMatchStableIdsDespiteDuplicateLabels)
  .then(testSortByCompatibleFieldUsesTypedOrderingAndKeepsMissingValuesLast)
  .then(testCategorySortControlsComposeWithFiltersSearchAndStayReadOnly)
  .then(testCategoryAdvancedFiltersCombineWithHeaderSearchAndClearWithoutSaving)
  .then(() => console.log('PASS advanced search'))
  .catch(error => { console.error(error); process.exitCode = 1; });
