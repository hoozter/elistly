# Elistly

<p align="center">
  <img src="img/elistly-logo.png" alt="Elistly" width="200" />
</p>

**Modular inventory. Endlessly flexible.**

Elistly is a modular inventory app for tracking things: devices, books, people, locations, and the like. You define categories and entity types with custom fields, then add and edit items. It started as an IT inventory tool and grew into a flexible system that can model different kinds of “things.” **It requires an account:** you sign in and your data is stored in the database. The installable web app caches its application shell and preserves pending account edits locally for reconnect replay. Concurrent account edits use whole-document revisions: one stale write is retained locally and reported as a conflict rather than merged automatically.

## What it’s for

You need a simple way to keep lists of tangible stuff—inventory, assets, contacts, equipment—without a heavy app or database. Elistly lets you shape the data yourself: categories, custom fields, and how items appear on the dashboard. Good fits include IT inventory, books and media, people or teams, properties or locations, or anything else you want to track as a list with your own structure.

## Key features

- **Your structure** — Categories (e.g. Books, People) and entity types (e.g. Book, Person) with custom fields: text, number, date, dropdown, checkbox, QR, links between items.
- **Flexible views** — Dashboard as category cards, list (A–Z), or gallery; “due & overdue” when you add due dates.
- **Search** — Find items by name from the header.
- **Account and database** — You always sign in; your data is stored through the Elistly Worker in Neon Postgres. Pending account edits survive reload in a local outbox and replay after reconnect. Concurrent edits use whole-document revisions, so a stale write remains local and is reported as a conflict rather than automatically merged.
- **Theming** — Light/dark, accent and header colors, logo style, text size.
- **Profile** — Download a versioned full-account backup envelope, reset data (clear app data, keep account), or delete the account. Restore from this backup is not implemented yet. Optional **Admin** controls can list and delete user accounts; see [DOCS.md](DOCS.md) and `CLOUDFLARE_DEPLOY.md`.
- **Windows Device Intake** — Settings provides the disclosed local-only collector download. In a new Computer form, **Import collected information** validates a saved report and fills only compatible existing draft fields; the ordinary Save action creates the Computer. The collector needs no administrator access and performs no network or directory lookup.

## Quick install

Elistly needs Neon Auth, Neon Postgres, and the Cloudflare Worker API. Without configured backend URLs, the app shows a “Setup required” message.

1. Clone or download the repo.
2. Copy `config.example.js` to `config.js`.
3. In [Neon](https://neon.tech): create a project, enable Neon Auth, and run the SQL in `neon/schema.sql`.
4. Deploy the Worker and set `ELISTLY_API_URL` plus `NEON_AUTH_URL` in `config.js`.
5. Open `index.html` in a browser (landing page), then click **Start using Elistly** to open the app and sign in. After that, your data is stored through the Worker in Neon Postgres.

## Basic usage

1. **First run** — Choose a preset (Blank, Library, IT, Staff, Property) or start empty.
2. **Sidebar** — Open Dashboard, optional “Due & overdue,” and your categories.
3. **Add items** — Use the + on a category card or open a category and add there. Edit by clicking an item.
4. **Settings** (gear icon) — Appearance, dashboard layout, and **Data**: manage entity types/categories, export, import, add another preset.
5. **Profile** (header → profile icon) — Display name, **Export all data**, **Reset data**, and **Delete account**. Password reset, email management, and MFA are not production-complete yet. If you’re an admin (see DOCS), the dropdown also has **Admin** to list/delete accounts.
6. **Help** — Settings → About → **Help**, or (when signed in) profile menu → **Help**.

## Screenshot

The app shows a dashboard of category cards (or list/gallery), a sidebar for navigation, and a header with search and settings. A screenshot is included as `img/elistly-app.png` on the landing page. After choosing a preset you can load sample data to see it in action.

## Full documentation

For a complete reference—concepts, current behavior, deployment, and project structure—see **[DOCS.md](DOCS.md)**. Planned work is tracked in **[ROADMAP.md](ROADMAP.md)**, including the recovered **[Windows Device Intake plan](WINDOWS_DEVICE_INTAKE_PLAN.md)**.

## Deploying

- **Static host** — Upload the repo after generating `config.js` with public backend URLs.
- **Neon baseline** — Run `neon/schema.sql`; set `config.js` or inject config in build. See `DEPLOY.md` and `NEON_MIGRATION.md`.
- **Cloudflare Pages + Worker** — See **`CLOUDFLARE_DEPLOY.md`** for full steps.

## License

Copyright and use terms are in **[LICENSE](LICENSE)**. Free to use in its current form; you may not redistribute or sell the software or derivative works. Subscription tiers (free, pro, team, business, enterprise) may be introduced later.
