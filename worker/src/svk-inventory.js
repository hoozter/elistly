// Offline observations are immutable receipts, independent of editable app JSON.
import { createImportedComputer } from './computer-import.js';
export class InventoryError extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}
const fail = message => { throw new InventoryError(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
function exact(value, keys, label) {
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(`${label}: unexpected or missing fields`);
}
function text(value, label, required = false) {
  if (value === null && !required) return;
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label}: expected a nonempty string of at most 256 characters`);
}
function integer(value, label) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) fail(`${label}: expected a non-negative safe integer or null`);
}
function stable(value) {
  return typeof value === 'string' && value.trim() && !/^(?:n\/?a|not applicable|not available|not specified|to be filled by o\.?e\.?m\.?|default string|none|unknown|system serial number|oem|invalid|undefined|null)$/i.test(value.trim()) && !/^(?:0+|f+)$/i.test(value.replace(/[-{}\s]/g, ''));
}
export function timestampKey(value) {
  const match = typeof value === 'string' && /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,7}))?Z$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 19) !== match[1]) fail('Invalid UTC collection timestamp');
  return match[1] + '.' + (match[2] || '').padEnd(7, '0') + 'Z';
}
function bounded(value, depth = 0) {
  if (depth > 8) fail('Report nesting exceeds 8 levels');
  if (typeof value === 'string' && value.length > 512) fail('Report string is too long');
  if (Array.isArray(value) && value.length > 32) fail('Report array is too long');
  if (object(value) || Array.isArray(value)) for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('Unsafe object key');
    bounded(item, depth + 1);
  }
}
export async function validateSvkReport(raw, now = Date.now()) {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 65536) fail('Report exceeds 64 KiB');
  let r;
  try { r = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { fail('Invalid JSON report'); }
  bounded(r);
  exact(r, ['schema','reportId','collectedAt','collector','collection','hardwareIdentity','identityStatus','hostname','serialNumber','manufacturer','model','windowsEdition','inventorySnapshot','provisioning'], 'Report');
  if (r.schema !== 'svk.device-inventory.v1') fail('Unsupported report schema');
  if (!uuid.test(r.reportId) || !stable(r.reportId)) fail('Invalid reportId UUID');
  const collectedKey = timestampKey(r.collectedAt);
  if (collectedKey > timestampKey(new Date(now).toISOString())) fail('Future collection time requires review');
  exact(r.collector, ['name','formatVersion','provisionVersion'], 'collector');
  text(r.collector.name, 'collector.name', true); text(r.collector.provisionVersion, 'collector.provisionVersion', true);
  if (r.collector.formatVersion !== 1) fail('Unsupported collector formatVersion');
  exact(r.collection, ['context','mode','networkUsed','userObservation','unavailable'], 'collection');
  if (!['installation','service'].includes(r.collection.context) || r.collection.mode !== 'local-file' || r.collection.networkUsed !== false || r.collection.userObservation !== 'not-collected') fail('Contradictory collection metadata');
  if (!Array.isArray(r.collection.unavailable) || r.collection.unavailable.length > 32) fail('Invalid unavailable list');
  r.collection.unavailable.forEach(v => text(v, 'unavailable', true));
  for (const key of ['hostname','serialNumber','manufacturer','model','windowsEdition']) text(r[key], key, key === 'hostname');
  const s = r.inventorySnapshot;
  exact(s, ['schemaVersion','collectedAt','device','windows','cpu','ramBytes','graphicsAdapters','biosVersion','lastInteractiveUser'], 'inventorySnapshot');
  if (s.schemaVersion !== 'svk.windows-installation-snapshot.v1') fail('Unsupported snapshot schema');
  if (timestampKey(s.collectedAt) !== collectedKey) fail('Collection timestamps disagree');
  exact(s.device, ['manufacturer','model','serialNumber','uuid'], 'device');
  exact(s.windows, ['edition','version','build'], 'windows');
  exact(s.cpu, ['model','cores','logicalProcessors'], 'cpu');
  for (const [key, value] of Object.entries(s.device)) text(value, `device.${key}`);
  for (const [key, value] of Object.entries(s.windows)) text(value, `windows.${key}`);
  text(s.cpu.model, 'cpu.model'); text(s.biosVersion, 'biosVersion');
  integer(s.cpu.cores, 'cpu.cores'); integer(s.cpu.logicalProcessors, 'cpu.logicalProcessors'); integer(s.ramBytes, 'ramBytes');
  if (s.cpu.cores !== null && s.cpu.logicalProcessors !== null && s.cpu.cores > s.cpu.logicalProcessors) fail('Contradictory processor counts');
  if (!Array.isArray(s.graphicsAdapters) || s.graphicsAdapters.length > 8) fail('At most 8 graphics adapters are allowed');
  s.graphicsAdapters.forEach(v => text(v, 'graphicsAdapters'));
  if (s.lastInteractiveUser !== null) fail('User identity must not be collected');
  for (const key of ['manufacturer','model','serialNumber']) if (r[key] !== s.device[key]) fail(`${key}: envelope and snapshot disagree`);
  if (r.windowsEdition !== s.windows.edition) fail('Windows edition fields disagree');
  exact(r.provisioning, ['coreVerified','phase','finished'], 'provisioning');
  if (typeof r.provisioning.coreVerified !== 'boolean' || r.provisioning.finished !== null || r.provisioning.phase !== (r.collection.context === 'installation' ? 'before-finish-cleanup' : 'service-observation')) fail('Contradictory provisioning metadata');
  if (r.identityStatus !== 'stable' || !stable(r.serialNumber) || !stable(s.device.uuid) || !uuid.test(s.device.uuid?.trim()) || !/^[a-f0-9]{64}$/.test(r.hardwareIdentity)) fail('Missing, generic or invalid hardware identity requires review');
  if (await digest(s.device.uuid.trim() + '|' + r.serialNumber.trim()) !== r.hardwareIdentity) fail('Hardware identity hash does not match trimmed UUID|serial');
  return {report:r, digest:await digest(canonicalJson(r)), reportId:r.reportId.toLowerCase(), collectedKey, serialKey:r.serialNumber.trim().toLowerCase(), uuidKey:s.device.uuid.trim().toLowerCase()};
}
function sameObservation(a, b) {
  const facts = r => ({hostname:r.hostname, snapshot:{...r.inventorySnapshot, collectedAt:timestampKey(r.inventorySnapshot.collectedAt)}});
  return canonicalJson(facts(a)) === canonicalJson(facts(b));
}
export function planSvkImport(payload, workspaceId, validated, history) {
  const workspace = Object.hasOwn(payload?.workspaces || {}, workspaceId) && payload.workspaces[workspaceId];
  if (!object(workspace?.entities) || !object(workspace?.entityTypes?.computer)) fail('Workspace requires a Computer entity type');
  const {report:r, serialKey, uuidKey, collectedKey} = validated;
  const matches = new Set();
  let deletedDeviceId;
  for (const row of history) {
    if (row.hardware_identity !== r.hardwareIdentity) fail('Identity normalization mismatch or hardware collision requires review');
    if (timestampKey(row.report.collectedAt) === collectedKey && !sameObservation(row.report, r)) fail('Contradictory reports at the same collection time require review');
    const e = workspace.entities[row.device_id];
    if (!e) {
      if (deletedDeviceId && deletedDeviceId !== row.device_id) fail('Multiple deleted matching devices require review');
      deletedDeviceId = row.device_id;
      continue;
    }
    if (e.type !== 'computer') fail('Previously imported device has an incompatible type; review required');
    matches.add(row.device_id);
  }
  for (const [id, entity] of Object.entries(workspace.entities)) {
    if (!object(entity) || entity.type !== 'computer') continue;
    const reg = entity._elistlyRegistration;
    const serials = [entity.serialNumber, reg?.inventorySnapshot?.device?.serialNumber];
    const sameSerial = serials.some(v => typeof v === 'string' && v.trim().toLowerCase() === serialKey);
    const sameUuid = reg?.inventorySnapshot?.device?.uuid?.trim().toLowerCase() === uuidKey;
    if (reg?.hardwareIdentity === r.hardwareIdentity) {
      // Online collectors have a different snapshot contract; equal-time SVK facts
      // need explicit review rather than pretending the snapshots are equivalent.
      if (reg.inventorySnapshot?.collectedAt && timestampKey(reg.inventorySnapshot.collectedAt) === collectedKey) fail('Online and offline observations at the same collection time require review');
      matches.add(id);
    } else if ((sameSerial || sameUuid) && !matches.has(id)) fail('Manual serial collision or legacy identity mismatch requires review');
  }
  if (matches.size > 1) fail('Multiple matching devices require review');
  if (deletedDeviceId && matches.size) fail('Deleted historical device conflicts with a live device; review required');
  const deviceId = [...matches][0] || deletedDeviceId || `device_${crypto.randomUUID()}`;
  const next = structuredClone(payload);
  if (!matches.size) {
    const entity = createImportedComputer({id:deviceId, entityType:workspace.entityTypes.computer, entities:workspace.entities, report:r});

    next.workspaces[workspaceId].entities[deviceId] = entity;
    if (next.currentWorkspaceId === workspaceId) next.entities = {...next.workspaces[workspaceId].entities};
  }
  return {payload:next, deviceId, disposition:deletedDeviceId ? 'Restore deleted device' : matches.size ? 'Update observations' : 'New'};
}

async function receipt(sql, owner, workspace, id) {
  const rows = await sql`SELECT report_id, content_digest, report, device_id, imported_at::text AS imported_at
    FROM inventory_import_reports WHERE owner_user_id = ${owner} AND workspace_id = ${workspace} AND report_id = ${id}`;
  return rows[0];
}
async function verifiedReceipt(row, v) {
  return row && row.content_digest === v.digest && await digest(canonicalJson(row.report)) === v.digest;
}
export async function importSvkFile(sql, owner, workspace, file, preview) {
  const v = await validateSvkReport(file.content);
  // A bounded CAS retry handles concurrent imports and ordinary app saves.
  for (let attempt = 0; attempt < 3; attempt++) {
    const [current] = await sql`SELECT payload, updated_at::text AS updated_at FROM app_data WHERE user_id = ${owner}`;
    if (!Object.hasOwn(current?.payload?.workspaces || {}, workspace)) throw new InventoryError('Workspace not found', 404);
    const saved = await receipt(sql, owner, workspace, v.reportId);
    if (saved) {
      if (!await verifiedReceipt(saved, v)) fail('Report ID already exists with different content; keep this file for review');
      const entity = current.payload.workspaces[workspace].entities?.[saved.device_id];
      if (entity?.type === 'computer') return {safe:!preview, disposition:'Already imported', deviceId:saved.device_id, importedAt:saved.imported_at, reportId:v.reportId, digest:v.digest, hostname:v.report.hostname, collectedAt:v.report.collectedAt, context:v.report.collection.context, identity:v.report.hardwareIdentity};
    }
    const history = await sql`SELECT DISTINCT ON (device_id) device_id, hardware_identity, report
      FROM inventory_import_reports WHERE owner_user_id = ${owner} AND workspace_id = ${workspace}
      AND (hardware_identity = ${v.report.hardwareIdentity} OR serial_key = ${v.serialKey} OR uuid_key = ${v.uuidKey})
      ORDER BY device_id, (collected_key = ${v.collectedKey}) DESC, collected_key DESC LIMIT 101`;
    if (history.length > 100) fail('Too many identity matches; review required');
    const plan = planSvkImport(current.payload, workspace, v, history);
    if (preview) return {safe:false, disposition:plan.disposition, hostname:v.report.hostname, collectedAt:v.report.collectedAt, context:v.report.collection.context, identity:v.report.hardwareIdentity};
    if (new TextEncoder().encode(JSON.stringify(plan.payload)).length > 4 * 1024 * 1024) fail('Account inventory is too large to import safely');
    // The app_data CAS serializes restoration and identity matching across imports.
    // Existing immutable receipts are retained while their deleted device is restored.
    if (saved) {
      const restored = await sql`UPDATE app_data SET payload = ${JSON.stringify(plan.payload)}::jsonb, updated_at = clock_timestamp()
        WHERE user_id = ${owner} AND updated_at = ${current.updated_at}::timestamptz RETURNING user_id`;
      if (!restored.length) continue;
      const readback = await receipt(sql, owner, workspace, v.reportId);
      if (!await verifiedReceipt(readback, v) || readback.device_id !== plan.deviceId) fail('Save could not be verified; retry this file before archiving');
      return {safe:true, disposition:plan.disposition, deviceId:readback.device_id, importedAt:readback.imported_at, reportId:v.reportId, digest:v.digest};
    }
    // One SQL statement commits a new revision and immutable receipt together.
    const inserted = await sql`WITH saved AS (
      UPDATE app_data SET payload = ${JSON.stringify(plan.payload)}::jsonb, updated_at = clock_timestamp()
      WHERE user_id = ${owner} AND updated_at = ${current.updated_at}::timestamptz RETURNING user_id
    ) INSERT INTO inventory_import_reports
      (owner_user_id, workspace_id, report_id, content_digest, hardware_identity, serial_key, uuid_key, collected_key, device_id, report)
      SELECT user_id, ${workspace}, ${v.reportId}, ${v.digest}, ${v.report.hardwareIdentity}, ${v.serialKey}, ${v.uuidKey}, ${v.collectedKey}, ${plan.deviceId}, ${JSON.stringify(v.report)}::jsonb
      FROM saved RETURNING report_id`;
    if (!inserted.length) continue;
    const readback = await receipt(sql, owner, workspace, v.reportId);
    if (!await verifiedReceipt(readback, v) || readback.device_id !== plan.deviceId) fail('Save could not be verified; retry this file before archiving');
    return {safe:true, disposition:plan.disposition, deviceId:readback.device_id, importedAt:readback.imported_at, reportId:v.reportId, digest:v.digest};
  }
  fail('Inventory changed during import; retry this file');
}
export async function importSvkBatch(sql, owner, body) {
  exact(body, ['workspaceId','preview','files'], 'Import');
  if (typeof body.workspaceId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.workspaceId) || typeof body.preview !== 'boolean') fail('Invalid workspace or preview flag');
  if (!Array.isArray(body.files) || !body.files.length || body.files.length > 10) fail('Choose 1–10 files per request');
  if (new TextEncoder().encode(JSON.stringify(body)).length > 1024 * 1024) fail('Batch exceeds 1 MiB');
  const [account] = await sql`SELECT payload FROM app_data WHERE user_id = ${owner}`;
  if (!Object.hasOwn(account?.payload?.workspaces || {}, body.workspaceId)) throw new InventoryError('Workspace not found', 404);
  const results = [];
  for (const file of body.files) {
    const result = {filename:typeof file?.filename === 'string' ? file.filename.slice(0,512) : '(invalid filename)', safe:false};
    try {
      exact(file, ['filename','content'], 'File');
      if (typeof file.filename !== 'string' || !file.filename || file.filename.length > 512 || file.filename.split('/').length > 8 || /[\u0000-\u001f\u007f]/.test(file.filename) || file.filename.split('/').some(p => p === '..' || p === '.' || !p)) fail('Invalid relative filename or folder depth');
      if (/\.pending$/i.test(file.filename)) fail('Incomplete .pending file ignored; keep until collection is complete');
      if (!/\.json$/i.test(file.filename)) fail('Skipped: only completed JSON reports are eligible');
      Object.assign(result, await importSvkFile(sql, owner, body.workspaceId, file, body.preview));
    } catch (error) {
      result.reason = error instanceof InventoryError ? error.message : 'Save or readback failed; retry to confirm whether this report was saved';
      result.disposition = 'Needs attention';
    }
    results.push(result);
  }
  return {results};
}
