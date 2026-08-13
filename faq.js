/**
 * Elistly in-app FAQ. Loaded before app.js. Exposes window.ELISTLY_FAQ.
 * Used by App.showFaqModal() for the Help / FAQ modal (Settings → About, Profile menu).
 */
(function () {
  'use strict';
  window.ELISTLY_FAQ = [
    {
      section: 'Getting started',
      items: [
        {
          q: 'What is Elistly?',
          a: 'Elistly is a modular inventory app for tracking anything: books, devices, people, locations, and more. You define categories (e.g. Books, People) and entity types (e.g. Book, Person) with custom fields, then add and edit items. It uses Neon Auth, Neon Postgres, and the Elistly Worker API for account-backed sync.'
        },
        {
          q: 'How do I start from scratch?',
          a: 'Open the app. On first run you’ll see a welcome screen to pick a preset: Blank (empty), Library, IT assets, Staff, Property. You can change or remove anything later. To clear app data for your account, use Profile → Reset data and type RESET to confirm.'
        },
        {
          q: 'What’s the difference between a category and an entity type?',
          a: 'A category is a group that appears in the sidebar (e.g. Books, People). An entity type is the “shape” of one kind of item: its fields (title, author, due date, etc.) and which category it belongs to. You can have several entity types in one category (e.g. Books and Magazines under “Library”).'
        }
      ]
    },
    {
      section: 'Dashboard and views',
      items: [
        {
          q: 'What are the dashboard view modes?',
          a: 'Under Settings → Dashboard Layout you can choose: Category Cards (one card per category with item cards inside), List (rows grouped A–Z by name), or Gallery (card grid; optional “Group by category”). You can also set how many items per category to show: use the slider or number (0 = show all, 1–100 = limit).'
        },
        {
          q: 'What appears on each card?',
          a: 'For each entity type, in Manage entity types → [type] → fields, you can mark which fields are “Visible in Card.” Those fields (and the item’s name/title) are what show on dashboard and category cards.'
        },
        {
          q: 'What is “Due & overdue”?',
          a: 'If any entity type has a date field whose name contains “due” (e.g. “Due date”), a “Due & overdue” link appears in the sidebar. It shows items that are past due and items due in the next 7 days.'
        }
      ]
    },
    {
      section: 'Search and navigation',
      items: [
        {
          q: 'How does search work?',
          a: 'Type in the header search box to match item display names (the titles shown on cards). In a category view, choose an entity type and then filter its configured fields or links: text fields contain text without case sensitivity; number and date filters compare with the selected operator; dropdowns, checkboxes, and links match exact stored values; array values contain the selected value. Filters combine with the header search and with each other. Clear filters removes only the view filters and never changes inventory data. On mobile, tap the search icon to open the search bar.'
        },
        {
          q: 'Can I share a link to a specific view or item?',
          a: 'Yes. The app uses the URL (e.g. ?view=books, ?category=people, ?entityType=book&entityId=abc). You can bookmark or share these links; opening them will show that view or open that entity.'
        }
      ]
    },
    {
      section: 'Entity types and fields',
      items: [
        {
          q: 'What field types can I add?',
          a: 'Text, Number, Textarea, Date, Dropdown (with custom options), Checkbox, QR Code (stores a value and can show a QR), and Association (link to another entity type, e.g. “Book” → “Borrower”).'
        },
        {
          q: 'What is “auto-naming” or “name generation”?',
          a: 'For an entity type you can enable “Generate name from fields.” You define an order of fields and separators (e.g. First name + space + Last name) and optional prefix/suffix (e.g. numbers 1, 2, 3). The app then builds a single display name for each item. You can choose to use that as the “title” shown everywhere.'
        },
        {
          q: 'What is “Visible in Card”?',
          a: 'Per field, you can turn “Visible in Card” on or off. Only fields with this on appear on the small cards in the dashboard and category views.'
        }
      ]
    },
    {
      section: 'Data and settings',
      items: [
        {
          q: 'How do I export my data?',
          a: 'Settings → Data → Export downloads selected entity types, categories, entities, and optional settings as JSON. Profile → Export all data downloads a schema-versioned full-account backup envelope containing all stored inventory data and restorable metadata. Restore from that backup remains roadmap work.'
        },
        {
          q: 'How do I import data?',
          a: 'Settings → Data → Import. Select a JSON file (from a previous export or compatible format). You’ll see a preview and can choose what to import (entity types, categories, entities). Existing data is merged; you can uncheck items you don’t want to overwrite.'
        },
        {
          q: 'What does “Add preset” do?',
          a: 'Settings → Data → Add preset. It adds categories and entity types from a template (Library, IT, Staff, Property) without deleting your current data. Useful to add e.g. “Library” on top of an existing setup.'
        },
        {
          q: 'What does “Reset app” do?',
          a: 'Profile → Reset data permanently clears your app data—categories, entity types, entities, and settings—from this device and from your account in the database. It cannot be undone. The app asks you to type RESET to confirm.'
        },
        {
          q: 'What is “Restore defaults”?',
          a: 'After an app update, you may be prompted to restore default entity types (e.g. new fields added by the app). Restore defaults lets you bring back the built‑in structure for chosen types and optionally restore fields/options. Your own entities and categories are not removed.'
        }
      ]
    },
    {
      section: 'Account and sync',
      items: [
        {
          q: 'Do I need an account?',
          a: 'Yes. Elistly requires an account. Configure Neon Auth, Neon Postgres, and the Worker API as described in the README; without those URLs, the app shows “Setup required” and won’t run. Once signed in, your data is stored in the database and syncs when online.'
        },
        {
          q: 'Can I use it offline or as an installable app?',
          a: 'The application shell can be installed and cached where the browser supports PWAs. Durable offline edits and automatic reconnect replay are not release-proven yet, so do not rely on offline changes until that roadmap work is complete.'
        },
        {
          q: 'How do I sign in or sign out?',
          a: 'With Neon Auth configured, opening the app shows sign-in if you’re not logged in. Once signed in, use the profile icon in the header → Sign out. Profile opens your account settings.'
        },
        {
          q: 'Can I have multiple emails on my account?',
          a: 'Not reliably yet. Parts of the profile UI exist, but secondary-email verification and primary-email changes are not production-complete against the current backend.'
        },
        {
          q: 'What is 2FA / TOTP?',
          a: 'Two-factor authentication (2FA/TOTP) would add an authenticator-code step at login. Elistly’s current MFA controls are not production-complete against the current backend and should not be relied on until the roadmap implementation and tests are complete.'
        }
      ]
    },
    {
      section: 'Appearance and mobile',
      items: [
        {
          q: 'How do I change the look?',
          a: 'Settings → Appearance: Theme (light/dark), Accent color, Header color, Logo style (color/white/black), and Text size (smaller A to larger A).'
        },
        {
          q: 'Does it work on mobile?',
          a: 'Yes. On small screens the sidebar becomes a menu (tap the hamburger icon); search can be opened from an icon; modals and forms are sized for touch. Tap outside a modal or use the X in the top-right corner to close it.'
        }
      ]
    },
    {
      section: 'Tips and troubleshooting',
      items: [
        {
          q: 'I opened refresh.html. Is my data gone?',
          a: 'No. Clearing local browser data only removes this device’s cache. Your data remains in the database. When you open the app again and sign in, it will load from the database. To clear remote app data too, use Profile → Reset data and type RESET to confirm.'
        },
        {
          q: 'Where is my data stored?',
          a: 'In Neon Postgres in the app_data table, keyed by your Neon Auth user id. The Worker authorizes requests before reading or writing your data.'
        }
      ]
    }
  ];
})();
