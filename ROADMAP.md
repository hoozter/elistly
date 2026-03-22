# Elistly – Roadmap

**Last updated:** 2026-03-22
**Status:** Active development. Neon migration in progress.

Elistly is a modular inventory app for tracking anything — devices, books, people, locations. Users define their own entity types and custom fields. Data is stored in the database (Supabase/Neon) and designed for offline-first PWA use.

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
- Neon migration: Worker API surface extracted, schema ready
- Cloudflare Worker: /me, /app-data, /profile, admin routes

### In Progress 🔄
- Neon backend migration (auth still Supabase-backed)
- Neon schema ready (`neon/schema.sql`) but auth not yet migrated

---

## P0 – Complete Neon Migration

- [ ] **Migrate auth to Neon** — Replace Supabase auth with JWT-based auth against Neon. Worker handles `/auth/login`, `/auth/register`, `/auth/refresh`.
- [ ] **Remove Supabase dependency** — Once auth is migrated, Supabase config (`config.js`) becomes optional/removed
- [ ] **Deploy on Cloudflare Workers** — Worker as the sole backend; frontend points to Worker URL only
- [ ] **Test suite** — Smoke test all Worker routes after migration (auth, app-data, profile, admin)

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

- Auth still coupled to Supabase despite Neon migration of data layer
- `config.js` has dual Supabase/Neon config paths — should consolidate post-migration
- QR field type exists in schema but camera scanning not implemented
- No automated tests for Worker routes
