# Windows Device Intake

**Status:** A source-complete candidate now routes bounded report values into the normal **Add Computer** draft and removes the original Settings import/schema/person transaction. It still requires independent review, integration/private-preview verification, and real Windows/browser acceptance before release.

## Product rule

Elistly is modular and flexible. Device Intake adapts to the user's configured entity type and fields; it never installs its own competing schema, silently adds fields or categories, or creates related records from guesses.

The collector download belongs with data/collector administration. Creating a device belongs where users normally add that device.

## Bounded first milestone

Deliver one thin local-only workflow:

1. An authorized user downloads the versioned Windows collector from Settings.
2. The collector discloses its bounded field set, runs without administrator rights, and saves a local JSON report chosen by the user.
3. The user opens the normal **Add Computer** form.
4. **Import collected information** lets the user select the JSON report.
5. Elistly validates the report without mutating application data.
6. Supported report values are mapped only into compatible fields that already exist on the selected Computer type.
7. Values appear as ordinary editable draft controls in that form. Existing user-entered draft values are never overwritten without an explicit choice.
8. Unmapped collected values are summarized in a collapsed, optional section; they do not add fields automatically.
9. Person assignment uses the normal optional association control. The user may leave it as **None**, choose an existing person, or deliberately use the ordinary add-related-person flow.
10. The Windows account name, UPN, email, display name, or domain may be shown as collected context, but none may create, choose, or update a Person automatically.
11. Nothing is persisted until the user submits the normal Add Computer form through Elistly's authoritative save path.

The first milestone explicitly does **not** add automatic upload, collection requests, one-time links, arbitrary PowerShell in field definitions, schema migrations, preset redesign, or automatic updates to existing computers.

## Source-of-truth boundaries

### Elistly schema

The selected entity type in `App.data.entityTypes` is authoritative for:

- which fields exist;
- field labels and control types;
- which associations exist;
- required and optional behavior;
- normal entity validation and persistence.

Device Intake must not own a `schemaDefinitions` copy of Computer or Person. It must not add categories, entity types, fields, dropdown options, associations, or entities while parsing or mapping a report.

### Collector capabilities

A field may later opt into a trusted collection capability by storing metadata such as:

```json
{
  "name": "cpu",
  "label": "CPU",
  "type": "text",
  "collection": {
    "provider": "windows",
    "capability": "processor.summary"
  }
}
```

Workspace data stores only a reviewed capability identifier, never executable PowerShell. A versioned application-owned registry maps capabilities to trusted collector logic.

Initial capability examples may include:

- `computer.hostname`;
- `computer.manufacturer`;
- `computer.model`;
- `processor.summary`;
- `memory.total`;
- `graphics.adapters`;
- `windows.edition`;
- `windows.version`;
- `windows.build`;
- `bios.serial-number`;
- `current-account.name`;
- `current-account.domain`.

Unknown custom fields remain manual until a trusted capability is deliberately assigned. Form visibility and automatic collection are separate concerns; do not overload one flag to mean both.

Capability-driven collector generation is the second milestone, after report-to-form import is accepted.

## Placement and interaction contract

### Settings

Settings may provide:

- a concise Device Collector card;
- the current package version and download action;
- a short privacy summary;
- a link to detailed collected-field and policy information.

Settings must not contain report import, schema changes, person matching, or device creation.

### Add Computer

The normal new-entity form for a compatible Computer type provides one secondary action: **Import collected information**.

Import is a draft-population aid, not a separate transaction. It must:

- use the same field controls the user already understands;
- preserve draft values until conflicts are resolved;
- mark populated fields unobtrusively;
- keep Save/Cancel behavior unchanged;
- remain usable without importing a report;
- show concise field-level validation rather than a second large modal.

A compact file chooser or drop surface may be used. Explanatory details belong behind progressive disclosure, not in the primary path.

### Existing computers

Updating an existing computer from a report is deferred from the first milestone. Do not silently broaden Add Computer import into identity matching or update behavior. A later update flow must explicitly identify the destination record and preview overwrites.

## Mapping contract

Report parsing and form mapping are separate operations.

The report parser returns bounded, normalized collected facts without knowing Elistly's schema. The mapper receives:

- a parsed report;
- the selected entity type definition;
- current draft values;
- the trusted capability/alias registry.

It returns an immutable draft-population proposal containing:

- compatible mapped fields and proposed values;
- conflicts with non-empty draft values;
- unmapped collected facts and reasons;
- collected account context for display only;
- warnings.

The mapper never mutates `App.data`, the form, or the report. Applying an accepted proposal changes only draft form controls.

The first implementation may use a small reviewed alias table for the current IT Computer preset while introducing the capability boundary, but aliases must be outside the parser and must not synthesize missing schema.

Examples:

