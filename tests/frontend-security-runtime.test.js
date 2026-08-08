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

async function importFixtureThroughFileInput(page, fixture) {
  await page.evaluate(() => {
    window.__elistlyPreviewHandlerHits = 0;
    App.data = {
      version: 'test', settings: {}, categories: {}, entityTypes: {}, entities: {},
      workspaces: { default: { name: 'Default', categories: {}, entityTypes: {}, entities: {} } },
      currentWorkspaceId: 'default'
    };
    App.showImportModal();
  });
  await page.locator('#importFileInput').setInputFiles({
    name: 'hostile-import.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixture), 'utf8')
  });
  await page.locator('#processImportBtn:not([disabled])').waitFor();
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

const tests = { import: testImportPreviewIsInert, qr: testQrRenderingIsLocalOnly, boundary: testCompleteImportedDataBoundary, managerExport: testManagerAndExportBoundary };
const selected = process.argv[2] || 'import';
if (!tests[selected]) throw new Error(`Unknown test: ${selected}`);
tests[selected]().then(() => console.log(`PASS ${selected}`)).catch(error => {
  console.error(`FAIL ${selected}: ${error.stack || error.message}`);
  process.exitCode = 1;
});
