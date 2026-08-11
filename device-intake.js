(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ElistlyDeviceIntake = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const limits = Object.freeze({ maxBytes: 256 * 1024, maxDepth: 4, maxFields: 64, maxString: 4096, maxArray: 64 });
  const placeholders = new Set(['to be filled by o.e.m.', 'default string', 'system serial number', 'none', 'unknown', 'n/a']);
  const computerFields = ['hostname', 'manufacturer', 'model', 'processorSummary', 'processorDescription', 'memorySummary', 'graphicsAdapters', 'windowsEdition', 'windowsVersion', 'windowsBuild', 'serialNumber', 'accountName', 'windowsDomain'];
  const personFields = ['displayName', 'accountName', 'domain', 'upn', 'email', 'phone', 'jobTitle'];

  function fail(path, message) { throw new Error(`${path}: ${message}`); }

  function clean(value, path) {
    if (typeof value !== 'string') fail(path, 'must be a string');
    if (value.length > limits.maxString) fail(path, `exceeds ${limits.maxString} characters`);
    return value.trim().replace(/\s+/g, ' ');
  }

  function inspect(value, path, depth, state) {
    if (depth > limits.maxDepth) fail(path, 'exceeds the object depth limit');
    if (typeof value === 'string' && value.length > limits.maxString) fail(path, `exceeds ${limits.maxString} characters`);
    if (Array.isArray(value)) {
      if (value.length > limits.maxArray) fail(path, 'exceeds the array limit');
      value.forEach((entry, index) => inspect(entry, `${path}[${index}]`, depth + 1, state));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        state.fields += 1;
        if (state.fields > limits.maxFields) fail(path, 'exceeds the total field limit');
        inspect(entry, `${path}.${key}`, depth + 1, state);
      }
    }
  }

  function copyFields(source, names, path) {
    const output = {};
    for (const name of names) {
      if (source[name] === undefined || source[name] === null || source[name] === '') continue;
      if (name === 'graphicsAdapters') {
        if (!Array.isArray(source[name])) fail(`${path}.${name}`, 'must be an array');
        output[name] = source[name].map((entry, index) => clean(entry, `${path}.${name}[${index}]`));
      } else {
        output[name] = clean(source[name], `${path}.${name}`);
      }
    }
    return output;
  }

  function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }

  function parseReport(text) {
    if (typeof text !== 'string') throw new Error('Report must be JSON text.');
    if (new TextEncoder().encode(text).length > limits.maxBytes) throw new Error('Report exceeds the 256 KiB limit.');

    let input;
    try {
      input = JSON.parse(text);
    } catch (_) {
      throw new Error('Report is not valid JSON.');
    }
    if (!input || Array.isArray(input) || typeof input !== 'object') throw new Error('Report root must be an object.');
    inspect(input, '$', 0, { fields: 0 });

    if (!input.schema) throw new Error('schema is required');
    if (input.schema !== 'elistly.device-intake.v1') fail('schema', 'unsupported schema');
    if (typeof input.collectedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.collectedAt) || Number.isNaN(Date.parse(input.collectedAt))) {
      fail('collectedAt', 'must be a valid UTC timestamp');
    }
    if (!input.collector || Array.isArray(input.collector) || typeof input.collector !== 'object') fail('collector', 'must be an object');
    if (!input.computer || Array.isArray(input.computer) || typeof input.computer !== 'object') fail('computer', 'must be an object');
    if (input.person !== undefined && (!input.person || Array.isArray(input.person) || typeof input.person !== 'object')) fail('person', 'must be an object');
    if (input.collection != null && (Array.isArray(input.collection) || typeof input.collection !== 'object')) fail('collection', 'must be an object');

    const collector = {
      name: clean(input.collector.name, 'collector.name'),
      version: clean(input.collector.version, 'collector.version')
    };
    const computer = copyFields(input.computer, computerFields, 'computer');
    const person = copyFields(input.person || {}, personFields, 'person');
    const stableSerial = computer.serialNumber && computer.manufacturer && !placeholders.has(computer.serialNumber.toLowerCase());
    const stableHost = computer.hostname && computer.windowsDomain;
    if (!stableSerial && !stableHost) fail('computer', 'must contain a stable computer identity');

    const normalized = {
      computer: Object.fromEntries(Object.entries(computer).map(([key, value]) => [key, Array.isArray(value) ? value.map(item => item.toLowerCase()) : value.toLowerCase()])),
      person: Object.fromEntries(Object.entries(person).map(([key, value]) => [key, value.toLowerCase()]))
    };

    return freeze({
      schema: input.schema,
      collectedAt: input.collectedAt,
      collector,
      collection: input.collection || null,
      person,
      computer,
      normalized
    });
  }

  return Object.freeze({ limits, parseReport });
});