- report `hostname` → field capability `computer.hostname` or reviewed alias `hostname`;
- report processor summary → capability `processor.summary` or reviewed alias `cpu`;
- report memory summary → capability `memory.total` or reviewed alias `ram`;
- report model → capability `computer.model` or reviewed alias `model`.

Incompatible field types remain unmapped. Do not coerce arbitrary collected text into dropdown options or mutate option lists.

## Person and association policy

Person creation or selection is always deliberate.

- Default assignment is **None**.
- Collected account data never proves that an Elistly Person exists.
- A local account such as `campbell` must never create a person named `campbell`.
- Existing people may be selected only through the normal association control.
- If the user chooses to create a related Person, use the existing explicit inline-add workflow and its validation.
- Future collection requests may carry an intended person ID, but the Add Computer form still displays the assignment and permits authorized correction before save unless a future product policy explicitly says otherwise.

## Report contract

The supported envelope remains versioned:

```json
{
  "schema": "elistly.device-intake.v1",
  "collectedAt": "2026-08-07T10:00:00.000Z",
  "collector": {
    "name": "Elistly Windows Device Intake Collector",
    "version": "1.0.2"
  },
  "person": {},
  "computer": {}
}
```

Requirements:

- reject missing or unsupported schemas;
- require an object at the document root;
- require at least one stable computer identity candidate;
- cap encoded reports at 256 KiB before parsing;
- bound strings, arrays, depth, and total accepted fields;
- normalize whitespace and comparison case without trusting report strings as HTML;
- reject invalid timestamps and wrong types with field-specific messages;
- never mutate Elistly data during parsing, mapping, or draft preview;
- treat `person` as optional collected account context only in the first milestone;
- preserve version-to-version report migrations as explicit tested transformations.

## Privacy and security contract

- Default collection is local-only and performs no network or directory query.
- Directory enrichment, if retained later, is a separate explicit opt-in mode.
- Never collect passwords, browser data, tokens, product keys, Wi-Fi credentials, document content, or unrelated user files.
- Do not require administrator privileges.
- Do not hide collection of identity data.
- Do not leave reports in shared predictable temporary files.
- Show the collected field list before execution and in the report.
- Render imported values as text, never trusted HTML.
- The local collector never contacts Elistly or a third party.
- Browser import transmits nothing until the signed-in user submits the normal entity form.
- The packaged launcher may use a documented process-scoped execution-policy option; it must never call `Set-ExecutionPolicy` or change machine/user policy, and organization-enforced policy may still block it.

## Deferred collection requests

A later remote workflow may let an administrator create a collection request for an optional intended person and send a link. It must use a bounded request authority, never an administrator's browser session or reusable authentication token.

A request requires at minimum:

- a random, unguessable request ID/token;
- workspace/inventory scope;
- an allowed collector profile/capability set;
- optional intended Person ID;
- expiration and one-time/replay policy;
- explicit submission consent;
- revocation and visible status;
- server-side report validation;
- no general account or data access.

This is a separate trust boundary and is deferred until the local draft workflow and capability model are accepted.

## Related preset direction

Built-in presets should become visible, previewable templates/modules rather than opaque data users must import blindly. Shared concepts such as People, Locations, and Devices should eventually be composable modules. Disabling a module with data must hide/deactivate it non-destructively, not delete records.

That redesign is architecturally related because both features require Elistly's configured schema to be authoritative, but it is not part of the first Device Intake milestone.

## Acceptance gates

### Deterministic parser and mapper

- valid and malformed reports;
- unsupported/missing schema;
- oversized, deeply nested, and wrong-type input;
- HTML/script-like strings remain plain text;
- mapping uses only existing compatible fields;
- absent fields and types are not added;
- incompatible dropdown/type values remain unmapped;
- collected account context never produces a Person action;
- empty draft fields can be populated;
- non-empty draft conflicts require an explicit keep/replace choice;
- applying a proposal changes draft controls only;
- cancel leaves form and application data unchanged.

### Browser workflow

- Settings exposes collector download but no report import;
- Add Computer exposes import without affecting ordinary manual entry;
- report values populate the normal form;
- person assignment defaults to None and lists existing people;
- Save uses the normal entity path exactly once;
- Cancel/import failure persists nothing;
- refresh and sign-out/sign-in preserve a successfully saved computer;
- imported records remain normally editable.

### Collector/package

- deterministic archive and checksum;
- relative branded shortcut and documented fallback;
- standard non-administrator account;
- Windows 10 and Windows 11 where available;
- missing CIM/WMI properties;
- no undeclared outbound traffic or temporary report;
- exact package version, checksum, and instructions recorded.

### Release truth

Automated tests, Wine probes, and Linux browser tests cannot replace physical Windows Explorer, execution-policy, icon, Mark-of-the-Web, and workplace-browser validation. No candidate is release-ready until those manual boundaries are reported honestly.
