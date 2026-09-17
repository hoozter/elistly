const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'neon/schema.sql'), 'utf8');
const migrationNotes = fs.readFileSync(path.join(root, 'NEON_MIGRATION.md'), 'utf8');

assert.match(schema, /payload\s+jsonb\s+not null/i, 'the canonical app-data payload column is required');
assert.doesNotMatch(schema, /column_name\s*=\s*'data'|rename column data|set payload = data/i, 'schema setup must not retain the retired app_data.data migration path');
assert.doesNotMatch(schema, /table_name = 'profiles' and column_name = 'id'|rename column id to user_id/i, 'schema setup must not retain the retired profiles.id migration path');
assert.doesNotMatch(migrationNotes, /app_data\.data|renaming or copying/i, 'architecture notes must not document the retired app_data.data migration path');

console.log('PASS canonical Neon app-data schema contract');
