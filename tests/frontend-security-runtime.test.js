#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('/home/campbell/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const marker = 'ELISTLY_FRONTEND_SECURITY_MARKER_20260808';

function startStaticServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'app.html';
    const filePath = path.resolve(root, relativePath);
    if (!filePath.startsWith(`${root}${path.sep}`) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'");
    response.end(fs.readFileSync(filePath));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function withPage(run) {
  const server = await startStaticServer();
  const port = server.address().port;
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox']
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/app.html`, { waitUntil: 'domcontentloaded' });
    await run(page);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

async function importFixtureThroughFileInput(page, fixture, rawJson = null, initialData = undefined, waitForApply = true) {
  await page.evaluate(initialData => {
    window.__elistlyPreviewHandlerHits = 0;
    if (initialData !== null) App.data = initialData || {
      version: 'test', settings: {}, categories: {}, entityTypes: {}, entities: {},
      workspaces: { default: { name: 'Default', categories: {}, entityTypes: {}, entities: {} } },
      currentWorkspaceId: 'default'
    };
    document.querySelectorAll('#importModal').forEach(modal => modal.remove());
    App.showImportModal();
  }, initialData);
  await page.locator('#importFileInput').setInputFiles({
    name: 'hostile-import.json',
    mimeType: 'application/json',
    buffer: Buffer.from(rawJson === null ? JSON.stringify(fixture) : rawJson, 'utf8')
  });
  if (waitForApply) await page.locator('#processImportBtn:not([disabled])').waitFor();
}

async function testImportPreviewIsInert() {
  await withPage(async page => {
    const requests = [];
    page.on('request', request => requests.push(request.url()));
    const hostileMarkup = `<img src="/missing-${marker}" onerror="window.__elistlyPreviewHandlerHits++"><svg onload="window.__elistlyPreviewHandlerHits++"></svg><script>window.__elistlyPreviewHandlerHits++</script><span title="${marker}\">attribute breakout</span>&lt;svg onload=window.__elistlyPreviewHandlerHits++&gt;`;
    const hostileIdentity = `type');window.__importPostApplyXss++;void('`;
    const hostileIcon = `<img src="/missing-${marker}-ordinary-click" onerror="window.__importPostApplyXss++">`;
    const benignType = `type-${marker}`;
    const benignId = `entity-${marker}`;
    const fixture = {
      entityTypes: {
        [hostileIdentity]: {
          label: hostileMarkup,
          icon: hostileIcon,
          fields: [{ name: `field\"><img src=x onerror=window.__importPostApplyXss++>`, label: hostileMarkup, type: 'textarea' }],
          categories: []
        },
        [benignType]: { label: hostileMarkup, fields: [], categories: [] }
      },
      categories: { [`category-${marker}`]: { label: hostileMarkup } },
      entities: {
        [hostileIdentity]: {
          id: hostileIdentity,
          type: hostileIdentity,
          name: `Hostile ${marker} ${hostileMarkup}`,
          [`field\"><img src=x onerror=window.__importPostApplyXss++>`]: hostileMarkup
        },
        [benignId]: { id: benignId, type: benignType, name: `Benign ${marker}`, nested: { label: hostileMarkup } }
      }
    };
    await importFixtureThroughFileInput(page, fixture);
    const preview = await page.locator('#importPreviewArea').evaluate(area => ({
      text: area.textContent,
      activeNodes: area.querySelectorAll('img, svg, script').length,
      checkboxValues: [...area.querySelectorAll('input[type="checkbox"]')].map(input => input.value),
      handlerHits: window.__elistlyPreviewHandlerHits
    }));
    assert.equal(preview.activeNodes, 0, `attacker markup created active nodes: ${preview.activeNodes}`);
    assert.equal(preview.handlerHits, 0, `attacker handler executed ${preview.handlerHits} time(s)`);
    assert.match(preview.text, new RegExp(marker));
    assert.deepEqual(preview.checkboxValues.sort(), [`category-${marker}`, hostileIdentity, benignId, hostileIdentity, benignType].sort());
    await page.locator('#processImportBtn').click();
    const persisted = await page.evaluate(({ hostileIdentity, benignId }) => ({
      hostileEntity: App.data.entities[hostileIdentity],
      benignEntity: App.data.entities[benignId],
      storage: localStorage.getItem('elistlyData')
    }), { hostileIdentity, benignId });
    assert.equal(persisted.hostileEntity.id, hostileIdentity, 'selected hostile identity should persist as data');
    assert.equal(persisted.hostileEntity.type, hostileIdentity, 'selected hostile identity should persist as data');
    assert.equal(persisted.benignEntity.name, `Benign ${marker}`, 'selected benign fixture should persist as data');
    assert.match(persisted.storage, new RegExp(marker));
    await page.reload({ waitUntil: 'domcontentloaded' });
    const hostileResult = await page.evaluate(({ hostileIdentity, marker }) => {
      App.data = JSON.parse(localStorage.getItem('elistlyData'));
      window.__importPostApplyXss = 0;
      window.__elistlyPreviewHandlerHits = 0;
      App.handleSearch(`Hostile ${marker}`);
      const result = document.querySelector('.search-results');
      const button = result.querySelector('.entity-actions button');
      const activeNodes = result.querySelectorAll('img, svg, script').length;
      const inlineHandlers = [...result.querySelectorAll('*')].filter(node => [...node.attributes].some(attribute => /^on/i.test(attribute.name))).length;
      button.click();
      const modal = document.querySelector('#entityModal');
      const modalActiveNodes = modal.querySelectorAll('img, svg, script').length;
      const modalInlineHandlers = [...modal.querySelectorAll('*')].filter(node => [...node.attributes].some(attribute => /^on/i.test(attribute.name))).length;
      modal.querySelector('#entityViewActions button').click();
      return { hits: window.__importPostApplyXss, activeNodes, inlineHandlers, modalActiveNodes, modalInlineHandlers, previewHandlerHits: window.__elistlyPreviewHandlerHits };
    }, { hostileIdentity, marker });
    assert.equal(hostileResult.hits, 0, `persisted identity payload executed ${hostileResult.hits} time(s) after an ordinary click`);
    assert.equal(hostileResult.activeNodes, 0, `persisted hostile data created active nodes: ${hostileResult.activeNodes}`);
    assert.equal(hostileResult.inlineHandlers, 0, `persisted hostile data created inline handlers: ${hostileResult.inlineHandlers}`);
    assert.equal(hostileResult.modalActiveNodes, 0, `persisted hostile data created active modal nodes: ${hostileResult.modalActiveNodes}`);
    assert.equal(hostileResult.modalInlineHandlers, 0, `persisted hostile data created modal inline handlers: ${hostileResult.modalInlineHandlers}`);

    assert.equal(hostileResult.previewHandlerHits, 0, `persisted hostile markup executed ${hostileResult.previewHandlerHits} time(s)`);
    assert.ok(!requests.some(url => url.includes(marker)), `import marker reached a browser request: ${requests.join(', ')}`);
    const benignArgs = await page.evaluate(({ benignId, benignType, marker }) => {
      App.data = JSON.parse(localStorage.getItem('elistlyData'));
      document.querySelector('#entityModal').remove();
      App.handleSearch(`Benign ${marker}`);
      document.querySelector('.search-results .entity-actions button').click();
      const form = document.querySelector('#entityForm');
      return [form.dataset.typeId, form.dataset.entityId];
    }, { benignId, benignType, marker });
    assert.deepEqual(benignArgs, [benignType, benignId], 'benign entity click should retain its exact navigation identity');
    const actionLifecycle = await page.evaluate(async ({ benignId, marker }) => {
      App.handleSearch(`Benign ${marker}`);
      const staleButton = document.querySelector('.search-results .entity-actions button');
      for (let i = 0; i < 50; i += 1) App.handleSearch(`Benign ${marker}`);
      await new Promise(resolve => setTimeout(resolve, 0));
      const registeredActions = App._clickActions.size;
      window.__staleDetachedCallbackCalls = 0;
      const originalShowEntityForm = App.showEntityForm;
      App.showEntityForm = () => { window.__staleDetachedCallbackCalls += 1; };
      document.body.appendChild(staleButton);
      staleButton.click();
      staleButton.remove();
      App.showEntityForm = originalShowEntityForm;
      return { registeredActions, staleDetachedCallbackCalls: window.__staleDetachedCallbackCalls };
    }, { benignId, marker });
    assert.ok(actionLifecycle.registeredActions <= 1, `normal rerenders retained ${actionLifecycle.registeredActions} stale actions`);
    assert.equal(actionLifecycle.staleDetachedCallbackCalls, 0, `detached stale action invoked ${actionLifecycle.staleDetachedCallbackCalls} callback(s)`);
    console.log(`OBSERVED import preview=0 persisted=${persisted.hostileEntity.id === hostileIdentity} reload-click-hits=${hostileResult.hits} active-nodes=${hostileResult.activeNodes} inline-handlers=${hostileResult.inlineHandlers} modal-active-nodes=${hostileResult.modalActiveNodes} modal-inline-handlers=${hostileResult.modalInlineHandlers} marker-requests=${requests.filter(url => url.includes(marker)).length} benign-args=${JSON.stringify(benignArgs)} registered-actions=${actionLifecycle.registeredActions} stale-detached-callbacks=${actionLifecycle.staleDetachedCallbackCalls}`);
  });
}

