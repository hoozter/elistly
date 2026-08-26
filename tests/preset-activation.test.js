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

async function testPresetTypesAreEnabledDisabledWithoutDeletion() {
  await withPage(async page => {
    const result = await page.evaluate(() => {
      App.data = {
        settings: {}, categories: {}, entityTypes: {}, entities: {},
        workspaces: { default: { name: 'Default', categories: {}, entityTypes: {}, entities: {} } }, currentWorkspaceId: 'default'
      };
      App.saveData = () => {};
      App.renderSidebar = () => {};
      App.loadView = () => {};
      App.showNotification = () => {};
      App.applyPreset('library');
      const initialKeys = Object.keys(App.data.entityTypes).sort();
      const customized = App.data.entityTypes.book;
      customized.label = 'My books';
      App.setEntityTypeEnabled('book', false, { offerSamples: false });
      App.data.entities.saved = { id: 'saved', type: 'book', name: 'Kept' };
      const afterDisable = {
        sameObject: App.data.entityTypes.book === customized,
        enabled: App.data.entityTypes.book.enabled,
        entity: App.data.entities.saved.name,
        visible: App.getEnabledEntityTypes().map(type => type.id)
      };
      App.applyPreset('library');
      return {
        initialKeys,
        afterDisable,
        afterReenable: {
          label: App.data.entityTypes.book.label,
          enabled: App.data.entityTypes.book.enabled,
          entity: App.data.entities.saved.name,
          keys: Object.keys(App.data.entityTypes).sort()
        },
        samples: Object.keys(App.data.entities)
      };
    });
    assert.ok(result.initialKeys.includes('book'));
    assert.ok(result.initialKeys.includes('borrower'));
    assert.deepEqual(result.afterDisable, { sameObject: true, enabled: false, entity: 'Kept', visible: ['borrower'] });
    assert.equal(result.afterReenable.label, 'My books');
    assert.equal(result.afterReenable.enabled, true);
    assert.equal(result.afterReenable.entity, 'Kept');
    assert.deepEqual(result.afterReenable.keys, result.initialKeys);
    assert.deepEqual(result.samples, ['saved']);
  });
}

async function testActivationStateIsWorkspaceLocalAndMigratesExistingTypesEnabled() {
  await withPage(async page => {
    const result = await page.evaluate(() => {
      App.data = {
        settings: {},
        categories: { devices: { id: 'devices', label: 'Devices' } },
        entityTypes: { computer: { id: 'computer', label: 'Computer', categories: ['devices'], fields: [] } }, entities: {},
        workspaces: {
          one: { name: 'One', categories: { devices: { id: 'devices', label: 'Devices' } }, entityTypes: { computer: { id: 'computer', label: 'Computer', categories: ['devices'], fields: [] } }, entities: {} },
          two: { name: 'Two', categories: { devices: { id: 'devices', label: 'Devices' } }, entityTypes: { computer: { id: 'computer', label: 'Computer', categories: ['devices'], fields: [], enabled: false } }, entities: {} }
        }, currentWorkspaceId: 'one'
      };
      App.normalizeActivationState();
      const migrated = App.data.entityTypes.computer.enabled;
      App.saveData = function () {
        this.data.workspaces[this.data.currentWorkspaceId] = {
          name: this.data.workspaces[this.data.currentWorkspaceId].name,
          categories: { ...this.data.categories }, entityTypes: { ...this.data.entityTypes }, entities: { ...this.data.entities }
        };
      };
      App.renderSidebar = () => {};
      App.loadView = () => {};
      App.showNotification = () => {};
      App.setEntityTypeEnabled('computer', false, { offerSamples: false });
      App.switchWorkspace('two');
      const second = App.data.entityTypes.computer.enabled;
      App.switchWorkspace('one');
      return { migrated, second, firstAgain: App.data.entityTypes.computer.enabled };
    });
    assert.deepEqual(result, { migrated: true, second: false, firstAgain: false });
  });
}

