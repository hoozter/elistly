# Elistly – Full Documentation

Elistly is a modular inventory app for tracking anything: devices, books, people, locations, equipment, and other structured lists. You define categories, entity types, custom fields, and item relationships, then use the app from the browser with account-backed sync.

## Table Of Contents

1. [Concepts](#1-concepts)
2. [Getting Started](#2-getting-started)
3. [Dashboard And Views](#3-dashboard-and-views)
4. [Search And Navigation](#4-search-and-navigation)
5. [Entity Types And Fields](#5-entity-types-and-fields)
6. [Categories](#6-categories)
7. [Data Management](#7-data-management)
8. [Account And Sync](#8-account-and-sync)
9. [Admin](#9-admin)
10. [Appearance And Accessibility](#10-appearance-and-accessibility)
11. [Mobile](#11-mobile)
12. [Deployment](#12-deployment)
13. [Project Structure](#13-project-structure)
14. [Help And Changelog](#14-help-and-changelog)

## 1. Concepts

### Categories

Categories are top-level groups such as Books, Devices, People, Properties, or Equipment. They appear in the sidebar and dashboard.

### Entity Types

Entity types define the schema for items in a category. For example, a Book type might include Author, ISBN, Purchase date, and Status fields.

### Entities

Entities are the actual records you create. Each entity belongs to a category and uses one entity type.

### Data Storage

Elistly requires an account and configured backend URLs. Authentication is handled by Neon Auth, app data is stored in Neon Postgres, and browser database access goes through the Cloudflare Worker API. The browser never receives the database connection string.

App data is stored in the `app_data` table keyed by Neon Auth user id. Profile display names are stored in `profiles`, and admin membership is stored in `admin_users`.

## 2. Getting Started

### First Run

1. Configure `config.js` with `ELISTLY_API_URL` and `NEON_AUTH_URL`.
2. Run `neon/schema.sql` against your Neon database.
3. Deploy the Worker with the required Neon secrets.
4. Open `index.html`, click **Start using Elistly**, and sign in.
5. Choose a preset or start blank.

If config is missing, the app shows **Setup required** instead of loading data.

### Presets

Built-in presets include Blank, Library, IT, Staff, and Property. Presets create useful starter categories, entity types, and optional sample entities.

### Sample Data

Sample data is optional and helps you test views, fields, and dashboard behavior before entering real records.

### Clearing Local Data

The app keeps a local startup cache and durable pending-write outbox for the signed-in account. An edit whose remote save fails is restored before remote hydration after restart and retried on reconnect. The current conflict contract is whole-document revision checking: a stale write remains local and is reported as a conflict; it is never merged automatically. Resetting data from Profile clears remote app data and local cache for the signed-in account.

## 3. Dashboard And Views

### View Modes

The dashboard supports card, list, and gallery-style views depending on your settings and data.

### Group By Category

Items are grouped by category in the sidebar and dashboard. Category cards can show counts, icons, and selected item details.

### Due And Overdue

If you add due-date fields, Elistly can show due and overdue records as a focused view.

## 4. Search And Navigation

### Search

Use the header search to find entities by generated name/title. In a category view, choose an entity type and filter its configured fields and associations; these filters combine with the header search without changing stored inventory data.

### URL And Routing

The app uses lightweight client-side routing for dashboard, category, settings, admin, and modal states.

## 5. Entity Types And Fields

### Managing Entity Types

Entity types can be created, edited, restored from defaults, and assigned to categories.

### Field Types

Supported fields include text, number, date, dropdown, checkbox, URL/link, QR-related fields, and associations to other entities.

### Associations

Associations let one item reference another, such as a device assigned to a person or a book stored at a location.

### Name Generation

Entity names can be generated from selected fields so records remain consistent and scannable.

### Visible In Card

Fields marked as visible in cards appear in dashboard/category cards for quick scanning.

## 6. Categories

Categories organize records and control where entity types can be used. Category order can be customized from settings.

## 7. Data Management

### Export

Inventory export downloads selected categories, entity types, entities, and optional settings as JSON. Profile → **Export all data** creates a versioned full-account backup envelope containing authoritative app data and restorable metadata. **Restore full backup** validates and previews a compatible envelope, then replaces account data only after explicit confirmation.

Each category view also has an **Export CSV** menu. It downloads one selected entity type with `ID`, `Type`, `Name`, then configured fields and links in their configured order. The CSV is UTF-8 with a BOM and CRLF rows for spreadsheet compatibility; arrays and multi-value links use `; `, links use `Label (id)`, and structured values use stable JSON. Cells beginning with `=`, `+`, `-`, or `@` are prefixed with an apostrophe to prevent spreadsheet formula execution while retaining the visible value.

### Import

Import previews and merges the current top-level selective inventory format. **Import CSV** requires selecting one existing entity type and explicitly mapping CSV columns to its existing fields or links. It previews every proposed row, including ignored columns and validation errors, and creates rows only after a valid review. It never creates or modifies schemas, options, People, or link targets. CSV input is size- and parser-bounded; an export-added formula-safety apostrophe is decoded only when it precedes a spreadsheet formula prefix. Use **Restore full backup** for the validated full-account replacement workflow.

### Add Preset

You can add a preset after first setup to merge additional categories, entity types, and sample records.

### Reset Data

Profile → **Reset data** clears the signed-in user’s app data in Neon Postgres and local cache. The account remains.

## 8. Account And Sync

Elistly always runs with an account.

- **Authentication** uses Neon Auth through `NEON_AUTH_URL`.
- **App data** is read and written through the Cloudflare Worker at `ELISTLY_API_URL`.
- **Storage** uses Neon Postgres tables from `neon/schema.sql`.
- **Local cache and outbox** make startup responsive, restore pending edits before remote hydration, and replay one queued conditional write at a time after reconnect.
- **Conflict handling** uses whole-document revisions. Concurrent edits—including different records—can conflict; the stale local candidate is retained and surfaced, never automatically merged.

Opening the app without a session shows the sign-in screen. Signing out clears the local auth token and returns to sign-in.

The current Neon adapter supports sign-up, signup verification, sign-in, session refresh, and sign-out. Password reset, email management, and MFA are unsupported, so the browser does not offer controls that promise those actions.

## 9. Admin

Admin features require the Worker and `admin_users` table.

- The first Neon Auth user becomes admin automatically when no active admins exist.
- `ELISTLY_ADMIN_EMAILS` can be set on the Worker as a recovery allowlist.
- The Admin page lists Neon Auth users and can delete an account plus its app/profile/admin rows.

Worker secrets:

- `NEON_DATABASE_URL`
- `NEON_AUTH_URL`
- `NEON_AUTH_JWKS_URL`
- Optional: `ELISTLY_ADMIN_EMAILS`

## 10. Appearance And Accessibility

Elistly supports light/dark themes, accent color, header color, logo style, and text size preferences. UI controls use semantic labels where possible and Material Icons for visual affordances.

## 11. Mobile

Elistly is designed as an installable browser app. The manifest and service worker cache a versioned application shell where browser support allows it. Online navigations use the fresh document; offline navigations fall back to the installed shell. Runtime `config.js` is always fetched from the network and is never cached. A new shell waits for pending local writes to reach a synced state before activation and reload, so an update does not discard the durable outbox.

## 12. Deployment

### Local / Static Frontend

Copy `config.example.js` to `config.js`, set `ELISTLY_API_URL` and `NEON_AUTH_URL`, then serve or open the app.

### Neon

Create a Neon project, enable Neon Auth, and run:

```bash
psql "$NEON_DATABASE_URL" -f neon/schema.sql
```

### Cloudflare Pages

Use:

- Build command: `node scripts/write-config.js`
- Build output directory: `/`
- Environment variables: `ELISTLY_API_URL`, `NEON_AUTH_URL`

### Cloudflare Worker

Deploy from `worker/` with Wrangler and set the Worker secrets listed in [Admin](#9-admin). See `CLOUDFLARE_DEPLOY.md` for the complete flow.

## 13. Project Structure

| Path | Purpose |
|---|---|
| `index.html` | Landing page and app entry redirect |
| `app.html` | Main app shell |
| `app.js` | Main frontend application logic |
| `lib/db.js` | Browser auth/session client for Neon Auth and Worker calls |
| `config.example.js` | Public frontend config template |
| `scripts/write-config.js` | Writes `config.js` from deployment environment variables |
| `neon/schema.sql` | Neon Postgres schema for app data, profiles, and admins |
| `worker/src/index.js` | Cloudflare Worker API for auth/session checks, data, profile, and admin routes |
| `CLOUDFLARE_DEPLOY.md` | Cloudflare Pages + Worker deployment guide |
| `DEPLOY.md` | Short deploy notes |
| `NEON_MIGRATION.md` | Current Neon architecture/status notes |

## 14. Help And Changelog

In-app help is powered by `faq.js`. Version history and the changelog are loaded from `version-history.js`.