async function testQrRenderingIsLocalOnly() {
  await withPage(async page => {
    const requests = [];
    page.on('request', request => requests.push(request.url()));
    await page.addScriptTag({ path: '/home/campbell/node_modules/jsqr/dist/jsQR.js' });
    const payloads = [
      marker,
      'https://elistly.example/qr?value=alpha%20beta',
      'räksmörgås 東京 🔒',
      'x'.repeat(500)
    ];
    const result = await page.evaluate(async payloads => {
      App.data = {
        entityTypes: {
          test: { icon: 'folder', fields: [{ name: 'qrValue', label: 'QR', type: 'qr', visibleInCard: true }] }
        },
        entities: {}, categories: {}, settings: {}
      };
      const rendered = [];
      for (const payload of payloads) {
        const entity = { id: 'entity', type: 'test', name: 'Test entity', qrValue: payload };
        const host = document.createElement('div');
        host.innerHTML = App.renderEntityMiniCard(entity) + App.renderFieldInput({ name: 'qrValue', label: 'QR', type: 'qr' }, payload);
        document.body.appendChild(host);
        const images = [...host.querySelectorAll('img')];
        const decoded = await Promise.all(images.map(async image => {
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          canvas.getContext('2d').drawImage(image, 0, 0);
          return jsQR(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data || null;
        }));
        rendered.push({ payload, imageSources: images.map(image => image.src), html: host.innerHTML, decoded });
      }
      const oversized = 'y'.repeat(1025);
      const oversizedHtml = App.renderFieldInput({ name: 'qrValue', label: 'QR', type: 'qr' }, oversized);
      return { rendered, oversizedHtml };
    }, payloads);
    await page.waitForTimeout(100);
    if (process.env.ELISTLY_SECURITY_SCREENSHOT) {
      await page.screenshot({ path: process.env.ELISTLY_SECURITY_SCREENSHOT, fullPage: true });
    }
    for (const rendered of result.rendered) {
      assert.equal(rendered.imageSources.length, 2, 'both mini-card and entity QR paths should render an image');
      assert.ok(rendered.imageSources.every(src => !/^https?:/i.test(src)), `QR image uses a network URL: ${rendered.imageSources.join(', ')}`);
      assert.ok(rendered.imageSources.every(src => src.startsWith('data:image/gif;base64,')), 'QR output must be a local image data URL');
      assert.deepEqual(rendered.decoded, [rendered.payload, rendered.payload], `independent jsQR decode did not round-trip ${rendered.payload}`);
    }
    assert.match(result.oversizedHtml, /QR value is too long to generate locally\./);
    assert.doesNotMatch(result.oversizedHtml, /<img\b/i);
    assert.ok(!requests.some(url => url.includes(marker)), `QR marker reached a browser request: ${requests.join(', ')}`);
  });
}

async function testCompleteImportedDataBoundary() {
  await withPage(async page => {
    const requests = [];
    page.on('request', request => requests.push(request.url()));
    const payload = `<img src="/missing-${marker}-boundary" onerror="window.__boundaryHits=(window.__boundaryHits||0)+1"><svg onload="window.__boundaryHits=(window.__boundaryHits||0)+1"></svg>`;
    const hostileId = `type'\");window.__boundaryHits=(window.__boundaryHits||0)+1;//`;
    const hostileField = `field\"><img src=x onerror=window.__boundaryHits=(window.__boundaryHits||0)+1>`;
    const fixture = {
      entityTypes: {
        [hostileId]: {
          id: hostileId, label: payload, icon: payload, categories: [`cat-${marker}`],
          fields: [{ name: hostileField, label: payload, type: 'dropdown', options: [{ value: payload, nameValue: `東京 ${payload}` }] }],
          associations: [{ name: `assoc-${hostileField}`, label: payload, association: { kind: 'belongs_to', targetType: hostileId } }]
        }
      },
      categories: { [`cat-${marker}`]: { id: `cat-${marker}`, label: payload, icon: payload } },
      entities: { [`entity-${marker}`]: { id: `entity-${marker}`, type: hostileId, name: payload, [hostileField]: payload } }
    };
    await importFixtureThroughFileInput(page, fixture);
    await page.locator('#processImportBtn').click();
    const persisted = await page.evaluate(({ hostileId, hostileField, payload }) => ({
      type: App.data.entityTypes[hostileId], entity: App.data.entities[`entity-${window.__marker}`], storage: localStorage.getItem('elistlyData')
    }), { hostileId, hostileField, payload });
    assert.equal(persisted.type.fields[0].name, hostileField, 'hostile field name must persist exactly before rendering');
    assert.equal(persisted.type.fields[0].options[0].value, payload, 'hostile option value must persist exactly before rendering');
    await page.reload({ waitUntil: 'domcontentloaded' });
    const observed = await page.evaluate(({ hostileId, marker }) => {
      App.data = JSON.parse(localStorage.getItem('elistlyData'));
      window.__boundaryHits = 0;
      App.showSettingsModal();
      [...document.querySelectorAll('#settingsModal button')].find(button => button.textContent.includes('Entity types')).click();
      const manager = document.querySelector('#entityTypeManagerModal');
      const inspect = root => ({
        activeNodes: root.querySelectorAll('img,svg,script').length,
        inlineHandlers: [...root.querySelectorAll('*')].filter(node => [...node.attributes].some(attribute => /^on/i.test(attribute.name))).length
      });
      const managerResult = inspect(manager);
      manager.querySelector('.btn-secondary').click();
      const editorResult = inspect(document.querySelector('#entityTypeFormModal'));
      return {
        manager: managerResult,
        editor: editorResult,
        hits: window.__boundaryHits
      };
    }, { hostileId, marker });
    assert.equal(observed.hits, 0, `type manager executed imported payload ${observed.hits} time(s)`);
    assert.equal(observed.manager.activeNodes, 0, `type manager created ${observed.manager.activeNodes} active imported node(s)`);
    assert.equal(observed.manager.inlineHandlers, 0, `type manager retained ${observed.manager.inlineHandlers} inline handler(s)`);
    assert.equal(observed.editor.activeNodes, 0, `type editor created ${observed.editor.activeNodes} active imported node(s)`);
    assert.equal(observed.editor.inlineHandlers, 0, `type editor retained ${observed.editor.inlineHandlers} inline handler(s)`);
    assert.ok(!requests.some(url => url.includes(marker)), `boundary marker reached a browser request: ${requests.join(', ')}`);
  });
}

async function testManagerAndExportBoundary() {
  await withPage(async page => {
    const requests = [];
    page.on('request', request => requests.push(request.url()));
    const payload = `<img src="/missing-${marker}-manager-export" onerror="window.__managerExportHits=(window.__managerExportHits||0)+1"><svg onload="window.__managerExportHits=(window.__managerExportHits||0)+1"></svg>`;
    const hostileId = `type'\");window.__managerExportHits=(window.__managerExportHits||0)+1;//`;
    const hostileCategoryId = `category'\");window.__managerExportHits=(window.__managerExportHits||0)+1;//`;
    const hostileField = `field\"><img src=x onerror=window.__managerExportHits=(window.__managerExportHits||0)+1>`;
    const fixture = {
      entityTypes: {
        [hostileId]: {
          id: hostileId, label: payload, icon: payload, categories: [hostileCategoryId],
          fields: [{ name: hostileField, label: payload, type: 'dropdown', options: [{ value: payload, nameValue: `東京 ${payload}` }] }],
          associations: []
        }
      },
      categories: { [hostileCategoryId]: { id: hostileCategoryId, label: payload, icon: payload } },
      entities: { [`entity-${marker}`]: { id: `entity-${marker}`, type: hostileId, name: payload, [hostileField]: payload } }
    };
    await importFixtureThroughFileInput(page, fixture);
    await page.locator('#processImportBtn').click();
    const persisted = await page.evaluate(({ hostileId, hostileCategoryId, hostileField, payload }) => ({
      type: App.data.entityTypes[hostileId], category: App.data.categories[hostileCategoryId], entity: App.data.entities[`entity-${window.__marker}`], storage: localStorage.getItem('elistlyData')
    }), { hostileId, hostileCategoryId, hostileField, payload });
    assert.equal(persisted.category.id, hostileCategoryId, 'hostile category ID must persist exactly before rendering');
    assert.equal(persisted.type.fields[0].options[0].nameValue, `東京 ${payload}`, 'hostile Unicode option must persist exactly before rendering');
    await page.reload({ waitUntil: 'domcontentloaded' });
    const observed = await page.evaluate(({ hostileId, hostileCategoryId, payload }) => {
      App.data = JSON.parse(localStorage.getItem('elistlyData'));
      window.__managerExportHits = 0;
      const inspect = root => ({
        activeNodes: root.querySelectorAll('img,svg,script').length,
        inlineHandlers: [...root.querySelectorAll('*')].filter(node => [...node.attributes].some(attribute => /^on/i.test(attribute.name))).length
      });
      App.showCategoryManager();
      const categoryManager = document.querySelector('#categoryManagerModal');
      const categoryManagerResult = inspect(categoryManager);
      categoryManager.querySelector('.btn-secondary').click();
      const categoryEditorResult = inspect(document.querySelector('#categoryFormModal'));
      document.querySelector('#categoryForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      const categorySaved = App.data.categories[hostileCategoryId]?.label;
      App.deleteCategory(hostileCategoryId);
      const categoryDeleteResult = inspect(document.querySelector('#confirmDeleteCategoryModal'));
      document.querySelector('#confirmDeleteCategoryModal').remove();
      App.deleteEntityType(hostileId);
      const typeDeleteResult = inspect(document.querySelector('#confirmDeleteTypeModal'));
      document.querySelector('#confirmDeleteTypeModal').remove();
      App.showExportModal();
      const exportModal = document.querySelector('#exportModal');
      const exportResult = inspect(exportModal);
      exportModal.querySelector('.expand-entity-type').click();
      const expandedResult = inspect(exportModal);
      return { categoryManagerResult, categoryEditorResult, categoryDeleteResult, typeDeleteResult, exportResult, expandedResult, categorySaved, hits: window.__managerExportHits };
    }, { hostileId, hostileCategoryId, payload });
    assert.equal(observed.categorySaved, payload, 'ordinary category edit/save must preserve the exact persisted label');
    for (const [surface, result] of Object.entries(observed).filter(([surface]) => !['hits', 'categorySaved'].includes(surface))) {
      assert.equal(result.activeNodes, 0, `${surface} created ${result.activeNodes} active imported node(s)`);
      assert.equal(result.inlineHandlers, 0, `${surface} retained ${result.inlineHandlers} inline handler(s)`);
    }
    assert.equal(observed.hits, 0, `manager/export ordinary navigation executed imported payload ${observed.hits} time(s)`);
    assert.ok(!requests.some(url => url.includes(marker)), `manager/export marker reached a browser request: ${requests.join(', ')}`);
  });
}

async function testEntityTypeEditorParity() {
  await withPage(async page => {
    const result = await page.evaluate(() => {
      const original = {
        id: 'device', label: 'Device', icon: 'memory', categories: ['hardware'], enableNameGen: false,
        nameGen: { prefix: '', prefixEnabled: false, suffixType: 'number', componentsOrder: [] },
        fields: [{ name: 'serial', label: 'Serial', type: 'text', required: true, visibleInCard: true, partOfName: false }],
        associations: [{ name: 'owner', label: 'Owner', type: 'association', required: false, visibleInCard: false, partOfName: false, association: { kind: 'belongs_to', targetType: 'person' } }]
      };
      App.data = {
        version: 'test', settings: {}, entities: {},
        categories: { hardware: { id: 'hardware', label: 'Hardware' } },
        entityTypes: {
          device: structuredClone(original),
          person: { id: 'person', label: 'Person', icon: 'person', categories: ['hardware'], fields: [], associations: [] }
        },
        workspaces: { default: { name: 'Default', categories: {}, entityTypes: {}, entities: {} } }, currentWorkspaceId: 'default'
      };
      App.editEntityType('device');
      const form = document.querySelector('#entityTypeForm');
      const byText = (selector, text) => [...form.querySelectorAll(selector)].find(element => element.textContent.includes(text));
      const click = (selector, text) => {
        const element = byText(selector, text);
        if (!element) throw new Error(`Missing ${text}`);
        element.click();
      };
      click('button', 'Add Field');
      const addedField = form.querySelectorAll('.field-card, .field-editor')[1];
      addedField.querySelector('input[name$=".label"]').value = 'Status';
      const type = addedField.querySelector('select[name$=".type"]');
      type.value = 'dropdown';
      type.dispatchEvent(new Event('change', { bubbles: true }));
      click('button', 'Add Option');
      const optionRowsBeforeRemove = addedField.querySelectorAll('.option-row').length;
      addedField.querySelector('.option-row .btn-danger').click();
      const optionRowsAfterRemove = addedField.querySelectorAll('.option-row').length;
      click('button', 'Add link');
      const associationsAfterAdd = form.querySelectorAll('.assoc-card, .association-editor').length;
      form.querySelectorAll('.assoc-card, .association-editor')[1].querySelector('.btn-danger').click();
      const associationsAfterRemove = form.querySelectorAll('.assoc-card, .association-editor').length;
      const nameGen = form.querySelector('input[name="enableNameGen"]');
      nameGen.checked = true;
      nameGen.dispatchEvent(new Event('change', { bubbles: true }));
      const prefixEnabled = form.querySelector('input[name="prefixEnabled"]');
      prefixEnabled.checked = true;
      prefixEnabled.dispatchEvent(new Event('change', { bubbles: true }));
      form.querySelector('input[name="namePrefix"]').value = 'Unit-';
      addedField.querySelector('input[name$=".partOfName"]').checked = true;
      addedField.querySelector('input[name$=".partOfName"]').dispatchEvent(new Event('change', { bubbles: true }));
      const preview = form.querySelector('#namePreview')?.textContent || '';
      form.querySelectorAll('.field-card, .field-editor')[0].querySelector('.btn-danger').click();
      const fieldsAfterRemove = form.querySelectorAll('.field-card, .field-editor').length;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      const saved = App.data.entityTypes.device;
      App.editEntityType('device');
      const cancelForm = document.querySelector('#entityTypeForm');
      cancelForm.querySelector('input[name="label"]').value = 'Discarded';
      [...document.querySelectorAll('#entityTypeFormModal button')].find(element => element.textContent.includes('Cancel')).click();
      return {
        optionRowsBeforeRemove, optionRowsAfterRemove, associationsAfterAdd, associationsAfterRemove,
        fieldsAfterRemove, preview, nameSectionVisible: !form.querySelector('.name-generation-settings')?.classList.contains('hidden'),
        prefixEnabled: !form.querySelector('input[name="namePrefix"]').disabled,
        saved, labelAfterCancel: App.data.entityTypes.device.label
      };
    });
    assert.equal(result.optionRowsBeforeRemove, 2, 'dropdown type switch must create an option and add must append another');
    assert.equal(result.optionRowsAfterRemove, 1, 'option removal must remove exactly one option');
    assert.equal(result.associationsAfterAdd, 2, 'link add must append an association editor');
    assert.equal(result.associationsAfterRemove, 1, 'link removal must remove exactly one association editor');
    assert.equal(result.fieldsAfterRemove, 1, 'field removal must remove exactly one field editor');
    assert.equal(result.nameSectionVisible, true, 'title generator interactions must reveal the editor');
    assert.equal(result.prefixEnabled, true, 'prefix interaction must enable the prefix input');
    assert.match(result.preview, /Unit-/, 'title generator interactions must update preview');
    assert.deepEqual(result.saved.fields.map(field => ({ label: field.label, type: field.type, options: field.options })), [{ label: 'Status', type: 'dropdown', options: [] }]);
    assert.equal(result.saved.associations.length, 1, 'save must retain the remaining association');
    assert.deepEqual(result.saved.nameGen, { prefixEnabled: true, prefix: 'Unit-', partOfNamePrefix: true, suffixType: 'number', componentsOrder: [{ type: 'field', name: 'status' }] }, 'save must retain title-generator interaction data shape');
    assert.equal(result.labelAfterCancel, 'Device', 'cancel must not persist editor changes');
  });
}

async function testImportedSettingsBoundary() {
  await withPage(async page => {
    const requests = [];
    page.on('request', request => requests.push(request.url()));
    await page.evaluate(() => { window.__settingsHits = 0; });
    const hostileMarkup = `<img src="/missing-${marker}-settings" onerror="window.__settingsHits=(window.__settingsHits||0)+1"><svg onload="window.__settingsHits=(window.__settingsHits||0)+1"></svg>`;
    await importFixtureThroughFileInput(page, {
      settings: {
        fontSize: hostileMarkup,
        materialIcons: ['memory', hostileMarkup],
        defaultView: hostileMarkup,
        dashboard: { viewMode: 'gallery', groupByCategory: false, itemsPerCategory: 12, categoryOrder: ['safe-category', hostileMarkup] },
        notifications: { duration: hostileMarkup },
        unknownText: 'räksmörgås 東京',
        unknownNumber: 17,
        unknownBoolean: true,
        unsupportedBranch: { payload: hostileMarkup }
      },
      categories: { 'safe-category': { id: 'safe-category', label: 'Safe category' } }
    });
    await page.locator('#processImportBtn').click();
    await page.reload({ waitUntil: 'domcontentloaded' });
    const observed = await page.evaluate(() => {
      // The local fixture intentionally has no backend configuration, so app init
      // stops at its setup-required screen. Rehydrate the exact persisted payload
      // and invoke the same ordinary startup renderer directly.
      App.data = JSON.parse(localStorage.getItem('elistlyData'));
      App.buildIconGrid();
      App.showSettingsModal();
      const modal = document.querySelector('#settingsModal');
      const textSize = modal.querySelector('.text-size-label')?.textContent;
      const dashboardMode = modal.querySelector('[name="dashboardViewMode"]')?.value;
      const items = modal.querySelector('[name="dashboardItemsPerCategoryNumber"]')?.value;
      return {
        hits: window.__settingsHits || 0,
        activeNodes: document.querySelectorAll('img[src*="ELISTLY_FRONTEND_SECURITY_MARKER_20260808"], svg[onload*="__settingsHits"]').length,
        inlineHandlers: [...document.querySelectorAll('*')].filter(node => [...node.attributes].some(attribute => /^on/i.test(attribute.name) && attribute.value.includes('ELISTLY_FRONTEND_SECURITY_MARKER_20260808'))).length,
        textSize, dashboardMode, items, persisted: App.data.settings,
        iconTexts: [...document.querySelectorAll('#iconGrid .icon-label')].map(node => node.textContent)
      };
    });
    assert.equal(observed.hits, 0, `persisted settings payload executed ${observed.hits} time(s)`);
    assert.equal(observed.activeNodes, 0, `persisted settings created ${observed.activeNodes} active node(s)`);
    assert.equal(observed.inlineHandlers, 0, `persisted settings created ${observed.inlineHandlers} inline handler(s)`);
    assert.equal(observed.textSize, 'Normal', 'invalid font size must default at the settings semantic boundary');
    assert.equal(observed.dashboardMode, 'gallery', 'valid imported dashboard setting must render');
    assert.equal(observed.items, '12', 'valid imported numeric setting must render');
    assert.equal(observed.persisted.defaultView, 'dashboard', 'unsupported default view must fall back to dashboard');
    assert.deepEqual(observed.iconTexts, ['memory'], 'invalid material icon entries must be rejected before ordinary startup rendering');
    assert.deepEqual(observed.persisted.dashboard.categoryOrder, ['safe-category'], 'invalid dashboard nested entries must be rejected');
    assert.deepEqual(observed.persisted.notifications, {}, 'invalid notification settings must be rejected');
    assert.equal('unknownText' in observed.persisted, false, 'unknown Unicode string settings must not persist');
    assert.equal('unknownNumber' in observed.persisted, false, 'unknown numeric settings must not persist');
    assert.equal('unknownBoolean' in observed.persisted, false, 'unknown boolean settings must not persist');
    assert.equal('unsupportedBranch' in observed.persisted, false, 'unsupported object settings must not persist');
    const validDefaultView = await page.evaluate(() => App.normalizeSettings({ defaultView: 'dashboard' }, {}).defaultView);
    assert.equal(validDefaultView, 'dashboard', 'supported default view must survive normalization');
    assert.ok(!requests.some(url => url.includes(marker)), `settings marker reached a browser request: ${requests.join(', ')}`);
  });
}

async function testCustomTitleSeparatorParity() {
  await withPage(async page => {
    await importFixtureThroughFileInput(page, {
      entityTypes: {
        device: {
          id: 'device', label: 'Device', icon: 'memory', categories: ['hardware'], enableNameGen: true,
          nameGen: { prefix: '', prefixEnabled: false, suffixType: 'number', componentsOrder: [] },
          fields: [
            { name: 'serial', label: 'Serial', type: 'text', visibleInCard: true, partOfName: true },
            { name: 'model', label: 'Model', type: 'text', visibleInCard: true, partOfName: true }
          ], associations: []
        }
      },
      categories: { hardware: { id: 'hardware', label: 'Hardware' } }
    });
    await page.locator('#processImportBtn').click();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      App.data = JSON.parse(localStorage.getItem('elistlyData'));
      App.showSettingsModal();
    });
    await page.locator('#settingsModal button', { hasText: 'Entity types' }).click();
    await page.locator('#entityTypeManagerModal button[title="Edit"]').click();
    const customInput = page.locator('#customSeparatorInput');
    await customInput.fill(' / ');
    await page.locator('#entityTypeForm button', { hasText: 'Insert' }).click();
    const inserted = await page.locator('.name-separator-item').evaluateAll(rows => rows.map(row => decodeURIComponent(row.dataset.separatorValue)));
    const inputWasCleared = await customInput.inputValue() === '';
    await page.locator('#entityTypeFormModal .modal-actions button[type="submit"]', { hasText: 'Save Changes' }).click();
    const savedWithCustom = await page.evaluate(() => structuredClone(App.data.entityTypes.device.nameGen.componentsOrder));
    await page.reload({ waitUntil: 'domcontentloaded' });
    const persisted = await page.evaluate(() => {
      App.data = JSON.parse(localStorage.getItem('elistlyData'));
      return App.data.entityTypes.device.nameGen.componentsOrder;
    });
    await page.evaluate(() => App.showSettingsModal());
    await page.locator('#settingsModal button', { hasText: 'Entity types' }).click();
    await page.locator('#entityTypeManagerModal button[title="Edit"]').click();
    await page.locator('.name-separator-item .btn-secondary', { hasText: 'Remove' }).click();
    await page.locator('#entityTypeFormModal .modal-actions button[type="submit"]', { hasText: 'Save Changes' }).click();
    const savedAfterRemove = await page.evaluate(() => structuredClone(App.data.entityTypes.device.nameGen.componentsOrder));
    await page.evaluate(() => App.editEntityType('device'));
    await page.locator('#entityTypeFormModal').last().locator('input[name="label"]').fill('Discarded');
    await page.locator('#entityTypeFormModal').last().locator('button', { hasText: 'Cancel' }).click();
    const labelAfterCancel = await page.evaluate(() => App.data.entityTypes.device.label);
    const result = { inserted, inputWasCleared, savedWithCustom, savedAfterRemove, labelAfterCancel };
    assert.deepEqual(result.inserted, [' / '], 'custom Insert must add the entered separator');
    assert.equal(result.inputWasCleared, true, 'custom separator input must clear after insertion');
    assert.deepEqual(result.savedWithCustom, [
      { type: 'field', name: 'serial' }, { type: 'separator', value: ' / ' }, { type: 'field', name: 'model' }
    ], 'save must persist the exact custom separator');
    assert.deepEqual(result.savedAfterRemove, [
      { type: 'field', name: 'serial' }, { type: 'field', name: 'model' }
    ], 'remove must remove the exact custom separator');
    assert.equal(result.labelAfterCancel, 'Device', 'cancel must not persist editor changes');
    assert.deepEqual(persisted, result.savedWithCustom, 'visible Save Changes must persist the exact inserted separator through reload');
  });
}

