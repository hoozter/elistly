#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const Intake = require('../device-intake.js');

const valid = (overrides = {}) => ({
  schema: 'elistly.device-intake.v1',
  collectedAt: '2026-08-07T10:00:00.000Z',
  collector: { name: 'Elistly Windows Device Intake Collector', version: '1.0.0' },
  collection: { mode: 'local-only', networkDirectoryLookup: false, fields: ['computer.hostname'] },
  person: {},
  computer: { hostname: '  LAPTOP-01  ', manufacturer: 'Dell', serialNumber: ' ABC123 ' },
  ...overrides
});

function rejects(report, pattern) {
  assert.throws(() => Intake.parseReport(typeof report === 'string' ? report : JSON.stringify(report)), pattern);
}

function parserTests() {
  const parsed = Intake.parseReport(JSON.stringify(valid()));
  assert.equal(parsed.computer.hostname, 'LAPTOP-01');
  assert.equal(parsed.computer.serialNumber, 'ABC123');
  assert.equal(parsed.normalized.computer.hostname, 'laptop-01');
  assert.equal(parsed.collector.version, '1.0.0');
  assert.equal(Object.isFrozen(parsed), true);

  rejects({}, /schema is required/i);
  rejects(valid({ schema: 'elistly.device-intake.v2' }), /unsupported schema/i);
  rejects(valid({ collectedAt: 'not-a-date' }), /collectedAt.*timestamp/i);
  rejects(valid({ computer: 'wrong' }), /computer.*object/i);
  rejects(valid({ computer: { serialNumber: 'To Be Filled By O.E.M.', manufacturer: 'Dell' } }), /stable computer identity/i);
  rejects(valid({ computer: { hostname: 'PC', windowsDomain: '' } }), /stable computer identity/i);
  rejects(valid({ computer: { hostname: 'PC', windowsDomain: 'WORKGROUP' }, person: { email: ['wrong'] } }), /person.email.*string/i);
  rejects(JSON.stringify(valid()) + ' '.repeat(Intake.limits.maxBytes), /256 KiB/i);
  rejects(valid({ computer: { hostname: 'PC', windowsDomain: 'WORKGROUP', extra: { a: { b: { c: { d: 1 } } } } } }), /depth/i);
  rejects(valid({ computer: Object.fromEntries([['hostname', 'PC'], ['windowsDomain', 'WORKGROUP'], ...Array.from({ length: 70 }, (_, i) => [`x${i}`, 'x'])]) }), /field limit/i);
  assert.doesNotThrow(() => Intake.parseReport(JSON.stringify(valid({ collector: { name: 'Elistly Windows Device Intake Collector', version: '1.9.0' } }))));
}