async function testSampleLoadingIsExplicitScopedAndIdempotent() {
  await withPage(async page => {
    const result = await page.evaluate(() => {
      App.data = {
        settings: {}, categories: {}, entityTypes: {}, entities: {},
        workspaces: { default: { name: 'Default', categories: {}, entityTypes: {}, entities: {} } }, currentWorkspaceId: 'default'
      };
      App.saveData = () => {};
      App.renderSidebar = () => {};
      App.loadView = () => {};
      App.showNotification = () => {};
      App.applyPreset('library');
      const before = Object.keys(App.data.entities).length;
      App.loadSampleData('library', ['book']);
      const first = Object.values(App.data.entities).filter(entity => entity.type === 'book').length;
      App.loadSampleData('library', ['book']);
      const second = Object.values(App.data.entities).filter(entity => entity.type === 'book').length;
      const borrowerCount = Object.values(App.data.entities).filter(entity => entity.type === 'borrower').length;
      return { before, first, second, borrowerCount };
    });
    assert.equal(result.before, 0);
    assert.ok(result.first > 0);
    assert.equal(result.second, result.first);
    assert.equal(result.borrowerCount, 0);
  });
}

async function testCustomPresetIdCollisionStaysCustom() {
  await withPage(async page => {
    const result = await page.evaluate(() => {
      App.data = {
        settings: {},
        categories: { library: { id: 'library', label: 'My custom category' } },
        entityTypes: { book: { id: 'book', label: 'My custom type', categories: ['library'], fields: [] } },
        entities: {}, workspaces: {}, currentWorkspaceId: 'default'
      };
      App.normalizeActivationState();
      return {
        categoryPresetIds: App.data.categories.library.presetIds,
        typePresetIds: App.data.entityTypes.book.presetIds,
        categoryEnabled: App.data.categories.library.enabled,
        typeEnabled: App.data.entityTypes.book.enabled,
        missingPresetTypeOwned: App.data.entityTypes.borrower.presetIds
      };
    });
    assert.deepEqual(result, {
      categoryPresetIds: undefined,
      typePresetIds: undefined,
      categoryEnabled: true,
      typeEnabled: true,
      missingPresetTypeOwned: ['library']
    });
  });
}

async function testBuiltInCategoryDisableIsNonDestructiveAndHidden() {
  await withPage(async page => {
    const result = await page.evaluate(() => {
      App.data = {
        settings: {}, categories: {}, entityTypes: {}, entities: {}, workspaces: {}, currentWorkspaceId: 'default'
      };
      App.saveData = () => {};
      App.renderSidebar = () => {};
      App.loadView = () => {};
      App.showNotification = () => {};
      App.applyPreset('library');
      const categoryId = Object.keys(App.data.categories).find(id => App.data.categories[id].presetIds?.includes('library'));
      const typeId = Object.keys(App.data.entityTypes).find(id => App.data.entityTypes[id].presetIds?.includes('library'));
      App.data.entities.saved = { id: 'saved', type: typeId, name: 'Kept' };
      App.confirmDeleteCategory(categoryId);
      return {
        categoryStillExists: !!App.data.categories[categoryId],
        categoryEnabled: App.data.categories[categoryId].enabled,
        entityStillExists: !!App.data.entities.saved,
        categoryVisible: App.getEnabledCategories().some(category => category.id === categoryId)
      };
    });
    assert.deepEqual(result, {
      categoryStillExists: true,
      categoryEnabled: false,
      entityStillExists: true,
      categoryVisible: false
    });
  });
}

async function testDisabledTypesDoNotLeakIntoNavigationOrFilters() {
  await withPage(async page => {
    const result = await page.evaluate(() => {
      App.data = {
        settings: {},
        categories: { tasks: { id: 'tasks', label: 'Tasks', enabled: true, presetIds: ['staff'] } },
        entityTypes: {
          task: { id: 'task', label: 'Task', categories: ['tasks'], enabled: false, presetIds: ['staff'], fields: [{ name: 'dueDate', type: 'date' }] }
        },
        entities: {}, workspaces: {}, currentWorkspaceId: 'default'
      };
      App.saveData = () => {};
      App.renderSidebar = () => {};
      App.loadView = () => {};
      App.showNotification = () => {};
      const before = {
        due: App.hasDueDateTypes(),
        filters: App.renderAdvancedFilterControls('tasks')
      };
      App.setEntityTypeEnabled('task', true, { offerSamples: false });
      App.setEntityTypeEnabled('task', false, { offerSamples: false });
      return {
        before,
        afterCategories: App.getEnabledCategories().map(category => category.id)
      };
    });
    assert.equal(result.before.due, false);
    assert.doesNotMatch(result.before.filters, /value="task"/);
    assert.deepEqual(result.afterCategories, []);
  });
}

