# Windows Device Intake

**Status:** Source-complete v1 candidate on 2026-08-11; not deployed. Deterministic and browser acceptance gates pass. Required physical Windows 10/11 validation remains outstanding, so the candidate is not release-ready.

## Product goal

Let an authorized user collect inventory facts from a Windows computer, preview them in Elistly, and deliberately create or update a computer record and its assigned person.

This is a core Elistly use case, not an incidental import format. It must be safe enough for workplace inventory data and simple enough to run locally without installing an agent or granting administrator access.

## Intended workflow

1. The user downloads or copies the versioned Elistly Windows collector.
2. Before collection, the collector states exactly which local fields it reads and whether optional directory enrichment is enabled.
3. The collector runs without administrator privileges and creates one versioned JSON report in a location chosen by the user.
4. The user opens **Settings → Data → Device Intake** and selects or pastes that report.
5. Elistly validates the entire report without changing application data.
6. Elistly shows the person and computer fields, possible existing matches, whether each record would be created or updated, and any additive category/type/field schema changes needed to make the collected values visible in normal Elistly views.
7. Ambiguous matches require an explicit user choice. Elistly never silently chooses between multiple records.
8. Only **Confirm import** may change data. The report records and disclosed additive schema changes are saved as one coherent revision-aware change. A failed pre-commit save restores the previous local state; a successful remote save followed by a local-cache failure must instead report that the remote commit succeeded and require reload.

## Report contract

The first supported envelope is:

```json
{
  "schema": "elistly.device-intake.v1",
  "collectedAt": "2026-08-07T10:00:00.000Z",
  "collector": {
    "name": "Elistly Windows Device Intake Collector",
    "version": "1.0.0"
  },
  "person": {},
  "computer": {}
}
```

Requirements:

- Reject missing or unsupported schema versions.
- Require an object at the document root.
- Require at least one stable computer identity candidate.
- Cap the encoded report at 256 KiB before parsing.
- Bound strings, arrays, object depth, and total accepted fields before copying data into application state.
- Normalize whitespace and comparison case without rewriting the original preview.
- Reject invalid timestamps and structurally invalid values with field-specific messages.
- Do not mutate categories, entity types, dropdown options, or entities during parsing or preview.
- Treat future schema migration as an explicit version-to-version transformation with tests.

## Identity and collision policy

### Computer

Candidate identifiers, in descending confidence:

1. a non-placeholder serial number plus manufacturer;
2. an existing Elistly asset identifier, if a future collector supports one;
3. hostname plus Windows/domain context.

Serials such as empty strings, `To Be Filled By O.E.M.`, or other known placeholders are not stable identifiers. A serial match and hostname match that point to different records is a conflict, not permission to update either one.

### Person

Candidate identifiers, in descending confidence:

1. verified directory UPN or email;
2. domain plus account name;
3. an explicit existing Elistly person selected by the importing user.

Name-only matches must never update a person automatically. Email and username matches that identify different records require a user decision.

The preview must show the exact fields that will be added, retained, overwritten, or left unchanged.

## Privacy and security contract

- Default collection is local-only and performs no network or directory query.
- Active Directory or Entra enrichment, if retained, is a separate explicit opt-in mode labelled as a network/directory lookup.
- Never collect passwords, browser data, tokens, product keys, Wi-Fi credentials, document content, or unrelated user files.
- Do not bypass PowerShell execution policy from inside the collector.
- Do not require administrator privileges.
- Do not hide the collector window while collecting identity data.
- Do not copy the report to the clipboard by default. Clipboard copying may be an explicit user action with a warning that clipboard history or synchronization can retain the data.
- Do not leave reports in a shared predictable temporary filename. Let the user choose a destination and explain deletion responsibility.
- Display the collected field list before execution and in the generated report.
- Render imported strings as text, not trusted HTML.
- Never contact Elistly, Neon, Cloudflare, or any third party from the collector.
- The browser import must not transmit data until the signed-in user confirms the Elistly save.

## Initial field set

Computer fields may include:

- hostname;
- manufacturer and model;
- processor summary and full processor description;
- total memory summary;
- graphics adapter summary;
- Windows edition, version, and build;
- BIOS serial number;
- current account name and domain context;
- collection timestamp and collector version.

Optional person fields may include:

- display name;
- domain/account name;
- UPN or work email;
- phone and job title only when directory enrichment was explicitly enabled.

Each field remains optional except the stable computer identity requirement.

## Architecture constraints

- Parsing and normalization must live in a small testable module, not as another large block inside `app.js`.
- Preview returns an immutable plan; it cannot mutate `App.data`.
- Schema changes are separate from report parsing and require their own confirmed migration.
- Import execution uses the same authoritative persistence path as other Elistly mutations.
- Device Intake cannot be considered reliable until Elistly has revision-aware saves, durable failed-write handling, and conflict protection.
- No background Windows service, remote management agent, or continuous inventory collection is part of this capability.

## Acceptance gates

### Deterministic tests

- valid v1 report;
- unsupported/missing schema;
- oversized, deeply nested, malformed, and wrong-type input;
- HTML/script-like strings rendered as plain text;
- serial-only and hostname-only matching;
- placeholder serial handling;
- conflicting serial/hostname matches;
- conflicting person email/account matches;
- preview/cancel leaves application data byte-for-byte unchanged;
- confirmed create and confirmed update;
- save failure leaves existing data intact and reports failure;
- report from a newer collector version using the same supported schema.

### Windows validation

- Windows 10 and Windows 11;
- domain-joined and workgroup machines;
- standard non-administrator account;
- missing CIM/WMI properties;
- laptops, desktops, virtual machines, and multiple graphics adapters;
- execution under the documented PowerShell policy without bypassing it;
- no default outbound network traffic;
- no report left in an undeclared temporary location;
- exact collector archive checksum and launch instructions recorded for each candidate.

## Recovery note

An earlier uncommitted prototype was removed from the active tree during the 2026-08-07 security cleanup because it mutated schema during preview, lacked bounded validation and collision handling, queried Active Directory despite claiming no network access, bypassed PowerShell execution policy, and left personal/device data in a predictable temporary file and clipboard.

Its exact patch and files are retained outside the repository in the permission-restricted recovery archive. They are evidence of intended fields and workflow, not code approved for reuse without review.
