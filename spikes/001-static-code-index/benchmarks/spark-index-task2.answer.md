Key findings (source-backed):

1. Device intake injects a fixed `computer`/`person` schema with `visibleInCard` defaults baked into the definitions.
- `device-intake.js:10`, `device-intake.js:13`, `device-intake.js:19`, `device-intake.js:20`, `device-intake.js:35` show the definitions and that imported fields like `hostname`, `serialNumber`, `displayName`, `accountName`, `email` are present, with `visibleInCard: true` for the identity fields.

2. Additive schema updates are computed during plan creation and only fail for incompatible same-name definitions.
- `device-intake.js:130-157`: category/type diffing.
- `device-intake.js:138-140`: missing type => `add type` (full type + fields).
- `device-intake.js:142-147`: same-name field exists but type mismatch => `fail(... 'incompatible type ...')`.
- `device-intake.js:149-152`: same-name association mismatch (kind/targetType) => `fail(... 'has an incompatible association')`.
- `device-intake.js:154-155`: missing fields/associations are appended as additive changes.

3. Blank/custom workspaces vs existing IT workspaces.
- Current active workspace is loaded from `workspaces[currentWorkspaceId]` at startup; if no workspace metadata exists, legacy root data is wrapped into default workspace.  
  - `app.js:505-513`, `app.js:522-531`
- Therefore, import plan/schema checks run against whatever schema exists in the active workspace (IT workspace if that’s the one selected, or blank/custom if user-created minimal schema).  
  - `app.js:7231-7273`, `app.js:7271`
- `createPlan` includes `schemaChanges`; blank/custom workspaces get `add type` for missing `computer`/`person`, while IT workspaces get only missing fields/associations or no schema changes if already aligned.  
  - `device-intake.js:182-184`, `device-intake.js:158-157`

4. Active-workspace persistence is explicit and tied to the current workspace id.
- Import candidate materialization writes merged schema/entities into the active workspace object before persistence:  
  - `device-intake.js:226-229`
- Import commit writes the candidate via import-specific persistence (not regular `saveData`) and preserves/validates cache identity.  
  - `app.js:304-330`, `app.js:7358-7360`
- General workspace writes also keep active workspace serialized into `workspaces[currentWorkspaceId]`.  
  - `app.js:1230-1237`
- App load/reload uses stored `currentWorkspaceId` and swaps in that workspace’s categories/entityTypes/entities.  
  - `app.js:505-513`

5. Explicit collision handling is required for identity conflicts (not silently resolved).
- Match logic marks status as `conflict` when more than one candidate is found.  
  - `device-intake.js:174`, `device-intake.js:176-177`
- UI blocks confirm until user choice is made for each conflicted part.  
  - `app.js:7303-7315`, `app.js:7340-7343`
- Backend-side materialization rejects unresolved/wrong conflict choices with explicit error (`...explicit choice...`).  
  - `device-intake.js:189-193`
- Tests assert unresolved conflict throws and explicit-choice behavior.  
  - `tests/device-intake-core.test.js:69`, `tests/device-intake-core.test.js:70-78`

6. Imported fields become visible and editable in the normal entity flow.
- Dashboard/card rendering uses `visibleInCard` to show fields in summaries.  
  - `app.js:1512-1515`, `app.js:1542-1545`
- Entity form/view rendering iterates all fields from type (not filtered by `visibleInCard`) for normal detail/edit UI.  
  - `app.js:3783-3799`, `app.js:3830`, `app.js:3870`
- Submitting entity form persists edited values from all form fields.  
  - `app.js:3981-3994`, `app.js:4020-4027`
- Browser test confirms imported fields like `Hostname` and `Serial number` are shown in normal entity view after confirm import.  
  - `tests/device-intake-browser.test.js:50-53`

Uncertainty:
- I did not inspect the preset payload files themselves (`blank`/`it` setup JSON), so I infer “blank/custom” and “IT” workspace differences from runtime schema state (`workspaces[currentWorkspaceId]`) rather than from preset definitions directly.
