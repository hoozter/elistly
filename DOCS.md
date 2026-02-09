# Elistly – Full documentation

**Modular inventory. Endlessly flexible.**

This is the complete reference for Elistly: concepts, features, deployment, and project layout. For a short “what is this and how do I run it?” see [README.md](README.md).

---

## Table of contents

1. [Concepts](#1-concepts)
2. [Getting started](#2-getting-started)
3. [Dashboard and views](#3-dashboard-and-views)
4. [Search and navigation](#4-search-and-navigation)
5. [Entity types and fields](#5-entity-types-and-fields)
6. [Categories](#6-categories)
7. [Data: export, import, presets, reset](#7-data-export-import-presets-reset)
8. [Account and Supabase](#8-account-and-supabase)
9. [Appearance and accessibility](#9-appearance-and-accessibility)
10. [Mobile](#10-mobile)
11. [Deployment](#11-deployment)
12. [Project structure](#12-project-structure)
13. [In-app help and changelog](#13-in-app-help-and-changelog)

---

## 1. Concepts

### Categories

**Categories** are the top-level groups in the sidebar (e.g. Books, People, Devices). Each has a label and an icon. They define how you navigate: clicking a category shows all entities that belong to it. Category order is drag-sortable in Settings → Data → Manage categories.

### Entity types

An **entity type** is the “shape” of one kind of item. It defines:

- **Label** (e.g. “Book”, “Person”)
- **Category** it belongs to
- **Fields** (name, title, author, due date, dropdown, checkbox, etc.)
- **Associations** (e.g. Book → Borrower)
- Optional **name generation** (auto-build a display name from fields)
- Which fields are **Visible in Card** (what shows on dashboard/category cards)

You can have several entity types in one category (e.g. Book and Magazine under “Library”).

### Entities

**Entities** are the actual items: one record per “row” (e.g. one book, one person). Each entity has an id, a type, and values for that type’s fields and associations. The **display name** of an entity is either a manual name, an auto-generated name (if name generation is on), or a fallback; this is what search matches and what appears on cards.

### Data storage

Elistly **requires an account**. You must configure Supabase (see Quick install in the README). Without config, the app shows a “Setup required” message and does not run.

When you sign in, your data is stored in the **`app_data`** table in your Supabase project, keyed by user id. The app reads and writes this row; when you’re logged in, it syncs with the database. It is designed to work offline (e.g. as an installable web app on Android) and to sync when the device is back online. Row Level Security ensures each user only sees their own row.

---

## 2. Getting started

### First run

On first run (no saved data), the app shows an **onboarding** modal: choose a preset (Blank, Library, IT, Staff, Property). Each preset adds categories and entity types; Blank starts empty. You can remove or edit anything later.

### Presets

- **Blank** — No categories or entity types.
- **Library** — Categories and types for books, borrowers, lending.
- **IT** — Devices, people, typical IT asset fields.
- **Staff** — Teams and people.
- **Property** — Properties and related types.

You can **add** another preset later without wiping data: Settings → Data → Add preset. Your existing categories and entity types are kept; the preset’s are merged in.

### Sample data

After you choose a non-blank preset, the app may offer to **load sample data** (from `sample-data.js`). This adds example entities so you can see the preset in action. You can delete or edit them like any other data.

### Clearing local data

**`refresh.html`** clears the app’s localStorage key in this browser and shows a link back to the app. It does **not** delete your data in the database. When you open the app again and sign in, your data will load from the database. To permanently delete all your data (including from the database), use Settings → Data → **Reset app** (see [Data: export, import, presets, reset](#7-data-export-import-presets-reset)).

---

## 3. Dashboard and views

### View modes

Settings → Dashboard Layout → **View mode**:

- **Category Cards** — One card per category; inside each card, item cards (or a list of items). Best for grouped inventory (e.g. Books, People).
- **List** — All items in rows, grouped by first letter (A–Z). Best for long lists you scan by name.
- **Gallery** — Same item cards in a grid. With **Group by category** on, one section per category; with it off, one A–Z grid.

### Group by category

For List and Gallery only. When on, items are grouped by category. When off (List), you get a single A–Z list; when off (Gallery), a single grid. For Category Cards view, grouping is always by category (the option is disabled).

### Items per category

How many items to show per category on the dashboard (3, 5, 10, or **Show all**). Does not apply to the single A–Z List view.

### Due & overdue

If any entity type has a **date** field whose **name** contains “due” (e.g. “Due date”), a **Due & overdue** link appears in the sidebar. It shows:

- **Overdue** — Items whose due date is before today.
- **Due in the next 7 days** — Due today or in the next week.

Items are sorted by due date. The due field is detected by type (date) and label/name; you can add such a field in Manage entity types.

---

## 4. Search and navigation

### Search

The header search box matches the **display name** of entities (the title shown on cards). It does not search inside every field. Typing shows a results list; clearing the box returns you to the dashboard. On mobile, tap the search icon to open the search bar.

### URL and routing

The app uses the URL for deep-linking and back/forward:

- `?view=dashboard` — Main dashboard.
- `?view=overdue` — Due & overdue (if available).
- `?category=<id>` — Category view (same as clicking a category).
- `?entityType=<id>&entityId=<id>` — Opens the entity form for that item.

You can bookmark or share these URLs. The sidebar and in-app navigation update the URL so the back button works as expected.

---

## 5. Entity types and fields

### Managing entity types

Settings → Data → **Entity types**. From there you can add, edit, reorder, and delete entity types. Each type has:

- Label, icon, category
- Fields (see below)
- Associations (links to other entity types)
- Name generation (optional)
- Per-field **Visible in Card**

### Field types

| Type        | Description |
|------------|-------------|
| Text       | Single-line text. |
| Number     | Numeric value. |
| Textarea   | Multi-line text. |
| Date       | Date picker. Use a name containing “due” for Due & overdue. |
| Dropdown   | Single choice from options you define (label + value). |
| Checkbox   | Boolean (yes/no). |
| QR Code    | Stores a value; can show a QR representation. |
| Association| Link to another entity type (e.g. Book → Borrower). You choose the target type and how the relation is shown. |

Fields can be required and can be marked **Part of name** when name generation is enabled (they are used in the auto-generated name).

### Associations

An **association** field links an entity to another entity (e.g. “Lent to” → Person). You pick the target entity type. When editing an entity, you select from existing entities of that type. The UI shows the target’s display name.

### Name generation

For an entity type you can enable **Generate name from fields**. You then define:

- **Components order** — A sequence of fields and separators (e.g. First name + space + Last name).
- **Prefix** / **Suffix** — Optional; suffix can be numbers (1, 2, 3…) or letters (a, b, c…).
- **Use auto-generated name as title** — If on, that name is the entity’s display name everywhere (cards, search, links).

If you turn this off or edit components, existing entities keep their last generated or manual name until you save them again.

### Visible in Card

Per field, **Visible in Card** controls whether that field appears on the small cards in the dashboard and category views. Only fields with this on are shown on cards (plus the item’s title/name).

---

## 6. Categories

### Managing categories

Settings → Data → **Categories**. Add, edit, or delete categories. Each has a label and an icon (from the same icon set as entity types). The order in this list is the order in the sidebar.

### Category order

In the category manager, you can **drag** categories to reorder. That order is used in the sidebar and on the dashboard (for Category Cards and for grouped List/Gallery).

---

## 7. Data: export, import, presets, reset

### Export

Settings → Data → **Export**. Choose:

- Which **entity types** to export (and optionally which fields and dropdown options).
- Which **categories**.
- Which **entities** (actual items).
- Whether to include **settings**.

A JSON file is downloaded. Use it as a backup or to move data to another browser/account.

### Import

Settings → Data → **Import**. Select a JSON file (from a previous export or compatible structure). The app shows a **preview** and lets you choose what to import (types, categories, entities). Existing data is merged; you can uncheck items to avoid overwriting. After import, the app reloads the view.

### Add preset

Settings → Data → **Add preset**. Adds the categories and entity types from a chosen template (Library, IT, Staff, Property) **without** deleting your current data. Your existing categories and entity types are kept; the preset’s are added. Useful to add, for example, Library on top of an existing setup.

### Reset app

Settings → Data → **Reset app**. This **permanently deletes all your data**—categories, entity types, entities, and settings—from this device and from your account in the database. It cannot be undone. The app asks you to type **DELETE** to confirm. After reset, the page reloads and you’ll see the first-run welcome screen again.

### Restore defaults

After an **app version upgrade**, you may be prompted to **restore default entity types** when the app ships new or updated types (e.g. new fields). Restore defaults lets you bring back the built-in structure for selected types and optionally restore fields/options. Your own **entities** and **categories** are not removed; only the type definitions are updated to match the app’s defaults.

---

## 8. Account and Supabase

### Account required

Elistly always runs with an account. You must configure Supabase (`config.js` with `supabaseUrl` and `supabaseAnonKey`). If config is missing, the app shows a “Setup required” message and does not load data. Once configured, you sign in and your data is stored in the database; the app syncs with it and is designed to work offline and sync when back online (e.g. installable web app on Android).

### What Supabase does

- Sign-in, sign-up, and password reset use Supabase Auth.
- App data is stored in the `app_data` table, one row per user (`user_id` + `payload` JSON). When you’re signed in, the app reads and writes this row; it is designed to work offline and sync when the device is online again.
- Row Level Security ensures each user only read/write their own row.

### Sign in / sign out

With Supabase configured, opening the app shows the sign-in screen if there is no session. After sign-in, the **profile** icon in the header opens a dropdown: **Profile**, **Help**, **Sign out**. Sign out clears the session and reloads; you’ll see the sign-in screen again.

### Profile

Profile (header → profile icon → Profile) opens the **profile modal**:

- **Display name** (if supported by your Supabase setup).
- **Emails** — Primary and secondary emails; add, verify, remove. You can change which email is primary.
- **Two-factor authentication (2FA)** — Enable or disable TOTP. When enabled, you’ll enter a code from an authenticator app after signing in.

### 2FA / TOTP

In Profile you can enable **TOTP** (e.g. Google Authenticator). The app shows a QR code and secret. After you add it to your app, you’ll be asked for the code on each sign-in. Disabling 2FA is done from the same profile screen (you may need to confirm with a code).

---

## 9. Appearance and accessibility

### Theme and colors

Settings → **Appearance**:

- **Theme** — Light, Dark, or (if available) follow system.
- **Accent color** — Used for links, buttons, highlights. Custom picker.
- **Header color** — Top bar background; text color is chosen for contrast.
- **Logo style** — Color, White, or Black (for the header logo).

### Text size

Settings → Appearance → **Text size**: smaller A to larger A. Affects base font size across the app (labels, body text, controls).

### In-app Help

Settings → About → **Help**, or (when signed in) profile menu → **Help**. Opens the FAQ modal with sections on getting started, dashboard, search, entity types, data, account, mobile, and troubleshooting.

---

## 10. Mobile

The app is **responsive**:

- **Sidebar** becomes a drawer: tap the **menu** (hamburger) icon to open; tap the overlay or a link to close.
- **Search** — On small screens, tap the search icon to show the search bar.
- **Modals** — Full-width friendly; **close** button (X) in the top-right is touch-sized on mobile. Tapping outside the modal also closes it.
- **Touch targets** — Buttons and controls are sized for touch (e.g. 44px minimum where appropriate).
- **Settings and forms** — Layout stacks and scrolls; nested buttons and inputs are enlarged in modals so they stay usable.

---

## 11. Deployment

### Local / static

- The app must have Supabase configured (see README). Run it by opening **index.html** (or serving the folder). Copy `config.example.js` to `config.js` and set `supabaseUrl` and `supabaseAnonKey`.

### Supabase backend

1. Create a Supabase project.
2. In the SQL Editor, run the contents of **`supabase/schema.sql`**. This creates `app_data` and RLS policies (safe to re-run).
3. (Optional) Configure Auth: email confirmation, MFA, etc. See Supabase docs.
4. In the app, set `config.js` (or inject config at build time) with Project URL and anon key.

See **`DEPLOY.md`** for a concise checklist.

### Cloudflare Pages (frontend)

- Connect the repo to Cloudflare Pages. Build command: **`node scripts/write-config.js`**. Output directory: **`/`** (or your static output).
- Set environment variables **`SUPABASE_URL`** and **`SUPABASE_ANON_KEY`** so the build script can write `config.js` from env. No secrets in the repo.

### Cloudflare Worker (API)

- Optional. If you use a Worker (e.g. for extra API routes), put it in **`worker/`** and connect the same repo to a Worker with root **`worker/`**, deploy command **`npx wrangler deploy`**. Secrets (e.g. Supabase service role key) go in the Worker’s Variables and Secrets in the dashboard.

Full flow: **`CLOUDFLARE_ONE_PUSH_PAGES_AND_WORKER.md`**.

### Supabase Edge Functions

- Optional. Deploy from CLI (e.g. `supabase functions deploy health`). Set secrets in the Supabase dashboard. Used for server-side logic; not required for the core app.

---

## 12. Project structure

| Path | Purpose |
|------|--------|
| `index.html` | Single-page app shell; header, sidebar, main content, modals. |
| `app.js` | Main application logic: data, UI, auth, export/import, entity types, categories. |
| `styles.css` | All styles; theme variables, layout, responsive rules. |
| `config.example.js` | Template for config; copy to `config.js` (gitignored) and add Supabase keys. |
| `config.js` | Supabase URL and anon key (gitignored; created at build or by hand). |
| `setup-blank.js`, `setup-library.js`, etc. | Starter presets; register in `window.ELISTLY_PRESETS`. |
| `sample-data.js` | Optional sample entities per preset; used for “Load sample data?”. |
| `faq.js` | In-app FAQ content (`window.ELISTLY_FAQ`); used by the Help modal. |
| `version-history.js` | Changelog entries (`window.VERSION_CHANGES`); used by Changelog and What’s New. |
| `refresh.html` | Utility page that clears localStorage and links back to the app. |
| `scripts/write-config.js` | Build script: writes `config.js` from env vars (e.g. `SUPABASE_URL`, `SUPABASE_ANON_KEY`). |
| `supabase/schema.sql` | Table `app_data` and RLS policies for Supabase. |
| `supabase/functions/` | Optional Edge Functions (e.g. health). |
| `worker/` | Optional Cloudflare Worker (e.g. API); `wrangler.toml`, `src/index.js`. |

---

## 13. In-app help and changelog

### Help (FAQ)

- **Settings → About → Help**, or **Profile menu → Help** (when signed in).
- Opens a modal with the full FAQ: getting started, dashboard, search, entity types, data, account, appearance, mobile, troubleshooting. Content is in **`faq.js`**.

### Changelog

- **Settings → About → View Changelog**.
- Shows version history from **`version-history.js`** (newest first). Loaded on demand.

### What’s New

- After an **app version upgrade**, if the stored version is older than the current one, the app may show a **What’s New** modal with the latest changelog entry. You can dismiss it and open the full Changelog from Settings anytime.
