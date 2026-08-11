Here’s what the code currently does.

1. Device Intake only accepts the v1 schema and materializes missing schema additively.  
   `parseReport()` rejects anything except `elistly.device-intake.v1` and required top-level object/field shape, then `createPlan()` calls `createSchemaChanges()` using the current in-memory data shape (`data`, not globals).  
   - [device-intake.js:86](/home/campbell/Projects/Elistly-spike-static-index/device-intake.js#L86)  
   - [device-intake.js:130](/home/campbell/Projects/Elistly-spike-static-index/device-intake.js#L130)  
   - [device-intake.js:134](/home/campbell/Projects/Elistly-spike-static-index/device-intake.js#L134)

2. Additive behavior is by definition: add missing category/type, then add only missing fields/associations when type already exists.  
   - Missing category/type in a workspace gets `categories`/`entityTypes` add-entries.  
   - Existing type gets only missing fields/associations appended; no deletion/replacement.  
   - [device-intake.js:136](/home/campbell/Projects/Elistly-spike-static-index/device-intake.js#L136)  
   - [device-intake.js:138](/home/campbell/Projects/Elistly-spike-static-index/device-intake.js#L138)  
   - [device-intake.js:154](/home/campbell/Projects/Elistly-spike-static-index/device-intake.js#L154)

3. Blank/custom workspace path: when current workspace is empty or custom and lacks `computer`/`person`, the plan includes full type definitions with Device Intake fields and associations, then `materializePlan()` writes them into the active workspace snapshot.  
   - Blank preset is intentionally empty (`categories`/`entityTypes` `{}`).  
   - [setup-blank.js:7](/home/campbell/Projects/Elistly-spike-static-index/setup-blank.js#L7)  
   - [setup-blank.js:11](/home/campbell/Projects/Elistly-spike-static-index/setup-blank.js#L11)  
   - [setup-blank.js:12](/home/campbell/Projects/Elistly-spike-static-index/setup-blank.js#L12)  
   - [device-intake.js:230](/home/campbell/Projects/Elistly-spike-static-index/device-intake.js#L230)

4. Existing IT workspace path: IT preset already has `computer` and `person` types, so import tries schema extension (missing fields like `accountName`, `hostname`, `upn`, `serialNumber`, etc.), not full type replacement.  
   - IT preset defines both target types and baseline fields.  
   - [setup-it.js:18](/home/campbell/Projects/Elistly-spike-static-index/setup-it.js#L18)  
   - [setup-it.js:19](/home/campbell/Projects/Elistly-spike-static-index/setup-it.js#L19)  
   - [setup-it.js:77](/home/campbell/Projects/Elistly-spike-static-index/setup-it.js#L77)  

5. Imported computer/person fields become visible/editable through schema-driven rendering, and this is why they appear immediately after import.  
   - Entity form rendering iterates `type.fields` to render editable inputs.  
   - [app.js:3733](/home/campbell/Projects/Elistly-spike-static-index/app.js#L3733)  
   - [app.js:3830](/home/campbell/Projects/Elistly-spike-static-index/app.js#L3830)  
   - [app.js:3870](/home/campbell/Projects/Elistly-spike-static-index/app.js#L3870)  
   - Mini-card visibility also reads `visibleInCard` on type fields.  
   - [app.js:1512](/home/campbell/Projects/Elistly-spike-static-index/app.js#L1512)  

6. Active-workspace persistence is explicit: imports mutate active workspace data and persistence stores workspace map + `currentWorkspaceId`.  
   - Plan application writes only `candidate.workspaces[currentWorkspaceId]` (categories/entityTypes/entities).  
   - [device-intake.js:226](/home/campbell/Projects/Elistly-spike-static-index/device-intake.js#L226)  
   - Startup loads `workspaces` + `currentWorkspaceId`, then maps `this.data` to that workspace.  
   - [app.js:505](/home/campbell/Projects/Elistly-spike-static-index/app.js#L505)  
   - Save path snapshots current workspace back into `workspaces[current]` before persistence.  
   - [app.js:1230](/home/campbell/Projects/Elistly-spike-static-index/app.js#L1230)  

7. Incompatible same-name schema failures are hard-fail, not merged.  
   - If a field with same name exists but different type => throws `has incompatible type ...`.  
   - If an association with same name exists but non-association or different `targetType` => throws `has an incompatible association`.  
   - This bubbles through plan creation as a thrown error.  
   - [device-intake.js:145](/home/campbell/Projects/Elistly-spike-static-index/device-intake.js#L145)  
   - [device-intake.js:151](/home/campbell/Projects/Elistly-spike-static-index/device-intake.js#L151)  
   - [app.js:7274](/home/campbell/Projects/Elistly-spike-static-index/app.js#L7274)

8. Explicit collision handling is implemented for multiple matches and enforced before materialization.  
   - Candidate math returns `update` (1), `create` (0), `conflict` (>1).  
   - `chosenId()` throws if conflict without explicit non-`create` choice.  
   - UI shows choices for each conflict candidate + Create option, and disables Confirm until resolved.  
   - [device-intake.js:172](/home/campbell/Projects/Elistly-spike-static-index/device-intake.js#L172)  
   - [device-intake.js:174](/home/campbell/Projects/Elistly-spike-static-index/device-intake.js#L174)  
   - [device-intake.js:189](/home/campbell/Projects/Elistly-spike-static-index/device-intake.js#L189)  
   - [app.js:7303](/home/campbell/Projects/Elistly-spike-static-index/app.js#L7303)  
   - [app.js:7342](/home/campbell/Projects/Elistly-spike-static-index/app.js#L7342)  
   - [tests/device-intake-core.test.js:59](/home/campbell/Projects/Elistly-spike-static-index/tests/device-intake-core.test.js#L59)  
   - [tests/device-intake-core.test.js:69](/home/campbell/Projects/Elistly-spike-static-index/tests/device-intake-core.test.js#L69)

9. Revision safety for persistence: import uses identity + revision token (`expectedUpdatedAt`) and Worker enforces stale-write protection.  
   - Identity includes cache timestamp and is checked in confirm.  
   - [app.js:183](/home/campbell/Projects/Elistly-spike-static-index/app.js#L183)  
   - [app.js:307](/home/campbell/Projects/Elistly-spike-static-index/app.js#L307)  
   - Worker returns 409 when timestamp mismatch.  
   - [worker/src/index.js:417](/home/campbell/Projects/Elistly-spike-static-index/worker/src/index.js#L417)  
   - [worker/src/index.js:432](/home/campbell/Projects/Elistly-spike-static-index/worker/src/index.js#L432)  
   - [worker/test/worker-routes.spec.js:142](/home/campbell/Projects/Elistly-spike-static-index/worker/test/worker-routes.spec.js#L142)

Uncertainty (explicit):
- There is no direct unit test covering the UI behavior specifically when `createSchemaChanges` throws for incompatible same-name schema conflicts; only throw behavior and catch-path display are present in code-path, not a dedicated acceptance test.  
- [device-intake.js:145](/home/campbell/Projects/Elistly-spike-static-index/device-intake.js#L145)  
- [app.js:7274](/home/campbell/Projects/Elistly-spike-static-index/app.js#L7274)
