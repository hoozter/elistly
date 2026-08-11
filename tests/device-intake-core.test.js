#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const Intake = require('../device-intake.js');

const valid = (overrides = {}) => ({
  schema: 'elistly.device-intake.v1',
  collectedAt: '2026-08-07T10:00:00.000Z',
  collector: { name: 'Elistly Windows Device Intake Collector', version: '1.0.2' },
  collection: { mode: 'local-only', networkDirectoryLookup: false, fields: ['computer.hostname'] },
  person: {},
  computer: { hostname: '  LAPTOP-01  ', manufacturer: 'Dell', serialNumber: ' ABC123 ' },
  ...overrides
});

function rejects(report, pattern) {
  assert.throws(() => Intake.parseReport(typeof report === 'string' ? report : JSON.stringify(report)), pattern);
}

function parserTests() {
  const hostile = '<img src=x onerror=window.__deviceIntakeXss=1>';
  const source = JSON.stringify(valid({
    person: { displayName: hostile, accountName: ' campbell ' },
    computer: {
      hostname: '  LAPTOP-01  ', manufacturer: 'Dell', serialNumber: ' ABC123 ',
      graphicsAdapters: [' GPU One ', 'GPU Two'], model: hostile
    }
  }));
  const priorAppData = { untouched: true };
  global.App = { data: priorAppData };
  const parsed = Intake.parseReport(source);

  assert.equal(parsed.computer.hostname, 'LAPTOP-01');
  assert.equal(parsed.computer.serialNumber, 'ABC123');
  assert.deepEqual(parsed.computer.graphicsAdapters, ['GPU One', 'GPU Two']);
  assert.equal(parsed.computer.model, hostile, 'hostile strings must remain plain data');
  assert.equal(parsed.person.displayName, hostile);
  assert.equal(parsed.person.accountName, 'campbell');
  assert.equal(parsed.normalized.computer.hostname, 'laptop-01');
  assert.equal(parsed.collector.version, '1.0.2');
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.computer), true);
  assert.equal(Object.isFrozen(parsed.collection.fields), true);
  assert.equal(source, JSON.stringify(JSON.parse(source)), 'parsing must not alter supplied JSON text');
  assert.equal(global.App.data, priorAppData, 'parsing must not touch application data');
  delete global.App;

  const withoutPerson = valid();
  delete withoutPerson.person;
  assert.deepEqual(Intake.parseReport(JSON.stringify(withoutPerson)).person, {}, 'person context is optional');
  assert.deepEqual(Intake.parseReport(JSON.stringify(valid({ person: {} }))).person, {});

  rejects({}, /schema is required/i);
  rejects([], /root.*object/i);
  rejects(valid({ schema: 'elistly.device-intake.v2' }), /unsupported schema/i);
  rejects(valid({ collectedAt: 'not-a-date' }), /collectedAt.*timestamp/i);
  rejects(valid({ collector: 'wrong' }), /collector.*object/i);
  rejects(valid({ collection: [] }), /collection.*object/i);
  rejects(valid({ computer: 'wrong' }), /computer.*object/i);
  rejects(valid({ person: 'wrong' }), /person.*object/i);
  rejects(valid({ computer: { serialNumber: 'To Be Filled By O.E.M.', manufacturer: 'Dell' } }), /stable computer identity/i);
  rejects(valid({ computer: { hostname: 'PC', windowsDomain: '' } }), /stable computer identity/i);
  rejects(valid({ computer: { hostname: 'PC', windowsDomain: 'WORKGROUP', graphicsAdapters: 'wrong' } }), /computer.graphicsAdapters.*array/i);
  rejects(valid({ computer: { hostname: 'PC', windowsDomain: 'WORKGROUP' }, person: { email: ['wrong'] } }), /person.email.*string/i);
  rejects(JSON.stringify(valid()) + ' '.repeat(Intake.limits.maxBytes), /256 KiB/i);
  rejects(valid({ computer: { hostname: 'PC', windowsDomain: 'WORKGROUP', extra: { a: { b: { c: { d: 1 } } } } } }), /depth/i);
  rejects(valid({ computer: Object.fromEntries([['hostname', 'PC'], ['windowsDomain', 'WORKGROUP'], ...Array.from({ length: 70 }, (_, i) => [`x${i}`, 'x'])]) }), /field limit/i);
  rejects(valid({ collection: { fields: Array.from({ length: 65 }, () => 'field') } }), /array limit/i);

  assert.equal(Intake.createPlan, undefined, 'intake must not expose entity planning');
  assert.equal(Intake.materializePlan, undefined, 'intake must not expose entity materialization');
}

