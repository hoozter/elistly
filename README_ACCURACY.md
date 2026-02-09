# README vs code – accuracy check

Summary of how the README compares to the actual app (as of the current codebase).

## What the README gets right

- **Modular categories, entity types, and custom fields** — Correct. Categories and entity types are fully editable; entity types support custom fields (text, number, dropdown, textarea, date, checkbox, QR code, association).
- **Multiple dashboard layouts (cards, list, gallery)** — Correct. Settings → Dashboard Layout → View mode: Category Cards, List, Gallery; plus “Group by category” and “Items per category” (3 / 5 / 10 / Show all).
- **Search across all entities** — Correct. Search matches the *display name* of entities (the title shown on cards), not every field. Clearing search returns to the dashboard.
- **Optional Supabase sync with authentication** — Correct. With `config.js` (Supabase URL + anon key), the app uses Supabase for auth and stores data in `app_data`; without config, it uses localStorage only.
- **Theme, accent, header color, logo style, and text size** — Correct. All under Settings → Appearance.
- **Quick start** — Open `index.html` for local storage; copy `config.example.js` to `config.js` for Supabase.
- **Supabase setup** — Run `supabase/schema.sql`; creates `app_data` and RLS.
- **Cloudflare Pages + Worker** — Build and deploy steps match `CLOUDFLARE_ONE_PUSH_PAGES_AND_WORKER.md`.
- **Utilities** — `refresh.html` clears local app data; `sample-data.js` holds sample data for the “Load sample data?” prompt after choosing a preset.
- **Project structure** — Files and roles are accurately described.

## What the README does not mention

- **Due & overdue** — Sidebar shows “Due & overdue” when any entity type has a date field whose name contains “due”; shows overdue items and “due in the next 7 days.”
- **Profile (when signed in)** — Profile menu: Profile (emails, display name, 2FA), Sign out. Profile modal: multiple emails, primary/secondary, verify; TOTP 2FA enable/disable; MFA verify at login when enabled.
- **Export / Import** — Settings → Data: Export (entity types, categories, entities, optional settings) to JSON; Import from JSON with preview and selective restore.
- **Add preset / Reset app** — Add preset adds categories/entity types from a template (Library, IT, Staff, Property) without wiping data. Reset app clears all data and reloads (confirmation required).
- **Restore defaults** — Restore default entity types (from built‑in presets) with option to restore fields/options; prompt after app version upgrade when new defaults exist.
- **Manage entity types / Manage categories** — Settings → Data: Entity types (fields, options, associations, name generation, “Visible in Card”); Categories (order, icons, labels).
- **Name / auto-naming** — Entity types can have “Enable auto-naming” with components (fields + separators), prefix, suffix (number or letter), and “Use auto-generated name as title.”
- **Field types** — Text, Number, Dropdown (with options), Textarea, Date, Checkbox, QR Code, Association (link to another entity type).
- **Visible in Card** — Per-field setting controlling what appears on dashboard/category cards.
- **Dashboard layout details** — View mode (Category Cards, List, Gallery), “Group by category” (for List/Gallery), “Items per category” (3 / 5 / 10 / Show all); category order is drag-sortable in Settings.
- **Onboarding** — First run shows a welcome modal to choose a preset (Blank, Library, IT, Staff, Property).
- **What’s New** — After an app version upgrade, a modal summarizes changes.
- **Changelog** — Settings → About → View Changelog (from `version-history.js`).
- **Sample data** — After choosing a non-blank preset, optional “Load sample data?” prompt; content from `sample-data.js`.
- **URL routing** — `?view=…`, `?category=…`, `?entityType=…`, `?entityId=…` for deep-linking and back button.
- **Mobile** — Responsive layout, sidebar drawer, search toggle, modal close button; touch-friendly controls.

## Clarification (not wrong, but easy to misread)

- **refresh.html** — Clears *local* app data (localStorage key `elistlyData`). When using Supabase, cloud data is unchanged; on next load the app will sync from Supabase again. So “fresh start” for local-only use is correct; for Supabase users it’s “clear local cache and reload,” not “delete my account data.”

---

No outright false statements were found in the README; it is accurate but high-level. The list above is what the app does beyond the README’s summary.