function matchingTests() {
  const report = Intake.parseReport(JSON.stringify(valid({
    person: { displayName: 'Alex Example', email: 'alex@example.com', accountName: 'alex', domain: 'ACME' },
    computer: { hostname: 'LAPTOP-01', windowsDomain: 'ACME', manufacturer: 'Dell', serialNumber: 'ABC123' }
  })));
  const data = { version: '1', settings: {}, categories: {}, entityTypes: {}, entities: {
    pcSerial: { id: 'pcSerial', type: 'computer', name: 'Old', manufacturer: 'Dell', serialNumber: 'abc123', hostname: 'OTHER', windowsDomain: 'ACME' },
    pcHost: { id: 'pcHost', type: 'computer', name: 'Laptop', hostname: 'laptop-01', windowsDomain: 'ACME' },
    byEmail: { id: 'byEmail', type: 'person', name: 'Alex E', email: 'ALEX@example.com' },
    byAccount: { id: 'byAccount', type: 'person', name: 'Alex Account', accountName: 'alex', domain: 'acme' },
    byName: { id: 'byName', type: 'person', name: 'Alex Example' }
  }, workspaces: { default: { name: 'Default', categories: {}, entityTypes: {}, entities: {} } }, currentWorkspaceId: 'default' };
  const before = JSON.stringify(data);
  const plan = Intake.createPlan(report, data);
  assert.equal(JSON.stringify(data), before, 'preview must not mutate source data');
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(plan.computer.status, 'conflict');
  assert.deepEqual(plan.computer.candidates.map(x => x.id), ['pcSerial', 'pcHost']);
  const serialPreview = plan.computer.candidates[0].fieldPreview;
  assert.ok(serialPreview.some(field => field.field === 'hostname' && field.disposition === 'overwritten' && field.before === 'OTHER'));
  assert.ok(serialPreview.some(field => field.field === 'manufacturer' && field.disposition === 'unchanged'));
  assert.ok(serialPreview.some(field => field.field === 'id' && field.disposition === 'retained'));
  assert.equal(plan.person.status, 'conflict');
  assert.deepEqual(plan.person.candidates.map(x => x.id), ['byEmail', 'byAccount']);
  assert.equal(plan.person.candidates.some(x => x.id === 'byName'), false, 'name-only must never match');
  assert.ok(plan.schemaChanges.entityTypes.some(change => change.id === 'computer'), 'preview must disclose a missing computer schema');
  assert.ok(plan.schemaChanges.entityTypes.some(change => change.id === 'person'), 'preview must disclose a missing person schema');
  assert.throws(() => Intake.materializePlan(plan, data, {}), /explicit choice/i);
  const candidate = Intake.materializePlan(plan, data, { computer: 'pcSerial', person: 'byEmail' });
  assert.equal(data.entities.pcSerial.name, 'Old', 'materialization must not mutate current data');
  assert.equal(candidate.entities.pcSerial.hostname, 'LAPTOP-01');
  assert.equal(candidate.entities.pcSerial.assignedTo, 'byEmail');
  assert.equal(candidate.entities.byEmail.email, 'alex@example.com');
  assert.ok(candidate.entityTypes.computer.fields.some(field => field.name === 'hostname'), 'confirmed import must add a visible hostname field');
  assert.ok(candidate.entityTypes.computer.fields.some(field => field.name === 'serialNumber'), 'confirmed import must add a visible serial field');
  assert.ok(candidate.entityTypes.person.fields.some(field => field.name === 'accountName'), 'confirmed import must add visible person identity fields');
  assert.deepEqual(candidate.workspaces.default.entityTypes, candidate.entityTypes, 'confirmed schema migration must persist in the active workspace');
  assert.ok(plan.computer.changes.some(change => change.field === 'hostname' && change.before === 'OTHER' && change.after === 'LAPTOP-01'));

  const identityConflict = Intake.createPlan(Intake.parseReport(JSON.stringify(valid({
    person: { email: 'alex@example.com', upn: 'other@example.com' },
    computer: { manufacturer: 'Dell', serialNumber: 'ABC123' }
  }))), { ...data, entities: { ...data.entities, byUpn: { id: 'byUpn', type: 'person', name: 'Other', upn: 'other@example.com' } } });
  assert.equal(identityConflict.person.status, 'conflict', 'email and UPN matching different people must conflict');
  assert.deepEqual(identityConflict.person.candidates.map(x => x.id), ['byEmail', 'byUpn']);

  const serialOnly = Intake.createPlan(Intake.parseReport(JSON.stringify(valid({ computer: { manufacturer: 'Dell', serialNumber: 'ABC123' } }))), data);
  assert.equal(serialOnly.computer.status, 'update');
  assert.equal(serialOnly.computer.matchId, 'pcSerial');
  const hostnameOnly = Intake.createPlan(Intake.parseReport(JSON.stringify(valid({ computer: { hostname: 'LAPTOP-01', windowsDomain: 'ACME' } }))), data);
  assert.equal(hostnameOnly.computer.status, 'update');
  assert.equal(hostnameOnly.computer.matchId, 'pcHost');
  const placeholder = Intake.createPlan(Intake.parseReport(JSON.stringify(valid({ computer: { serialNumber: 'Default String', manufacturer: 'Dell', hostname: 'NEW-PC', windowsDomain: 'WORKGROUP' } }))), data);
  assert.equal(placeholder.computer.status, 'create');
  assert.ok(placeholder.computer.fieldPreview.every(field => field.disposition === 'added'));
}

parserTests();
matchingTests();
console.log('PASS parser matching');
