function formatRam(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)} ${units[unit]}`;
}

function processorDescription(cpu) {
  if (!cpu?.model) return null;
  const counts = [];
  if (Number.isSafeInteger(cpu.cores)) counts.push(`${cpu.cores} cores`);
  if (Number.isSafeInteger(cpu.logicalProcessors)) counts.push(`${cpu.logicalProcessors} logical processors`);
  return counts.length ? `${cpu.model}; ${counts.join('; ')}` : cpu.model;
}

function dropdownKey(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\((?:r|tm)\)/g, '').replace(/[^a-z0-9]+/g, '');
}

function processorFamilyKey(value, exact = false) {
  const key = dropdownKey(value);
  for (const [prefix, pattern] of [['intelcoreultra', /intelcoreultra([579])/], ['intelcoreultra', /intelcore([579])ultra/], ['intelcore', /intelcore(i[3579])/], ['amdryzen', /amdryzen([3579])/]]) {
    const match = key.match(exact ? new RegExp(`^${pattern.source}$`) : pattern);
    if (match) return `${prefix}${match[1]}`;
  }
  return null;
}

function compatibleValue(field, value, supportedTypes, processor = false, memory = false) {
  if (!supportedTypes.includes(field.type)) return null;
  if (field.type !== 'dropdown') return value;
  const options = Array.isArray(field.options) ? field.options : [];
  let matches = options.filter(option => dropdownKey(typeof option === 'object' && option !== null ? option.value : option) === dropdownKey(value));
  if (!matches.length && processor) {
    const family = processorFamilyKey(value);
    matches = options.filter(option => family && processorFamilyKey(typeof option === 'object' && option !== null ? option.value : option, true) === family);
  }
  // Windows reports usable memory; choose a nominal GB option only when it is
  // unambiguously within ten percent of the measured capacity.
  if (!matches.length && memory) {
    const memoryBytes = memory => {
      const match = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)$/i.exec(String(memory).trim());
      const units = {B:0, KB:1, MB:2, GB:3, TB:4};
      return match ? Number(match[1]) * (1024 ** units[match[2].toUpperCase()]) : null;
    };
    const measured = memoryBytes(value);
    const candidates = options.map(option => {
      const optionValue = typeof option === 'object' && option !== null ? option.value : option;
      const nominal = memoryBytes(optionValue);
      return { option, nominal, difference: Math.abs(nominal - measured) };
    }).filter(candidate => Number.isFinite(measured) && Number.isFinite(candidate.nominal) && candidate.nominal > 0 && candidate.difference / candidate.nominal <= 0.1);
    const nearest = candidates.sort((a, b) => a.difference - b.difference);
    if (nearest.length === 1 || (nearest.length > 1 && nearest[0].difference < nearest[1].difference)) matches = [nearest[0].option];
  }
  if (matches.length !== 1) return null;
  const match = matches[0];
  return typeof match === 'object' && match !== null ? match.value : match;
}

const knownItWindowsFields = {
  hostname: ['Hostname', 'computer.hostname'],
  manufacturer: ['Manufacturer', 'computer.manufacturer'],
  model: ['Model', 'computer.model'],
  cpu: ['CPU', 'processor.summary'],
  processorDescription: ['Processor details', 'processor.description'],
  ram: ['RAM', 'memory.total'],
  graphicsAdapters: ['Graphics adapters', 'graphics.adapters'],
  windowsEdition: ['Windows edition', 'windows.edition'],
  windowsVersion: ['Windows version', 'windows.version'],
  windowsBuild: ['Windows build', 'windows.build'],
  serialNumber: ['Serial number', 'bios.serial-number'],
};

export function migrateKnownItWindowsSchema(entityType, report) {
  if (!entityType?.presetIds?.includes('it')) return false;
  let changed = false;
  for (const [name, [label, capability]] of Object.entries(knownItWindowsFields)) {
    const field = entityType.fields?.find(candidate => candidate?.name === name && candidate.label === label);
    if (field && !field.collection) { field.collection = {provider:'windows', capability}; changed = true; }
  }
  const cpu = entityType.fields?.find(field => field?.name === 'cpu' && field.label === 'CPU' && field.type === 'dropdown');
  if (/Intel\(R\) Core\(TM\) Ultra 5\b/i.test(report.inventorySnapshot?.cpu?.model || '') && cpu && !cpu.options?.some(option => processorFamilyKey(typeof option === 'object' && option !== null ? option.value : option, true) === 'intelcoreultra5')) {
    cpu.options = [...(Array.isArray(cpu.options) ? cpu.options : []), {value:'Intel Core Ultra 5',nameValue:'5U'}];
    changed = true;
  }
  return changed;
}

export function projectWindowsComputerFields(entity, entityType, report, { capabilities = null, overwrite = true } = {}) {
  const snapshot = report.inventorySnapshot;
  const facts = {
    'computer.hostname': { value: report.hostname, supportedTypes: ['text', 'textarea'] },
    'computer.manufacturer': { value: report.manufacturer, supportedTypes: ['text', 'textarea'] },
    'computer.model': { value: report.model, supportedTypes: ['text', 'textarea'] },
    'processor.summary': { value: snapshot.cpu?.model, supportedTypes: ['text', 'textarea', 'dropdown'], processor: true },
    'processor.description': { value: processorDescription(snapshot.cpu), supportedTypes: ['text', 'textarea'] },
    'memory.total': { value: formatRam(snapshot.ramBytes), supportedTypes: ['text', 'textarea', 'dropdown'], memory: true },
    'graphics.adapters': { value: Array.isArray(snapshot.graphicsAdapters) && snapshot.graphicsAdapters.length ? snapshot.graphicsAdapters.join('; ') : null, supportedTypes: ['text', 'textarea'] },
    'windows.edition': { value: report.windowsEdition ?? snapshot.windows?.edition, supportedTypes: ['text', 'textarea', 'dropdown'] },
    'windows.version': { value: snapshot.windows?.version, supportedTypes: ['text', 'textarea'] },
    'windows.build': { value: snapshot.windows?.build, supportedTypes: ['text', 'textarea'] },
    'bios.serial-number': { value: report.serialNumber, supportedTypes: ['text', 'textarea'] },
  };
  for (const [capability, { value, supportedTypes, processor, memory }] of Object.entries(facts)) {
    if (capabilities && !capabilities.has(capability)) continue;
    if (typeof value !== 'string' || !value.trim()) continue;
    const fields = (entityType.fields || []).filter(field => field?.collection?.provider === 'windows' && field.collection.capability === capability);
    if (fields.length !== 1) continue;
    const compatible = compatibleValue(fields[0], value, supportedTypes, processor, memory);
    if (compatible !== null && (overwrite || entity[fields[0].name] == null || entity[fields[0].name] === '')) entity[fields[0].name] = compatible;
  }
}

function buildAutoNameBase(entityType, data) {
  if (!entityType?.enableNameGen) return '';
  const prefix = entityType.nameGen?.prefixEnabled !== false ? (entityType.nameGen?.prefix || '') : '';
  const fields = Array.isArray(entityType.fields) ? entityType.fields : [];
  const fieldMap = new Map(fields.map(field => [field.name, field]));
  const configured = Array.isArray(entityType.nameGen?.componentsOrder) ? entityType.nameGen.componentsOrder : [];
  const components = configured.length ? configured : fields.filter(field => field.partOfName).map(field => ({ type: 'field', name: field.name }));
  const parts = [];
  let pendingSeparator = null;
  for (const component of components) {
    const fieldName = typeof component === 'string' ? component : component?.type === 'field' ? component.name : null;
    if (component?.type === 'separator') { pendingSeparator = component.value != null ? String(component.value) : ''; continue; }
    const field = fieldMap.get(fieldName);
    if (!field || !field.partOfName) continue;
    const value = data[field.name];
    if (!value) continue;
    if (parts.length && pendingSeparator != null) parts.push(pendingSeparator);
    pendingSeparator = null;
    const option = field.options?.find(option => (typeof option === 'object' && option !== null ? option.value : option) === value);
    parts.push(typeof option === 'object' && option?.nameValue ? option.nameValue : value);
  }
  return prefix + parts.join('');
}

function generatedComputerName(entityType, entity, entities) {
  const base = buildAutoNameBase(entityType, entity);
  if (!base) return '';
  const sameBase = Object.values(entities || {}).filter(candidate => candidate?.type === 'computer' && candidate.id !== entity.id && buildAutoNameBase(entityType, candidate) === base);
  if (!sameBase.length) return base;
  if (entityType.nameGen?.suffixType === 'letter') {
    for (let code = 65; code <= 90; code += 1) {
      const candidate = `${base}${String.fromCharCode(code)}`;
      if (!sameBase.some(entity => entity.autoName === candidate)) return candidate;
    }
    return `${base}Z`;
  }
  let suffix = 1;
  while (sameBase.some(candidate => candidate.autoName === `${base}${String(suffix).padStart(2, '0')}`)) suffix += 1;
  return `${base}${String(suffix).padStart(2, '0')}`;
}

// New and restored SVK Computers use this single projection before the normal save/CAS path.
export function createImportedComputer({ id, entityType, entities, report }) {
  const entity = { id, type: 'computer', name: report.hostname, hostname: report.hostname };
  for (const field of ['serialNumber', 'manufacturer', 'model', 'windowsEdition']) if (report[field] !== null) entity[field] = report[field];
  projectWindowsComputerFields(entity, entityType, report);
  if (entityType.enableNameGen) {
    entity.autoName = generatedComputerName(entityType, entity, entities);
    delete entity.name;
  }
  return entity;
}

// Receipts can outlive a projection fix. Fill only absent generated fields, and
// regenerate a title only when it is still exactly the old generated title.
export function repairImportedComputer({ entity, entityType, entities, report }) {
  if (entity?.type !== 'computer') return false;
  const generatedBefore = entityType.enableNameGen && entity.autoName === generatedComputerName(entityType, entity, entities);
  const before = structuredClone(entity);
  projectWindowsComputerFields(entity, entityType, report, { overwrite: false });
  if (generatedBefore) entity.autoName = generatedComputerName(entityType, entity, entities);
  return JSON.stringify(before) !== JSON.stringify(entity);
}
