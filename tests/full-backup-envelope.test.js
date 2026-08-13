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
    if (!filePath.startsWith(`${root}${path.sep}`) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      response.writeHead(404).end('Not found');
      return;
    }
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

async function testFullBackupEnvelopeIsVersionedAndLossless() {
  await withPage(async page => {
    const backup = await page.evaluate(() => {
      App.data = {
        version: 'fixture-app-version',
        settings: { defaultView: 'list', unknownSetting: { retained: true } },
        workspaces: {
          first: {
            name: 'First workspace',
            categories: { hardware: { label: 'Hardware', unknownCategoryField: ['preserve'] } },
            entityTypes: {
              computer: {
                label: 'Computer',
                fields: [{ name: 'serial', label: 'Serial', type: 'text', unknownFieldMetadata: 'preserve' }],
                associations: [{ name: 'owner', association: { kind: 'belongs_to', targetType: 'person' } }],
                unknownTypeField: { retained: true }
              }
            },
            entities: {
              computer_1: { id: 'computer_1', type: 'computer', name: 'Laptop', owner: 'person_1', sortOrder: 4, unknownEntityField: { retained: true } },
              person_1: { id: 'person_1', type: 'person', name: 'Owner' }
            },
            unknownWorkspaceField: 'preserve'
          }
        },
        currentWorkspaceId: 'first',
        ordering: ['computer_1', 'person_1'],
        unknownTopLevelField: { retained: true },
        isAdmin: true,
        auth: { accessToken: 'secret' },
        runtimeConfig: { apiUrl: 'https://internal.example' },
        outbox: [{ payload: 'unsent' }],
        cache: { stale: true }
      };
      const before = structuredClone(App.data);
      const envelope = App.createFullBackupEnvelope();
      return { envelope, before, after: App.data };
    });

    assert.deepEqual(backup.after, backup.before, 'creating a backup must not mutate application data');
    assert.equal(backup.envelope.schema, 'elistly.full-backup');
    assert.equal(backup.envelope.schemaVersion, 1);
    assert.equal(backup.envelope.appVersion, 'fixture-app-version');
    assert.deepEqual(backup.envelope.metadata, { theme: null });
    assert.match(backup.envelope.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(backup.envelope.data, {
      version: 'fixture-app-version',
      settings: { defaultView: 'list', unknownSetting: { retained: true } },
      workspaces: backup.before.workspaces,
      currentWorkspaceId: 'first',
      ordering: ['computer_1', 'person_1'],
      unknownTopLevelField: { retained: true }
    }, 'the backup payload must retain all authoritative data and unknown stored fields');
    for (const runtimeKey of ['isAdmin', 'auth', 'runtimeConfig', 'outbox', 'cache']) {
      assert.equal(Object.hasOwn(backup.envelope.data, runtimeKey), false, `${runtimeKey} must not enter the backup`);
    }
  });
}

async function testFullBackupSerializationAndDownloadContract() {
  await withPage(async page => {
    const observed = await page.evaluate(() => {
      App.data = {
        version: 'fixture-app-version', settings: { defaultView: 'list' },
        categories: { legacy: { label: 'Legacy' } }, entityTypes: {}, entities: {},
        workspaces: { default: { name: 'Default', categories: {}, entityTypes: {}, entities: {} } },
        currentWorkspaceId: 'default'
      };
      const first = App.createFullBackupEnvelope();
      const second = App.createFullBackupEnvelope();
      const originalCreateObjectURL = URL.createObjectURL;
      const originalRevokeObjectURL = URL.revokeObjectURL;
      const originalClick = HTMLAnchorElement.prototype.click;
      const downloads = [];
      URL.createObjectURL = blob => { downloads.push({ blob }); return 'blob:backup'; };
      URL.revokeObjectURL = () => {};
      HTMLAnchorElement.prototype.click = function () { downloads[0].filename = this.download; };
      const result = App.exportAllData();
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
      HTMLAnchorElement.prototype.click = originalClick;
      return { first, second, result, download: downloads[0] && { filename: downloads[0].filename, type: downloads[0].blob.type } };
    });
    const { exportedAt: firstExportedAt, ...firstPayload } = observed.first;
    const { exportedAt: secondExportedAt, ...secondPayload } = observed.second;
    assert.match(firstExportedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(secondExportedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(firstPayload, secondPayload, 'the payload must be deterministic aside from generated metadata');
    assert.equal(observed.result, true);
    assert.match(observed.download.filename, /^elistly-full-backup-v1-\d{4}-\d{2}-\d{2}\.json$/);
    assert.equal(observed.download.type, 'application/json');
  });
}

async function testMalformedDataDoesNotDownloadABackup() {
  await withPage(async page => {
    const observed = await page.evaluate(() => {
      App.data = { settings: null, workspaces: {}, currentWorkspaceId: 'default' };
      const notices = [];
      const originalNotification = App.showNotification;
      const originalCreateObjectURL = URL.createObjectURL;
      App.showNotification = (message, kind) => notices.push({ message, kind });
      let downloads = 0;
      URL.createObjectURL = () => { downloads += 1; return 'blob:unsafe'; };
      const result = App.exportAllData();
      App.showNotification = originalNotification;
      URL.createObjectURL = originalCreateObjectURL;
      return { result, notices, downloads };
    });
    assert.equal(observed.result, false);
    assert.equal(observed.downloads, 0, 'invalid memory state must not create a misleading download');
    assert.deepEqual(observed.notices, [{ message: 'Current app data cannot be backed up safely.', kind: 'error' }]);
  });
}

async function testFullBackupRestorePreviewsThenReplacesThroughTheAuthoritativePath() {
  await withPage(async page => {
    const observed = await page.evaluate(async () => {
      const original = { version: 'before', settings: { view: 'list' }, workspaces: { old: { name: 'Old', categories: {}, entityTypes: {}, entities: {} } }, currentWorkspaceId: 'old' };
      const restored = { version: 'after', settings: { view: 'grid', retained: { yes: true } }, workspaces: { restored: { name: 'Restored', categories: { hardware: { label: 'Hardware' } }, entityTypes: { computer: { label: 'Computer', categoryId: 'hardware', fields: [] } }, entities: { laptop: { id: 'laptop', type: 'computer', name: 'Laptop' } } } }, currentWorkspaceId: 'restored', unknown: { retained: true } };
      App.data = structuredClone(original);
      const envelope = { schema: 'elistly.full-backup', schemaVersion: 1, appVersion: 'after', exportedAt: '2026-08-13T00:00:00.000Z', metadata: { theme: null }, data: restored };
      const candidate = App.parseFullBackupRestore(JSON.stringify(envelope));
      const preview = App.fullBackupRestoreSummary(candidate);
      let writes = 0;
      const originalSave = Storage.setAppDataForImport;
      Storage.setAppDataForImport = async data => { writes += 1; return structuredClone(data); };
      await App.applyFullBackupRestore(candidate, {});
      Storage.setAppDataForImport = originalSave;
      return { candidate, preview, writes, data: App.data };
    });
    assert.deepEqual(observed.candidate, observed.data, 'the validated candidate must become the restored authoritative data');
    assert.equal(observed.writes, 1, 'replace must invoke the authoritative persistence path once');
    assert.match(observed.preview, /1 workspace, 1 category, 1 entity type, and 1 entity/, 'preview must truthfully summarize the replacement payload');
    assert.deepEqual(observed.data.unknown, { retained: true }, 'unknown authoritative fields must survive restore');
  });
}

async function testFullBackupRestoreRejectsUnsafePayloadBeforeMutation() {
  await withPage(async page => {
    const observed = await page.evaluate(() => {
      const original = { version: 'before', settings: {}, workspaces: { old: { name: 'Old', categories: {}, entityTypes: {}, entities: {} } }, currentWorkspaceId: 'old' };
      App.data = structuredClone(original);
      const unsafe = {
        schema: 'elistly.full-backup',
        schemaVersion: 1,
        data: {
          settings: {},
          workspaces: {
            restored: {
              categories: {},
              entityTypes: { computer: { fields: [] } },
              entities: { laptop: { id: 'other', type: 'missing' } }
            }
          },
          currentWorkspaceId: 'restored'
        }
      };
      let message = null;
      try { App.parseFullBackupRestore(JSON.stringify(unsafe)); } catch (error) { message = error.message; }
      return { message, data: App.data };
    });
    assert.match(observed.message, /invalid/i);
    assert.deepEqual(observed.data, { version: 'before', settings: {}, workspaces: { old: { name: 'Old', categories: {}, entityTypes: {}, entities: {} } }, currentWorkspaceId: 'old' }, 'rejected previews must not mutate live data');
  });
}

async function testFullBackupRestoreModalCancelsWithoutMutation() {
  await withPage(async page => {
    const observed = await page.evaluate(() => {
      const original = { version: 'before', settings: {}, workspaces: { old: { name: 'Old', categories: {}, entityTypes: {}, entities: {} } }, currentWorkspaceId: 'old' };
      App.data = structuredClone(original);
      App.showFullBackupRestoreModal();
      document.querySelector('#fullBackupRestoreModal .btn-secondary').click();
      return { data: App.data, visible: document.getElementById('fullBackupRestoreModal').classList.contains('show') };
    });
    assert.deepEqual(observed.data, { version: 'before', settings: {}, workspaces: { old: { name: 'Old', categories: {}, entityTypes: {}, entities: {} } }, currentWorkspaceId: 'old' });
    assert.equal(observed.visible, false, 'cancel must close without applying any candidate');
  });
}

async function run() {
  await testFullBackupEnvelopeIsVersionedAndLossless();
  await testFullBackupSerializationAndDownloadContract();
  await testMalformedDataDoesNotDownloadABackup();
  await testFullBackupRestorePreviewsThenReplacesThroughTheAuthoritativePath();
  await testFullBackupRestoreRejectsUnsafePayloadBeforeMutation();
  await testFullBackupRestoreModalCancelsWithoutMutation();
}

run()
  .then(() => console.log('PASS full backup envelope'))
  .catch(error => {
    console.error(`FAIL full backup envelope: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
