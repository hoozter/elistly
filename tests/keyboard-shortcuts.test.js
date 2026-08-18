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

(async () => {
  const server = await startStaticServer();
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/app.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.getElementById('authSignInModal')?.remove();
      App.setupEventListeners();
    });

    const shortcutMetadata = await page.locator('#searchInput').evaluate(input => ({
      aria: input.getAttribute('aria-keyshortcuts'),
      title: input.getAttribute('title')
    }));
    assert.deepEqual(shortcutMetadata, { aria: '/ Control+K Meta+K', title: 'Search (/ or Ctrl+K)' });

    await page.locator('body').click({ position: { x: 2, y: 2 } });
    await page.keyboard.press('/');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'searchInput');
    assert.equal(await page.evaluate(() => document.body.classList.contains('search-expanded')), true);

    await page.evaluate(() => {
      const textarea = document.createElement('textarea');
      textarea.id = 'shortcut-editable-probe';
      document.body.appendChild(textarea);
      textarea.focus();
    });
    await page.keyboard.press('/');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'shortcut-editable-probe');

    await page.locator('#shortcut-editable-probe').dispatchEvent('keydown', { key: 'k', ctrlKey: true });
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'searchInput');
    console.log('PASS keyboard shortcuts');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });