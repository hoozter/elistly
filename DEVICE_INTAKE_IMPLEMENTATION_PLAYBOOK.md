# Device Intake Reshape — Implementation Playbook

## Authority

This playbook implements the approved product direction in `WINDOWS_DEVICE_INTAKE_PLAN.md`. The plan is authoritative when wording differs.

The first outcome is deliberately narrow:

> A locally collected Windows report can populate the normal Add Computer form as editable draft values, with optional existing-person assignment and ordinary Save behavior, without changing schema or creating/updating a Person.

Do not implement remote collection requests, automatic upload, arbitrary PowerShell, generated capability-specific collectors, preset/module redesign, or update-existing-computer behavior in this milestone.

## Ownership and boundaries

- One mutating owner works in the assigned branch/worktree.
- Preserve unrelated tracked and untracked files.
- No push, deployment, production configuration, external data mutation, dependency installation, or public exposure.
- `config.js` is ignored local configuration and must never be staged or logged.
- Use strict vertical RED–GREEN–REFACTOR for behavioral changes.
- Existing source and tests are evidence, not authority where they conflict with the approved plan.
- Delete superseded Device Intake import/schema/person machinery rather than keeping parallel implementations.
- Keep the bounded report parser if still useful, but make it independent of Elistly schema and entity mutation.

## Current defect to remove

The current implementation has a competing model:

- `setup-it.js` defines the configurable Computer type used by normal forms.
- `device-intake.js` separately hard-codes Computer and Person definitions.
- `createSchemaChanges()` plans categories/types/fields/associations.
- `materializePlan()` creates or updates Person and Computer entities.
- `app.js` exposes a large Settings import modal and persists its special transaction.

This duplication violates the source-of-truth boundary. The reshaped flow must have one creation path: `showEntityForm()` → ordinary form controls → `saveEntity()`.

## Stage 0 — establish baseline

1. Read:
   - `WINDOWS_DEVICE_INTAKE_PLAN.md`;
   - this playbook;
   - `setup-it.js`;
   - `device-intake.js`;
   - the `showEntityForm`, `createEntityFormField`, association, and `saveEntity` paths in `app.js`;
   - current Device Intake tests;
   - collector/package files only as needed to preserve the working download.
2. Record branch, HEAD, and dirty state.
3. Run the current focused intake, browser, security, and Worker tests.
4. Do not alter the collector package unless the new workflow requires user-facing package documentation changes.

Expected baseline commands include:

```bash
node --check app.js
node --check device-intake.js
node tests/windows-shortcut.test.js
node tests/windows-collector.test.js
node tests/device-intake-core.test.js
node tests/device-intake-browser.test.js
node tests/frontend-security-runtime.test.js
(cd worker && npm test)
git diff --check
```

If an existing test encodes superseded behavior—schema additions, special import persistence, or automatic Person creation—replace it through a witnessed failing test for the approved behavior; do not preserve the old behavior merely to keep the test green.

## Stage 1 — parser without mutation ownership

### Desired API

Retain or extract a bounded parser that:

```js
const report = ElistlyDeviceIntake.parseReport(jsonText);
```

The result contains immutable normalized collected facts and collected account context. It does not contain Elistly entity definitions, schema changes, persistence plans, or inferred Person actions.

### Required tests

Use focused RED–GREEN cycles for:

- valid current report;
- missing/unsupported schema;
- invalid timestamp;
- oversized/deep/wide/wrong-type input;
- stable computer identity requirement;
- placeholder serial handling;
- hostile strings remain data;
- absent `person` or empty person context is accepted if the envelope contract permits it;
- parsed result is immutable;
- parsing does not mutate supplied data or global application state.

### Deletion gate

Remove or supersede:

- hard-coded `schemaDefinitions`;
- `createSchemaChanges()`;
- entity identity/collision planning that exists only for the old import transaction;
- `materializePlan()`;
- special Person creation/update behavior.

Keep small normalization helpers only when used by the parser or new mapper.

## Stage 2 — schema-aware immutable draft mapper

### Desired responsibility

Add a small testable function with an interface equivalent to:

```js
const proposal = ElistlyDeviceIntake.createDraftProposal(
  parsedReport,
  entityTypeDefinition,
  currentDraftValues,
  capabilityRegistry
);
```

Names may change if a simpler existing convention exists. The behavior may not.

The proposal contains:

- `mapped`: compatible field proposals;
- `conflicts`: proposals targeting non-empty draft values;
- `unmapped`: collected facts with concise reasons;
- `accountContext`: display-only person/account facts;
- `warnings`.

It is immutable and does not touch DOM or `App.data`.

### Capability and alias boundary

Introduce a small reviewed registry outside the parser. It may map current collected keys to trusted capability IDs and current IT aliases, for example:

```text
hostname            -> computer.hostname       -> hostname
manufacturer        -> computer.manufacturer   -> manufacturer
model               -> computer.model          -> model
processorSummary    -> processor.summary       -> cpu
memorySummary       -> memory.total             -> ram
graphicsAdapters    -> graphics.adapters       -> gpu
serialNumber        -> bios.serial-number       -> serialNumber
```

Prefer explicit field metadata such as `field.collection.capability` when present. A bounded alias table may support current fields until the form editor exposes capability selection in a later milestone.

Do not:

- put PowerShell in field definitions;
- add missing fields;
- add dropdown options;
- coerce incompatible values;
- treat field/card visibility as collection permission;
- map collected account context into a Person entity.

### Mapper tests

Prove through RED–GREEN slices:

1. A compatible empty text field receives a proposal.
2. Missing form fields remain unmapped and schema is unchanged.
3. A custom compatible field with supported capability metadata maps correctly.
4. An unknown custom field remains untouched.
5. Incompatible field types/options remain unmapped.
6. Existing non-empty draft values become conflicts and are not silently replaced.
7. Account/person facts are display-only.
8. Inputs and application data remain byte-for-byte unchanged.

## Stage 3 — integrate with the normal Add Computer form

### Compatible form detection

The import action appears only for a new entity form whose type is eligible for Windows computer intake. Do not rely solely on the literal type ID `computer` if an existing clean capability/metadata test is available. For the first milestone, a narrow reviewed compatibility predicate is acceptable; document it and avoid pretending arbitrary types are supported.

Editing an existing Computer is out of scope. The action must not appear there unless the plan is explicitly expanded.

### UI contract

Add one restrained secondary action near the normal new-Computer form:

**Import collected information**

Use a compact chooser/drop surface integrated with the form. Avoid another full-screen or nested modal. Use progressive disclosure for privacy/details.

After selection:

- parse and map;
- populate only accepted empty form controls;
- visibly but quietly indicate imported fields;
- show concise conflicts with explicit **Keep current** / **Use collected** choices;
- show an optional collapsed “Not imported” summary;
- show collected account context only as informational text;
- leave the normal person association at `— None —` unless the user chooses an existing person;
- retain normal Save and Cancel buttons.

No separate Confirm Import transaction exists. The user reviews the ordinary form and presses its ordinary Save.

### DOM discipline

- Build user-controlled strings with text nodes/textContent.
- Reuse existing button, input, form-group, card, disclosure, and notification styles.
- Do not introduce inline executable HTML from report values.
- Avoid global mutable import state when the proposal can be scoped to the open form.
- Closing/cancelling the form releases file/proposal state and persists nothing.

### Browser tests

Prove:

1. Settings still exposes the collector download.
2. Settings no longer exposes report import or the old Device Intake import modal.
3. Manual Add Computer works unchanged without import.
4. Add Computer exposes the import action.
5. A report populates matching ordinary controls.
6. Missing fields do not appear magically.
7. Existing draft text is preserved until explicit replacement.
8. Person association defaults to None and lists existing people.
9. Account name `campbell` does not create or select a Person.
10. Cancel persists nothing.
11. Invalid reports persist nothing and produce concise actionable feedback.
12. Save invokes the existing entity persistence path once and creates only the Computer.
13. Saved imported records survive refresh and remain editable through the normal form.

Use the existing browser fixture and actual App behavior where practical; avoid implementation-snapshot string tests when a behavioral DOM assertion is feasible.

## Stage 4 — remove superseded UI and transaction code

Delete the old special-purpose path from `app.js`, including as applicable:

- Settings **Device Intake** import button/modal;
- `_deviceIntakePlan`, preview identity, and choices state;
- plan rendering and schema-addition rendering;
- special `confirmDeviceIntake()` persistence transaction;
- only-import-specific helpers no longer used elsewhere.

Keep a concise Settings collector card/download path. Its primary content should be:

- what the collector does;
- local/no-admin privacy boundary;
- download action;
- link/disclosure for details.

Do not retain the old modal as a fallback. Git history is the fallback.

## Stage 5 — documentation, cache, and package consistency

1. Update user-facing copy to match the new placement.
2. Advance app/service-worker cache identifiers only if changed assets would otherwise remain stale.
3. Ensure the current collector download filename and checksum remain truthful.
4. Rebuild the package only if package inputs changed.
5. Never stage ignored `config.js`, private endpoint values, raw reports, or local QA captures.
6. Update candidate documentation to distinguish source/browser acceptance from physical Windows acceptance.

## Stage 6 — verification and checkpoint

Run proportionate complete gates:

```bash
node --check app.js
node --check device-intake.js
node --check sw.js
node tests/windows-shortcut.test.js
node tests/windows-collector.test.js
node tests/device-intake-core.test.js
node tests/device-intake-browser.test.js
node tests/frontend-security-runtime.test.js
(cd worker && npm test)
git diff --check
```

Also verify:

- no `schemaDefinitions`, `createSchemaChanges`, or `materializePlan` mutation path remains in active intake code unless the names now implement materially different approved behavior;
- no automatic Person creation path remains;
- no Settings report import remains;
- no unrelated files are staged;
- no secret/config/report content appears in the diff.

Commit coherent local slices with short factual messages. Do not push.

## Review budget

This is an architectural behavioral reshape:

- one independent read-only review of the coherent source-complete candidate;
- one targeted blocker-only rereview if the first review finds a blocker;
- physical Windows/browser acceptance remains separate and cannot be synthesized.

The review must focus on:

- one authoritative creation/persistence path;
- zero schema mutation during intake;
- zero inferred Person mutation/assignment;
- draft conflict safety;
- mapping modularity without arbitrary executable code;
- stale special-import code removal;
- security/privacy regressions;
- acceptance-test quality.

## Stop conditions and handoff

Stop and preserve exact state only for:

- an unresolved product tradeoff not answered by the plan;
- credentials/private workplace data;
- deployment/publication;
- destructive migration;
- physical Windows/browser evidence;
- exhausted approved model capacity.

Do not stop for ordinary implementation choices, test corrections, safe refactoring, or local package rebuilding.

At completion write a compact handoff containing:

- branch and HEAD;
- exact commits and dirty files;
- tests and results actually run;
- review result;
- remaining physical QA steps;
- package path/checksum if changed;
- explicit statement that nothing was pushed or deployed.