async function testImportCollisionChoices() {
  await withPage(async page => {
    const original = {
      version: 'test', settings: {}, categories: {},
      entityTypes: { device: { id: 'device', label: 'Original device', fields: [], categories: [] } },
      entities: {}, workspaces: { default: { name: 'Default', categories: {}, entityTypes: {}, entities: {} } },
      currentWorkspaceId: 'default'
    };
    const rawJson = '{"entityTypes":{"device":{"id":"device","label":"Earlier","fields":[],"categories":[]},"device":{"id":"device","label":"Later","fields":[],"categories":[]}},"categories":{"new-category":{"id":"new-category","label":"New"}}}';
    await importFixtureThroughFileInput(page, {}, rawJson, original, false);
    await page.locator('#importPreviewArea').getByText('Duplicate JSON members').waitFor();
    assert.equal(await page.locator('#processImportBtn').isDisabled(), true, 'Apply must stay disabled while collision choices are unresolved');
    const conflicts = await page.locator('[data-import-conflict]').count();
    assert.equal(conflicts, 2, 'duplicate member and existing ID must each be previewed');
    await page.locator('[data-import-conflict]').nth(0).getByRole('radio', { name: 'Overwrite' }).check();
    await page.locator('[data-import-conflict]').nth(1).getByRole('radio', { name: 'Skip' }).check();
    await page.locator('#processImportBtn:not([disabled])').waitFor();
    await page.evaluate(() => { App.data.entityTypes.device.label = 'Changed while reviewing'; });
    await page.locator('#processImportBtn').click();
    assert.equal(await page.locator('#processImportBtn').isDisabled(), true, 'changed current data must invalidate earlier collision choices');
    await page.locator('[data-import-conflict]').nth(0).getByRole('radio', { name: 'Overwrite' }).check();
    await page.locator('[data-import-conflict]').nth(1).getByRole('radio', { name: 'Skip' }).check();
    await page.locator('#processImportBtn:not([disabled])').waitFor();
    await page.locator('#processImportBtn').click();
    const skipped = await page.evaluate(() => ({ device: App.data.entityTypes.device.label, category: App.data.categories['new-category']?.label, notification: document.body.textContent }));
    assert.equal(skipped.device, 'Changed while reviewing', 'existing-ID Skip must preserve changed current data after renewed review');
    assert.equal(skipped.category, 'New', 'non-conflicting selections must still import');

    await importFixtureThroughFileInput(page, {}, rawJson, null, false);
    for (const conflict of await page.locator('[data-import-conflict]').all()) await conflict.getByRole('radio', { name: 'Overwrite' }).check();
    await page.locator('#processImportBtn:not([disabled])').waitFor();
    await page.locator('#processImportBtn').click();
    const overwritten = await page.evaluate(() => App.data.entityTypes.device.label);
    assert.equal(overwritten, 'Later', 'duplicate Overwrite plus existing-ID Overwrite must apply the later incoming value');
  });
}

