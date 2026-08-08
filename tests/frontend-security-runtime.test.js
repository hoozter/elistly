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

const tests = { import: testImportPreviewIsInert, qr: testQrRenderingIsLocalOnly };
const selected = process.argv[2] || 'import';
if (!tests[selected]) throw new Error(`Unknown test: ${selected}`);
tests[selected]().then(() => console.log(`PASS ${selected}`)).catch(error => {
  console.error(`FAIL ${selected}: ${error.stack || error.message}`);
  process.exitCode = 1;
});