function mapperTests() {
  const report = Intake.parseReport(JSON.stringify(valid({
    person: { displayName: 'Campbell Example', accountName: 'campbell', email: 'campbell@example.test' },
    computer: {
      hostname: 'LAPTOP-01', windowsDomain: 'ACME', accountName: 'campbell',
      manufacturer: 'Dell', model: 'Latitude 7450', processorSummary: 'Intel Core Ultra 7',
      memorySummary: '16 GB', graphicsAdapters: ['Intel Graphics', 'NVIDIA RTX'],
      windowsBuild: '26100', serialNumber: 'ABC123'
    }
  })));
  const entityType = {
    id: 'computer', label: 'Computer', category: 'devices',
    fields: [
      { name: 'hostname', label: 'Hostname', type: 'text' },
      { name: 'assetModel', label: 'Asset model', type: 'text', collection: { provider: 'windows', capability: 'computer.model' } },
      { name: 'cpu', label: 'CPU', type: 'text' },
      { name: 'ram', label: 'RAM', type: 'dropdown', options: [{ value: '8GB' }, { value: '32GB' }] },
      { name: 'gpu', label: 'GPU', type: 'textarea' },
      { name: 'serialNumber', label: 'Serial', type: 'checkbox' },
      { name: 'build', label: 'Build', type: 'number', collection: { provider: 'windows', capability: 'windows.build' } },
      { name: 'notes', label: 'Notes', type: 'textarea' }
    ],
    associations: [{ name: 'assignedTo', association: { targetType: 'person' } }]
  };
  const draft = { hostname: '', assetModel: 'Manually entered model', cpu: '', ram: '', gpu: '', assignedTo: '' };
  const before = {
    report: JSON.stringify(report),
    entityType: JSON.stringify(entityType),
    draft: JSON.stringify(draft)
  };
  const proposal = Intake.createDraftProposal(report, entityType, draft, Intake.capabilityRegistry);

  assert.equal(Object.isFrozen(proposal), true);
  assert.equal(Object.isFrozen(proposal.mapped), true);
  assert.deepEqual(proposal.mapped.map(item => [item.fact, item.field, item.value]), [
    ['hostname', 'hostname', 'LAPTOP-01'],
    ['processorSummary', 'cpu', 'Intel Core Ultra 7'],
    ['graphicsAdapters', 'gpu', 'Intel Graphics; NVIDIA RTX']
  ]);
  assert.deepEqual(proposal.conflicts.map(item => [item.fact, item.field, item.current, item.value]), [
    ['model', 'assetModel', 'Manually entered model', 'Latitude 7450']
  ]);
  assert.ok(proposal.unmapped.some(item => item.fact === 'manufacturer' && /no existing field/i.test(item.reason)));
  assert.ok(proposal.unmapped.some(item => item.fact === 'memorySummary' && /dropdown option/i.test(item.reason)));
  assert.ok(proposal.unmapped.some(item => item.fact === 'serialNumber' && /field type/i.test(item.reason)));
  assert.ok(proposal.unmapped.some(item => item.fact === 'windowsBuild' && /field type/i.test(item.reason)));
  assert.equal(proposal.mapped.some(item => item.field === 'notes'), false, 'unknown custom fields remain untouched');
  assert.deepEqual(proposal.accountContext, {
    displayName: 'Campbell Example', accountName: 'campbell', email: 'campbell@example.test', windowsDomain: 'ACME'
  });
  assert.equal('person' in proposal, false, 'a proposal must not contain a Person action');
  assert.equal('associations' in proposal, false, 'a proposal must not select associations');
  assert.equal(JSON.stringify(report), before.report, 'mapping must not mutate the parsed report');
  assert.equal(JSON.stringify(entityType), before.entityType, 'mapping must not mutate the entity type');
  assert.equal(JSON.stringify(draft), before.draft, 'mapping must not mutate draft values');

  const customRegistry = {
    'computer.hostname': { source: 'hostname', aliases: ['machineName'], fieldTypes: ['text'] }
  };
  const customType = { id: 'device', fields: [{ name: 'machineName', type: 'text' }] };
  const customProposal = Intake.createDraftProposal(report, customType, {}, customRegistry);
  assert.deepEqual(customProposal.mapped.map(item => item.field), ['machineName']);
  assert.ok(customProposal.unmapped.every(item => item.fact !== 'model'), 'facts outside the supplied registry are not claimed as mapped or unmapped');

  const dropdownReport = Intake.parseReport(JSON.stringify(valid({ computer: { hostname: 'PC', windowsDomain: 'ACME', processorSummary: 'intel core i5' } })));
  const dropdownType = { id: 'computer', fields: [{ name: 'cpu', type: 'dropdown', options: [{ value: 'Intel Core i5' }] }] };
  const dropdownProposal = Intake.createDraftProposal(dropdownReport, dropdownType, {});
  assert.deepEqual(dropdownProposal.mapped.map(item => item.value), ['Intel Core i5'], 'dropdown comparisons use canonical option values');
}

parserTests();
mapperTests();
console.log('PASS device-intake parser and mapper');
