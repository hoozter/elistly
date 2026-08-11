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

parserTests();
console.log('PASS device-intake parser');