async function testImportCollisionHardening() {
  await withPage(async page => {
    const original = { version: 'test', settings: {}, categories: {}, entityTypes: { device: { id: 'device', label: 'current', fields: [], categories: [] } }, entities: {}, workspaces: { default: { name: 'Default', categories: {}, entityTypes: {}, entities: {} } }, currentWorkspaceId: 'default' };
    const incoming = { entityTypes: { device: { id: 'device', label: 'incoming', fields: [], categories: [] } } };

    await page.evaluate(original => {
      localStorage.clear();
      localStorage.setItem('elistlyData', JSON.stringify(original));
      localStorage.setItem('elistlyData:user:user-1', JSON.stringify(original));
      localStorage.setItem('elistlyData:userUpdated:user-1', 'before');
      Storage._cached = structuredClone(original);
      Storage._cachedUserId = 'user-1';
      backendClient = { auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }), getSession: async () => ({ data: { session: { access_token: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyLTEifQ.' } } }) } };
      window.ELISTLY_API_URL = '/mock';
      window.fetch = async () => { throw new Error('remote rejected'); };
    }, original);
    await importFixtureThroughFileInput(page, incoming, null, original, false);
    await page.getByRole('radio', { name: 'Overwrite' }).check();
    await page.locator('#processImportBtn:not([disabled])').click();
    await page.getByText('Import was not saved; original data was restored.').waitFor();
    const rollback = await page.evaluate(() => ({ data: App.data, generic: localStorage.getItem('elistlyData'), user: localStorage.getItem('elistlyData:user:user-1'), updated: localStorage.getItem('elistlyData:userUpdated:user-1'), cached: Storage._cached, success: document.body.textContent.includes('Import complete') }));
    assert.deepEqual(rollback.data, original, 'remote rejection must restore in-memory data');
    assert.equal(rollback.generic, JSON.stringify(original), 'remote rejection must restore generic cache');
    assert.equal(rollback.user, JSON.stringify(original), 'remote rejection must restore user cache');
    assert.equal(rollback.updated, 'before', 'remote rejection must restore user timestamp');
    assert.deepEqual(rollback.cached, original, 'remote rejection must restore Storage cache');
    assert.equal(rollback.success, false, 'remote rejection must not report success');

    await page.evaluate(() => { backendClient = { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } }; });
    await importFixtureThroughFileInput(page, incoming, null, original, false);
    await page.getByRole('radio', { name: 'Overwrite' }).check();
    await page.locator('#processImportBtn:not([disabled])').click();
    await page.getByText('No signed-in account is available to save this import.').waitFor();
    assert.deepEqual(await page.evaluate(() => App.data), original, 'missing authenticated user must restore in-memory data');

    await page.evaluate(original => {
      localStorage.clear();
      localStorage.setItem('elistlyData', JSON.stringify(original));
      localStorage.setItem('elistlyData:user:user-1', JSON.stringify(original));
      localStorage.setItem('elistlyData:userUpdated:user-1', 'before');
      Storage._cached = structuredClone(original);
      Storage._cachedUserId = 'user-1';
      backendClient = { auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }), getSession: async () => ({ data: { session: { access_token: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyLTEifQ.' } } }) } };
      window.fetch = async () => new Response(JSON.stringify({ updated_at: 'after' }), { status: 200 });
      window.__originalWriteUserCache = Storage._writeUserCache;
      Storage._writeUserCache = () => {};
    }, original);
    await importFixtureThroughFileInput(page, incoming, null, original, false);
    await page.getByRole('radio', { name: 'Overwrite' }).check();
    await page.locator('#processImportBtn:not([disabled])').click();
    await page.getByText('Account cache persistence verification failed.').waitFor();
    const cacheVerificationRollback = await page.evaluate(() => ({ data: App.data, generic: localStorage.getItem('elistlyData'), user: localStorage.getItem('elistlyData:user:user-1'), updated: localStorage.getItem('elistlyData:userUpdated:user-1'), cached: Storage._cached, cachedUserId: Storage._cachedUserId, success: document.body.textContent.includes('Import complete') }));
    assert.deepEqual(cacheVerificationRollback.data, original, 'cache verification failure must restore in-memory data');
    assert.equal(cacheVerificationRollback.generic, JSON.stringify(original), 'cache verification failure must restore generic cache');
    assert.equal(cacheVerificationRollback.user, JSON.stringify(original), 'cache verification failure must restore account cache');
    assert.equal(cacheVerificationRollback.updated, 'before', 'cache verification failure must restore account timestamp');
    assert.deepEqual(cacheVerificationRollback.cached, original, 'cache verification failure must restore Storage cache');
    assert.equal(cacheVerificationRollback.cachedUserId, 'user-1', 'cache verification failure must restore Storage cache ownership');
    assert.equal(cacheVerificationRollback.success, false, 'cache verification failure must not report success');
    await page.evaluate(() => { Storage._writeUserCache = window.__originalWriteUserCache; });

    await page.evaluate(original => {
      localStorage.clear();
      localStorage.setItem('elistlyData', JSON.stringify(original));
      localStorage.setItem('elistlyData:user:user-1', JSON.stringify(original));
      localStorage.setItem('elistlyData:userUpdated:user-1', 'before');
      Storage._cached = structuredClone(original);
      Storage._cachedUserId = 'user-1';
      backendClient = { auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }), getSession: async () => ({ data: { session: { access_token: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyLTIifQ.' } } }) } };
      window.__putCalls = 0;
      window.fetch = async () => { window.__putCalls += 1; return new Response(JSON.stringify({ updated_at: 'after' }), { status: 200 }); };
    }, original);
    await importFixtureThroughFileInput(page, incoming, null, original, false);
    await page.getByRole('radio', { name: 'Overwrite' }).check();
    await page.locator('#processImportBtn:not([disabled])').click();
    await page.getByText('Import was not saved; original data was restored.').waitFor();
    const mismatchedIdentity = await page.evaluate(() => ({ puts: window.__putCalls, data: App.data, user1: localStorage.getItem('elistlyData:user:user-1'), user2: localStorage.getItem('elistlyData:user:user-2'), success: document.body.textContent.includes('Import complete') }));
    assert.equal(mismatchedIdentity.puts, 0, 'user and exact bearer mismatch must reject before PUT');
    assert.deepEqual(mismatchedIdentity.data, original, 'user and exact bearer mismatch must restore in-memory data');
    assert.equal(mismatchedIdentity.user1, JSON.stringify(original), 'user and exact bearer mismatch must preserve original account cache');
    assert.equal(mismatchedIdentity.user2, null, 'user and exact bearer mismatch must not write a different account cache');
    assert.equal(mismatchedIdentity.success, false, 'user and exact bearer mismatch must not report success');

    await page.evaluate(original => {
      let userId = 'user-1';
      localStorage.clear();
      localStorage.setItem('elistlyData', JSON.stringify(original));
      localStorage.setItem('elistlyData:user:user-1', JSON.stringify(original));
      localStorage.setItem('elistlyData:userUpdated:user-1', 'before');
      Storage._cached = structuredClone(original);
      Storage._cachedUserId = 'user-1';
      backendClient = { auth: {
        getUser: async () => ({ data: { user: { id: userId } } }),
        getSession: async () => ({ data: { session: { access_token: userId === 'user-1' ? 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyLTEifQ.' : 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyLTIifQ.' } } })
      } };
      window.__switchImportIdentity = () => { userId = 'user-2'; };
      window.__putCalls = 0;
      window.fetch = async () => { window.__putCalls += 1; return new Response(JSON.stringify({ updated_at: 'after' }), { status: 200 }); };
    }, original);
    await importFixtureThroughFileInput(page, incoming, null, original, false);
    await page.getByRole('radio', { name: 'Overwrite' }).check();
    await page.evaluate(() => window.__switchImportIdentity());
    await page.locator('#processImportBtn:not([disabled])').click();
    await page.getByText('Signed-in account changed. Reload and review this import again.').waitFor();
    const changedIdentity = await page.evaluate(() => ({ puts: window.__putCalls, data: App.data, preview: App._importDataPreview, success: document.body.textContent.includes('Import complete') }));
    assert.equal(changedIdentity.puts, 0, 'identity change after preview must reject before PUT');
    assert.deepEqual(changedIdentity.data, original, 'identity change after preview must preserve in-memory data');
    assert.equal(changedIdentity.preview, null, 'identity change after preview must invalidate the preview');
    assert.equal(changedIdentity.success, false, 'identity change after preview must not report success');

    await page.evaluate(original => {
      localStorage.clear();
      localStorage.setItem('elistlyData', JSON.stringify(original));
      localStorage.setItem('elistlyData:user:user-1', JSON.stringify(original));
      localStorage.setItem('elistlyData:userUpdated:user-1', 'before');
      Storage._cached = structuredClone(original);
      Storage._cachedUserId = 'user-1';
      backendClient = { auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }), getSession: async () => ({ data: { session: { access_token: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyLTEifQ.' } } }) } };
      window.__authorizations = [];
      window.fetch = async (_, options) => { window.__authorizations.push(options.headers.Authorization); return new Response(JSON.stringify({ updated_at: 'after' }), { status: 200 }); };
    }, original);
    await importFixtureThroughFileInput(page, incoming, null, original, false);
    await page.getByRole('radio', { name: 'Overwrite' }).check();
    await page.locator('#processImportBtn:not([disabled])').click();
    await page.getByText('Import complete:').waitFor();
    const matchedIdentity = await page.evaluate(() => ({ authorizations: window.__authorizations, user1: localStorage.getItem('elistlyData:user:user-1'), user2: localStorage.getItem('elistlyData:user:user-2'), updated1: localStorage.getItem('elistlyData:userUpdated:user-1'), success: document.body.textContent.includes('Import complete') }));
    assert.deepEqual(matchedIdentity.authorizations, ['Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyLTEifQ.'], 'PUT must use the exact captured bearer');
    assert.match(matchedIdentity.user1, /incoming/, 'matching bearer must write the matching account cache');
    assert.equal(matchedIdentity.user2, null, 'matching bearer must not write another account cache');
    assert.equal(matchedIdentity.updated1, 'after', 'matching bearer must verify the matching account timestamp');
    assert.equal(matchedIdentity.success, true, 'matching bearer and account identity must report success');

    await page.evaluate(() => { backendClient = null; window.ELISTLY_API_URL = ''; });
    const tripleRaw = '{"entityTypes":{"triple":{"label":"one"},"triple":{"label":"two"},"triple":{"label":"three"}}}';
    for (const [choices, expected, duplicateSkipped, duplicateOverwritten, displayedEarlier] of [
      [['Skip', 'Skip'], 'one', 2, 0, 'one'],
      [['Skip', 'Overwrite'], 'three', 1, 1, 'one'],
      [['Overwrite', 'Skip'], 'two', 1, 1, 'two'],
      [['Overwrite', 'Overwrite'], 'three', 0, 2, 'two']
    ]) {
      await importFixtureThroughFileInput(page, {}, tripleRaw, original, false);
      const conflicts = page.locator('[data-import-conflict]');
      await conflicts.nth(0).getByRole('radio', { name: choices[0] }).check();
      assert.match(await conflicts.nth(1).textContent(), new RegExp(`earlier \\{"label":"${displayedEarlier}"\\}; later \\{"label":"three"\\}`), `${choices.join('/')} must describe the effective earlier value after the upstream choice`);
      await conflicts.nth(1).getByRole('radio', { name: choices[1] }).check();
      await page.locator('#processImportBtn:not([disabled])').click();
      const outcome = await page.evaluate(() => ({ final: App.data.entityTypes.triple.label, notice: document.body.textContent }));
      assert.equal(outcome.final, expected, `${choices.join('/')} must retain the decision-driven effective duplicate value`);
      assert.match(outcome.notice, new RegExp(`duplicate members skipped ${duplicateSkipped}; duplicate members overwritten ${duplicateOverwritten}`), `${choices.join('/')} must report duplicate-member outcomes separately`);
    }

    await importFixtureThroughFileInput(page, {}, '{"entityTypes":{"__proto__":{"label":"polluted"}}}', original, false);
    await page.getByText('Import contains reserved entityTypes ID: __proto__.').waitFor();
    const dangerous = await page.evaluate(() => ({ own: Object.prototype.hasOwnProperty.call(App.data.entityTypes, '__proto__'), hasOrdinaryPrototype: Object.getPrototypeOf(App.data.entityTypes) === Object.prototype }));
    assert.equal(dangerous.own, false, 'dangerous IDs must not be imported');
    assert.equal(dangerous.hasOrdinaryPrototype, true, 'dangerous IDs must not alter collection prototypes');

    const longCurrent = `current-${'a'.repeat(700)}`;
    await importFixtureThroughFileInput(page, incoming, null, { ...original, entityTypes: { device: { id: 'device', label: longCurrent, fields: [], categories: [] } } }, false);
    await page.getByRole('radio', { name: 'Overwrite' }).check();
    await page.evaluate(() => { App.data.entityTypes.device.label = `${App.data.entityTypes.device.label.slice(0, 650)}changed`; });
    await page.locator('#processImportBtn').click();
    assert.equal(await page.locator('#processImportBtn').isDisabled(), true, 'changes beyond preview truncation must invalidate choices');

    await page.evaluate(() => { let rejected = false; try { App.parseImportJson('{\u00a0"x":1}'); } catch (_) { rejected = true; } window.__nbspRejected = rejected; });
    assert.equal(await page.evaluate(() => window.__nbspRejected), true, 'non-JSON whitespace must reject');
  });
}

const tests = { import: testImportPreviewIsInert, importCollisions: testImportCollisionChoices, importHardening: testImportCollisionHardening, qr: testQrRenderingIsLocalOnly, boundary: testCompleteImportedDataBoundary, managerExport: testManagerAndExportBoundary, editorParity: testEntityTypeEditorParity, settings: testImportedSettingsBoundary, customSeparator: testCustomTitleSeparatorParity };
const selected = process.argv[2] || 'import';
if (!tests[selected]) throw new Error(`Unknown test: ${selected}`);
tests[selected]().then(() => console.log(`PASS ${selected}`)).catch(error => {
  console.error(`FAIL ${selected}: ${error.stack || error.message}`);
  process.exitCode = 1;
});