async function testDisabledCategoriesHideTheirTypesAndAssociationEntities() {
  await withPage(async page => {
    const result = await page.evaluate(() => {
      App.data = {
        settings: { dashboard: { viewMode: 'gallery', groupByCategory: false } },
        categories: {
          hidden: { id: 'hidden', label: 'Hidden', enabled: false, presetIds: ['staff'] },
          visible: { id: 'visible', label: 'Visible', enabled: true }
        },
        entityTypes: {
          hiddenTask: { id: 'hiddenTask', label: 'Hidden task', categories: ['hidden'], enabled: true, fields: [{ name: 'dueDate', type: 'date' }] },
          shared: { id: 'shared', label: 'Shared', categories: ['hidden', 'visible'], enabled: true, fields: [] },
          uncategorized: { id: 'uncategorized', label: 'Uncategorized', categories: [], enabled: true, fields: [] },
          owner: {
            id: 'owner', label: 'Owner', categories: ['visible'], enabled: true, fields: [],
            associations: [{ name: 'task', label: 'Task', association: { targetType: 'hiddenTask' } }]
          }
        },
        entities: {
          hiddenEntity: { id: 'hiddenEntity', type: 'hiddenTask', name: 'Secret task', dueDate: '2000-01-01' },
          sharedEntity: { id: 'sharedEntity', type: 'shared', name: 'Shared item' }
        },
        workspaces: {}, currentWorkspaceId: 'default'
      };
      App.saveData = () => {};
      App.renderSidebar = () => {};
      let notification = '';
      App.showNotification = message => { notification = message; };

      App.renderDashboard();
      const dashboard = document.getElementById('mainContent').textContent;
      App.handleSearch('secret');
      const search = document.getElementById('mainContent').textContent;
      App.showEntityForm('hiddenTask');
      const association = App.createEntityAssociationField(App.data.entityTypes.owner.associations[0], '').querySelector('select');

      document.body.insertAdjacentHTML('beforeend', '<select data-filter-type><option value="owner" selected>Owner</option></select><select data-sort-field></select><div data-filter-controls></div>');
      App.updateAdvancedFilterControls();
      const advancedAssociationValues = [...document.querySelector('[data-filter-name="task"]').options].map(option => option.value);

      return {
        enabledTypes: App.getEnabledEntityTypes().map(type => type.id).sort(),
        dashboard,
        search,
        overdue: App.getOverdueEntities().map(entity => entity.id),
        dueSoon: App.getDueSoonEntities().map(entity => entity.id),
        notification,
        associationValues: [...association.options].map(option => option.value),
        advancedAssociationValues
      };
    });
    assert.deepEqual(result.enabledTypes, ['owner', 'shared', 'uncategorized']);
    assert.doesNotMatch(result.dashboard, /Secret task/);
    assert.match(result.dashboard, /Shared item/);
    assert.doesNotMatch(result.search, /Secret task/);
    assert.deepEqual(result.overdue, []);
    assert.deepEqual(result.dueSoon, []);
    assert.match(result.notification, /disabled/i);
    assert.deepEqual(result.associationValues, ['']);
    assert.deepEqual(result.advancedAssociationValues, ['', '__missing__']);
  });
}

Promise.resolve()
  .then(testPresetTypesAreEnabledDisabledWithoutDeletion)
  .then(testActivationStateIsWorkspaceLocalAndMigratesExistingTypesEnabled)
  .then(testSampleLoadingIsExplicitScopedAndIdempotent)
  .then(testCustomPresetIdCollisionStaysCustom)
  .then(testBuiltInCategoryDisableIsNonDestructiveAndHidden)
  .then(testDisabledTypesDoNotLeakIntoNavigationOrFilters)
  .then(testDisabledCategoriesHideTheirTypesAndAssociationEntities)
  .then(() => console.log('PASS preset activation'))
  .catch(error => { console.error(error); process.exitCode = 1; });
