# Elistly – Roadmap

**Last updated:** 2026-05-18
**Status:** Active development. Neon Auth, Neon Postgres, and the Cloudflare Worker are the current backend.

Elistly is a modular inventory app for tracking anything — devices, books, people, locations. Users define their own entity types and custom fields. Data is stored in Neon Postgres through the Worker API and designed for offline-friendly PWA use.

---

## Status Overview

### Completed ✓
- Core inventory: categories, entity types, custom fields, associations
- Dashboard views: card, list (A–Z), gallery, due/overdue
- Full CRUD for entities, categories, and entity types
- Search by name
- Export/reset/delete account
- Light/dark theme, accent colors, theming
- Admin panel (list/delete users)
- PWA manifest + offline support
- Neon Auth + Neon Postgres migration
- Cloudflare Worker: /me, /app-data, /profile, admin routes

### In Progress 🔄
- Production hardening for account flows and Worker routes

---

## P0 – Harden Current Backend

- [ ] **Password reset** — Add production-grade reset flow through Neon Auth.
- [ ] **Email changes** — Implement primary/secondary email management against current backend support.
- [ ] **MFA decision** — Revisit 2FA once Neon Auth MFA requirements are defined for this app.
- [ ] **Test suite** — Smoke test all Worker routes (auth, app-data, profile, admin).

## P1 – Import / Export

- [ ] **Export to JSON** — Full data export already exists; add structured JSON with schema version
- [ ] **Import from JSON** — Restore from exported JSON bundle (with conflict resolution: skip/overwrite)
- [ ] **CSV export** — Per-category entity list as CSV (useful for inventory reports)
- [ ] **CSV import** — Bulk-create entities from CSV for a given entity type
- [ ] **QR code scanning** — Camera-based QR field scanning (the field type exists; hook up to camera API)

## P2 – UX Improvements

- [ ] **Bulk actions** — Select multiple entities → delete, move to category, export selection
- [ ] **Advanced search** — Filter by field value (e.g. "all books where status=Unread")
- [ ] **Sort options** — Sort entity list by any field, not just name
- [ ] **Due date notifications** — Push/in-app notification when entity due date is approaching (PWA push)
- [ ] **Drag-to-reorder entities** — Currently entity types are sortable; entity instances should be too
- [ ] **Gallery view improvements** — Photo/image field type that shows in gallery cards

## P3 – Collaboration & Sharing

- [ ] **Shared lists** — Share a category (read-only link) with someone without an account
- [ ] **Multi-user categories** — Invite collaborators to a shared category/inventory
- [ ] **Activity log** — Who changed what and when (useful for shared inventories)

## P4 – Polish & Mobile

- [ ] **Mobile UX pass** — Test and fix on small screens; sidebar drawer behavior
- [ ] **Install prompt** — Better PWA install prompt (currently relies on browser default)
- [ ] **Keyboard shortcuts** — Quick add, search focus, navigation
- [ ] **Changelog UI** — Surface in-app changelog entries in a readable modal

---

## Known Tech Debt

- QR field type exists in schema but camera scanning not implemented
- No automated tests for Worker routes
