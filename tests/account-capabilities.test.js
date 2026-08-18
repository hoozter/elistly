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
    assert.deepEqual(await page.evaluate(() => window.elistlyClient.auth.capabilities), {
      passwordReset: false,
      emailManagement: false,
      mfa: false
    }, 'the Neon adapter must publish its supported account capabilities');
    assert.equal(await page.locator('.auth-forgot').count(), 0, 'an unavailable password-reset flow must not be interactive');

    await page.evaluate(() => {
      backendClient = {
        auth: {
          capabilities: { passwordReset: false, emailManagement: false, mfa: false },
          getUser: async () => ({ data: { user: { id: 'user-1', email: 'member@example.test', user_metadata: {} } } })
        }
      };
      App.getDisplayName = async () => 'Member';
    });
    await page.evaluate(() => App.showProfileModal());
    const unsupportedControls = await page.locator('#profileModal').evaluate(modal => ({
      text: modal.textContent,
      emailActions: modal.querySelectorAll('[data-action], #profileAddEmailBtn, #profileConfirmNewEmail').length,
      mfaActions: modal.querySelectorAll('#profileEnable2FABtn, #profileDisableTOTPBtn').length
    }));
    assert.equal(unsupportedControls.text.includes('Two-factor authentication'), false, 'unsupported MFA must be absent from Profile');
    assert.equal(unsupportedControls.text.includes('Add another email'), false, 'unsupported email management must be absent from Profile');
    assert.equal(unsupportedControls.emailActions, 0, 'unsupported email actions must not be interactive');
    assert.equal(unsupportedControls.mfaActions, 0, 'unsupported MFA actions must not be interactive');
    console.log('PASS account capabilities');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
