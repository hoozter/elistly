# Elistly

**Modular inventory. Endlessly flexible.**

Elistly is a modular inventory app for tracking things: devices, books, people, locations, and the like. You define categories and entity types with custom fields, then add and edit items. It started as an IT inventory tool and grew into a flexible system that can model different kinds of “things.” **It requires an account:** you sign in and your data is stored in the database. The app is designed to work offline (e.g. as an installable web app on Android) and sync when back online.

## What it’s for

You need a simple way to keep lists of tangible stuff—inventory, assets, contacts, equipment—without a heavy app or database. Elistly lets you shape the data yourself: categories, custom fields, and how items appear on the dashboard. Good fits include IT inventory, books and media, people or teams, properties or locations, or anything else you want to track as a list with your own structure. Sign in once and your data is in the database; use it anywhere, including offline, and it syncs when you’re back online.

## Key features

- **Your structure** — Categories (e.g. Books, People) and entity types (e.g. Book, Person) with custom fields: text, number, date, dropdown, checkbox, QR, links between items.
- **Flexible views** — Dashboard as category cards, list (A–Z), or gallery; “due & overdue” when you add due dates.
- **Search** — Find items by name from the header.
- **Account and database** — You always sign in; your data is stored in the database and syncs when online. The app is designed to work offline and sync when back online (e.g. installable web app on Android).
- **Theming** — Light/dark, accent and header colors, logo style, text size.

## Quick install

Elistly needs Supabase (your backend and database). Without it, the app shows a “Setup required” message.

1. Clone or download the repo.
2. Copy `config.example.js` to `config.js`.
3. In [Supabase](https://supabase.com): create a project, run the SQL in `supabase/schema.sql` (SQL Editor).
4. In Supabase → Project Settings → API: copy **Project URL** and **anon public** key into `config.js` as `supabaseUrl` and `supabaseAnonKey`.
5. Open `index.html` in a browser. You’ll get the sign-in screen; after that, your data is stored in the database and syncs when online. The app is designed to work offline and sync when back online (e.g. for an installable web app on Android).

## Basic usage

1. **First run** — Choose a preset (Blank, Library, IT, Staff, Property) or start empty.
2. **Sidebar** — Open Dashboard, optional “Due & overdue,” and your categories.
3. **Add items** — Use the + on a category card or open a category and add there. Edit by clicking an item.
4. **Settings** (gear icon) — Appearance, dashboard layout, and **Data**: manage entity types/categories, export, import, add another preset, or reset the app.
5. **Help** — Settings → About → **Help**, or (when signed in) profile menu → **Help**.

## Screenshot

The app shows a dashboard of category cards (or list/gallery), a sidebar for navigation, and a header with search and settings. After choosing a preset you can load sample data to see it in action.

## Full documentation

For a complete reference—concepts, all features, deployment, and project structure—see **[DOCS.md](DOCS.md)**.

## Deploying

- **Static host** — Upload the repo (after building if you use `scripts/write-config.js` for config). Supabase provides the backend and database.
- **Supabase** — Run `supabase/schema.sql`; set `config.js` (or inject config in build). See [DOCS.md](DOCS.md) and `DEPLOY.md`.
- **Cloudflare Pages + Worker** — See `CLOUDFLARE_ONE_PUSH_PAGES_AND_WORKER.md` for one-repo deploy.

## License

Copyright and use terms are in **[LICENSE](LICENSE)**. Free to use in its current form; you may not redistribute or sell the software or derivative works. Subscription tiers (free, pro, team, business, enterprise) may be introduced later.
