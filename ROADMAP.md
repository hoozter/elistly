# Elistly – Roadmap

**Last updated:** 2026-08-07
**Status:** Published and running at `elistly.com`; active security, data-integrity, and roadmap recovery before further feature development.

Elistly is a modular inventory app for tracking devices, books, people, locations, and other structured collections. Users define categories, entity types, custom fields, and associations. The current production architecture is a static Cloudflare Pages frontend using Neon Auth and an authenticated Cloudflare Worker backed by Neon Postgres.

A published MVP is the release floor, not the end of the product. Work below is ordered by dependency and user-data risk.

---

## Current baseline

### Implemented

- Core inventory: categories, entity types, custom fields, associations, and workspaces.
- Dashboard card, list, gallery, and due/overdue views.
- Entity, category, and entity-type CRUD.
- Name/title search.
- Selective JSON import and export.
- Full-account export, reset, and account deletion UI.
- Light/dark themes, accent colors, and in-app changelog.
- Admin user list/delete controls.
- PWA manifest and cached application shell.
- Neon Auth email/password and email OTP verification.
- Neon Postgres app data through the Cloudflare Worker.

### Not yet release-proven

- Automated Worker, browser, import, and persistence tests.
- Revision-safe multi-tab/multi-device persistence.
- Durable offline edits and reconnect replay.
- Reliable service-worker update behavior after backend/frontend changes.
- Production-complete password reset, email management, and MFA behavior.
- Windows Device Intake.

---

## P0 – Secure and preserve user data

- [ ] **Worker trust boundary and route tests** — Restrict credentialed CORS to configured frontend origins; remove or protect debug environment output; stop exposing internal errors; test unauthenticated, owner, admin, malformed-token, bad-body, and destructive failure paths without real production accounts.
- [ ] **Revision-aware persistence** — Replace blind whole-document last-writer-wins updates with an explicit revision/ETag contract and conflict response.
- [ ] **Durable local writes** — Serialize saves, preserve failed writes in a durable local outbox, prevent background hydration from replacing dirty local state, and show sync/failure status.
- [ ] **Offline and multi-device acceptance** — Test restart while offline, reconnect replay, reordered saves, two tabs/devices editing the same and different records, and remote data arriving during a local edit.
- [ ] **PWA update safety** — Version shell assets per release, define navigation/config bootstrap behavior, and prevent installed clients from retaining stale pre-migration code indefinitely.
- [ ] **Repository and secret hygiene** — Keep local credentials/configuration outside the repository where practical, retain only generic ignore categories, scan reachable history, and document secret handling.

## P0 – Windows Device Intake

This is a recovered high-priority product requirement. See [`WINDOWS_DEVICE_INTAKE_PLAN.md`](WINDOWS_DEVICE_INTAKE_PLAN.md).

- [ ] **Versioned local collector** — Collect a disclosed, bounded set of Windows hardware, OS, and account facts without administrator access or default network calls.
- [ ] **Strict report contract** — Validate `elistly.device-intake.v1`, enforce size/depth/type limits, and reject unsupported schemas before creating a preview.
- [ ] **Side-effect-free preview** — Show exact create/update changes without mutating schema, dropdowns, entities, or persisted data.
- [ ] **Explicit collision resolution** — Never silently merge people or computers when serial/hostname/email/account identifiers disagree.
- [ ] **Privacy-safe transfer** — No execution-policy bypass, hidden collection, predictable temporary report, or default clipboard copy; optional directory enrichment must be explicit and accurately described as network access.
- [ ] **Windows acceptance** — Validate Windows 10/11, standard accounts, domain/workgroup machines, missing CIM properties, multiple GPUs, and no default outbound traffic.
- [ ] **Checksummed candidate package** — Record exact collector path, checksum, contents, and launch instructions before asking for real-machine testing.

## P0 – Complete account flows

- [ ] **Password reset** — Implement and test Neon Auth password reset/change behavior, redirect handling, expiry, and user-visible errors.
- [ ] **Email management** — Implement only the primary/secondary-email behavior supported and tested against the current backend; hide unsupported controls.
- [ ] **MFA decision and implementation** — Verify Neon Auth requirements first. Until supported end to end, remove or visibly disable controls and FAQ claims that imply working enrollment.

---

## P1 – Reliable import and export

Selective JSON import/export exists; this milestone turns it into one compatible backup contract.

- [ ] **Versioned backup envelope** — One schema-versioned full export that includes workspaces, settings, categories, types, entities, associations, and restorable metadata.
- [ ] **Round-trip restore** — Restore the full-account export format rather than accepting only the current top-level selective format.
- [ ] **Validation and conflict policy** — Reject malformed/dangling data before mutation and offer explicit skip/overwrite decisions.
- [ ] **CSV export** — Export a category/entity-type view suitable for inventory reporting.
- [ ] **CSV import** — Map columns to one entity type, preview validation, then bulk-create through the authoritative mutation path.
- [ ] **Resource bounds** — Bound file size, rows, fields, nesting, and aggregate allocations before importing untrusted files.

## P2 – Find and manage larger inventories

- [ ] **Advanced search** — Filter by field values and associations; current search is name/title-only.
- [ ] **Sort by field** — Sort lists by a chosen compatible field, not only generated name.
- [ ] **Bulk actions** — Select multiple entities for export, category movement, or confirmed deletion.
- [ ] **Drag-to-reorder entity instances** — Preserve explicit order where the selected view supports it.
- [ ] **Gallery improvements** — Add an intentional photo/image field and gallery-card behavior.
- [ ] **QR scanning** — Define a cross-browser fallback before relying on the incompletely supported native Barcode Detection API.

## P3 – Notifications and mobile polish

- [ ] **Due-date notifications** — Define in-app versus push behavior, permissions, duplicate suppression, and offline delivery semantics.
- [ ] **Mobile UX pass** — Test small screens, drawers, forms, modals, imports, and touch targets on real devices.
- [ ] **Install experience** — Add an intentional PWA install prompt where supported and truthful fallback guidance elsewhere.
- [ ] **Keyboard shortcuts** — Quick add, search focus, selection, and navigation with discoverable help.

## P4 – Collaboration and sharing

Collaboration is blocked on a revised data ownership model. It must not be added to the current whole-user JSON document.

- [ ] **Normalized ownership/revision design** — Define list/category/item ownership, permissions, revisions, and migration from existing payloads.
- [ ] **Read-only shared lists** — Share a deliberate subset without exposing unrelated user inventory.
- [ ] **Multi-user categories** — Invite collaborators with explicit roles and conflict handling.
- [ ] **Activity log** — Record who changed what, when, and from which prior revision.

---

## Documentation corrections incorporated

- JSON import is partially implemented; it is no longer described as absent.
- Changelog UI is implemented; it is no longer listed as future work.
- Search is documented as name/title-only until field search exists.
- “Offline support” means cached shell availability today, not proven durable offline editing and later sync.
- Windows Device Intake is now a first-class P0 requirement with its own contract and acceptance plan.

## Deferred pending an explicit product decision

- Whether optional Windows directory enrichment should exist at all.
- Whether collaboration justifies normalizing the entire persistence model beyond revision-safe single-user storage.
- Which notification channel is valuable enough to justify background delivery complexity.
