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
    const hostileMarkup = `<img src="/missing-${marker}" onerror="window.__elistlyPreviewHandlerHits++"><svg onload="window.__elistlyPreviewHandlerHits++"></svg><script>window.__elistlyPreviewHandlerHits++</script><span title="${marker}\">attribute breakout</span>&lt;svg onload=window.__elistlyPreviewHandlerHits++&gt;`;
    const fixture = {
      entityTypes: { [`type-${marker}`]: { label: hostileMarkup, fields: [], categories: [] } },
      categories: { [`category-${marker}`]: { label: hostileMarkup } },
      entities: { [`entity-${marker}`]: { id: `entity-${marker}`, type: `type-${marker}`, name: hostileMarkup, nested: { label: hostileMarkup } } }
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
    assert.deepEqual(preview.checkboxValues.sort(), [`category-${marker}`, `entity-${marker}`, `type-${marker}`].sort());
    await page.locator('#processImportBtn').click();
    const persisted = await page.evaluate(marker => ({
      entity: App.data.entities[`entity-${marker}`],
      storage: localStorage.getItem('elistlyData')
    }), marker);
    assert.equal(persisted.entity.name, hostileMarkup, 'selected hostile fixture should persist as data, not preview DOM');
    assert.match(persisted.storage, new RegExp(marker));
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
