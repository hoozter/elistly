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
  const textField = (name, label, visibleInCard = false) => ({ name, label, type: 'text', required: false, visibleInCard, partOfName: false });
  const schemaDefinitions = {
    computer: {
      category: { id: 'devices', label: 'Devices', icon: 'devices', visibleInDashboard: true },
      type: {
        id: 'computer', label: 'Computer', category: 'devices', icon: 'computer', enableNameGen: false,
        nameGen: { prefix: '', prefixEnabled: false, partOfNamePrefix: false, suffixType: 'number', componentsOrder: [] },
        fields: [
          textField('hostname', 'Hostname', true), textField('manufacturer', 'Manufacturer', true), textField('model', 'Model', true),
          textField('processorSummary', 'Processor summary'), textField('processorDescription', 'Processor description'), textField('memorySummary', 'Memory', true),
          { ...textField('graphicsAdapters', 'Graphics adapters'), type: 'textarea' }, textField('windowsEdition', 'Windows edition'),
          textField('windowsVersion', 'Windows version'), textField('windowsBuild', 'Windows build'), textField('serialNumber', 'Serial number', true),
          textField('accountName', 'Collected account'), textField('windowsDomain', 'Windows domain/workgroup'), textField('collectedAt', 'Collected at'),
          textField('collectorVersion', 'Collector version')
        ],
        associations: [{ name: 'assignedTo', label: 'Assigned To', type: 'association', required: false, visibleInCard: true, partOfName: false, association: { kind: 'belongs_to', targetType: 'person' } }]
      }
    },
    person: {
      category: { id: 'people', label: 'People', icon: 'group', visibleInDashboard: true },
      type: {
        id: 'person', label: 'Person', category: 'people', icon: 'account_circle', enableNameGen: false,
        nameGen: { prefix: '', prefixEnabled: false, partOfNamePrefix: false, suffixType: 'number', componentsOrder: [] },
        fields: [textField('displayName', 'Display name', true), textField('accountName', 'Account name', true), textField('domain', 'Domain'), textField('upn', 'UPN'), textField('email', 'Email', true), textField('phone', 'Phone'), textField('jobTitle', 'Job title')],
        associations: []
      }
    }
  };

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
      value.forEach((entry, i) => inspect(entry, `${path}[${i}]`, depth + 1, state));
    } else if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        state.fields++;
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
        output[name] = source[name].map((entry, i) => clean(entry, `${path}.${name}[${i}]`));
      } else output[name] = clean(source[name], `${path}.${name}`);
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
    try { input = JSON.parse(text); } catch (_) { throw new Error('Report is not valid JSON.'); }
    if (!input || Array.isArray(input) || typeof input !== 'object') throw new Error('Report root must be an object.');
    inspect(input, '$', 0, { fields: 0 });
    if (!input.schema) throw new Error('schema is required');
    if (input.schema !== 'elistly.device-intake.v1') fail('schema', 'unsupported schema');
    if (typeof input.collectedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.collectedAt) || Number.isNaN(Date.parse(input.collectedAt))) fail('collectedAt', 'must be a valid UTC timestamp');
    for (const part of ['collector', 'person', 'computer']) if (!input[part] || Array.isArray(input[part]) || typeof input[part] !== 'object') fail(part, 'must be an object');
    const collector = { name: clean(input.collector.name, 'collector.name'), version: clean(input.collector.version, 'collector.version') };
    const computer = copyFields(input.computer, computerFields, 'computer');
    const person = copyFields(input.person, personFields, 'person');
    const stableSerial = computer.serialNumber && computer.manufacturer && !placeholders.has(computer.serialNumber.toLowerCase());
    const stableHost = computer.hostname && computer.windowsDomain;
    if (!stableSerial && !stableHost) fail('computer', 'must contain a stable computer identity');
    const normalized = {
      computer: Object.fromEntries(Object.entries(computer).map(([key, value]) => [key, Array.isArray(value) ? value.map(v => v.toLowerCase()) : value.toLowerCase()])),
      person: Object.fromEntries(Object.entries(person).map(([key, value]) => [key, value.toLowerCase()]))
    };
    return freeze({ schema: input.schema, collectedAt: input.collectedAt, collector, collection: input.collection || null, person, computer, normalized });
  }

  function same(value, expected) { return typeof value === 'string' && value.trim().toLowerCase() === expected; }
  function unique(items) { return [...new Map(items.map(item => [item.id, item])).values()]; }
  function fieldsFor(kind, report) {
    const source = report[kind];
    if (kind === 'computer') return {
      name: source.hostname || `${source.manufacturer || ''} ${source.model || ''}`.trim() || 'Imported computer',
      ...source,
      graphicsAdapters: Array.isArray(source.graphicsAdapters) ? source.graphicsAdapters.join('; ') : source.graphicsAdapters,
      collectedAt: report.collectedAt,
      collectorVersion: report.collector.version
    };
    return { name: source.displayName || source.email || `${source.domain || ''}\\${source.accountName || ''}`.replace(/^\\/, '') || 'Imported person', ...source };
  }
  function changes(existing, incoming) {
    return Object.entries(incoming).filter(([key, value]) => existing?.[key] !== value).map(([field, after]) => freeze({ field, before: existing?.[field], after }));
  }
  function fieldPreview(existing, incoming) {
    if (!existing) return Object.entries(incoming).map(([field, after]) => freeze({ field, before: undefined, after, disposition: 'added' }));
    const result = Object.entries(incoming).map(([field, after]) => freeze({
      field, before: existing[field], after,
      disposition: existing[field] === undefined ? 'added' : existing[field] === after ? 'unchanged' : 'overwritten'
    }));
    for (const [field, before] of Object.entries(existing)) {
      if (!Object.prototype.hasOwnProperty.call(incoming, field)) result.push(freeze({ field, before, after: before, disposition: 'retained' }));
    }
    return result;
  }
  function createSchemaChanges(data) {
    const changes = { categories: [], entityTypes: [] };
    const categories = data?.categories || {};
    const types = data?.entityTypes || {};
    for (const kind of ['computer', 'person']) {
      const definition = schemaDefinitions[kind];
      if (!categories[definition.category.id]) changes.categories.push({ id: definition.category.id, definition: JSON.parse(JSON.stringify(definition.category)) });
      const existing = types[kind];
      if (!existing) {
        changes.entityTypes.push({ id: kind, action: 'add type', definition: JSON.parse(JSON.stringify(definition.type)), fields: definition.type.fields.map(field => field.name), associations: definition.type.associations.map(item => item.name) });
        continue;
      }
      const existingFields = new Map((existing.fields || []).map(field => [field.name, field]));
      const fields = definition.type.fields.filter(field => {
        const current = existingFields.get(field.name);
        if (current && current.type !== field.type) fail(`entityTypes.${kind}.fields.${field.name}`, `has incompatible type ${current.type}`);
        return !current;
      });
      const existingAssociations = new Map((existing.associations || []).map(item => [item.name, item]));
      const associations = definition.type.associations.filter(item => {
        const current = existingAssociations.get(item.name);
        if (current && (current.type !== 'association' || current.association?.targetType !== item.association.targetType)) fail(`entityTypes.${kind}.associations.${item.name}`, 'has an incompatible association');
        return !current;
      });
      if (fields.length || associations.length) changes.entityTypes.push({ id: kind, action: 'add fields', fields: JSON.parse(JSON.stringify(fields)), associations: JSON.parse(JSON.stringify(associations)) });
    }
    return freeze(changes);
  }
  function createPlan(report, data) {
    const entities = Object.values(data?.entities || {});
    const computers = entities.filter(entity => entity?.type === 'computer');
    const people = entities.filter(entity => entity?.type === 'person');
    const serialMatches = report.normalized.computer.serialNumber && !placeholders.has(report.normalized.computer.serialNumber) && report.normalized.computer.manufacturer
      ? computers.filter(entity => same(entity.serialNumber, report.normalized.computer.serialNumber) && same(entity.manufacturer, report.normalized.computer.manufacturer)) : [];
    const hostMatches = report.normalized.computer.hostname && report.normalized.computer.windowsDomain
      ? computers.filter(entity => same(entity.hostname, report.normalized.computer.hostname) && same(entity.windowsDomain, report.normalized.computer.windowsDomain)) : [];
    const computerCandidates = unique([...serialMatches, ...hostMatches]);
    const emailMatches = report.normalized.person.email ? people.filter(entity => same(entity.email, report.normalized.person.email)) : [];
    const upnMatches = report.normalized.person.upn ? people.filter(entity => same(entity.upn, report.normalized.person.upn)) : [];
    const accountMatches = report.normalized.person.accountName && report.normalized.person.domain
      ? people.filter(entity => same(entity.accountName, report.normalized.person.accountName) && same(entity.domain, report.normalized.person.domain)) : [];
    const personCandidates = unique([...emailMatches, ...upnMatches, ...accountMatches]);
    const part = (kind, candidates, incoming, present) => {
      if (!present) return freeze({ status: 'skip', candidates: [], changes: [] });
      const status = candidates.length > 1 ? 'conflict' : candidates.length === 1 ? 'update' : 'create';
      const matchId = candidates.length === 1 ? candidates[0].id : undefined;
      return freeze({ status, matchId, candidates: candidates.map(entity => freeze({ id: entity.id, name: entity.name || entity.id, fieldPreview: fieldPreview(entity, incoming) })), fields: incoming, fieldPreview: fieldPreview(candidates[0], incoming), changes: changes(candidates[0], incoming) });
    };
    const computerIncoming = fieldsFor('computer', report);
    const personIncoming = fieldsFor('person', report);
    return freeze({
      report,
      schemaChanges: createSchemaChanges(data),
      computer: part('computer', computerCandidates, computerIncoming, true),
      person: part('person', personCandidates, personIncoming, Object.keys(report.person).length > 0)
    });
  }
  function chosenId(part, choice, kind) {
    if (part.status === 'skip') return null;
    if (part.status === 'conflict') {
      if (choice === 'create') return null;
      if (!part.candidates.some(candidate => candidate.id === choice)) throw new Error(`${kind} conflict requires an explicit choice.`);
      return choice;
    }
    return part.matchId || null;
  }
  function availableId(entities, prefix) {
    let id = prefix;
    let suffix = 2;
    while (Object.prototype.hasOwnProperty.call(entities, id)) id = `${prefix}-${suffix++}`;
    return id;
  }
  function materializePlan(plan, data, choices) {
    const candidate = JSON.parse(JSON.stringify(data));
    candidate.categories = candidate.categories || {};
    candidate.entityTypes = candidate.entityTypes || {};
    candidate.entities = candidate.entities || {};
    for (const change of plan.schemaChanges.categories) candidate.categories[change.id] = JSON.parse(JSON.stringify(change.definition));
    for (const change of plan.schemaChanges.entityTypes) {
      if (change.action === 'add type') candidate.entityTypes[change.id] = JSON.parse(JSON.stringify(change.definition));
      else {
        const type = candidate.entityTypes[change.id];
        type.fields = [...(type.fields || []), ...JSON.parse(JSON.stringify(change.fields))];
        type.associations = [...(type.associations || []), ...JSON.parse(JSON.stringify(change.associations))];
      }
    }
    const personExisting = chosenId(plan.person, choices?.person, 'Person');
    let personId = personExisting;
    if (plan.person.status !== 'skip') {
      personId = personExisting || availableId(candidate.entities, `person-${plan.report.collectedAt.slice(0, 10)}`);
      candidate.entities[personId] = { ...(candidate.entities[personId] || {}), id: personId, type: 'person', ...plan.person.fields };
    }
    const computerExisting = chosenId(plan.computer, choices?.computer, 'Computer');
    const computerId = computerExisting || availableId(candidate.entities, `computer-${plan.report.computer.hostname?.toLowerCase().replace(/[^a-z0-9]+/g, '-') || plan.report.collectedAt.slice(0, 10)}`);
    candidate.entities[computerId] = { ...(candidate.entities[computerId] || {}), id: computerId, type: 'computer', ...plan.computer.fields };
    if (personId) candidate.entities[computerId].assignedTo = personId;
    if (candidate.workspaces && candidate.currentWorkspaceId && candidate.workspaces[candidate.currentWorkspaceId]) {
      candidate.workspaces[candidate.currentWorkspaceId].categories = JSON.parse(JSON.stringify(candidate.categories));
      candidate.workspaces[candidate.currentWorkspaceId].entityTypes = JSON.parse(JSON.stringify(candidate.entityTypes));
      candidate.workspaces[candidate.currentWorkspaceId].entities = JSON.parse(JSON.stringify(candidate.entities));
    }
    return candidate;
  }

  return Object.freeze({ limits, parseReport, createPlan, materializePlan });
});
