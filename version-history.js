/**
 * Elistly version history. Loaded on demand when the user opens the Changelog
 * or when an update is available. Sets window.VERSION_CHANGES (newest first).
 */
(function () {
  'use strict';
  window.VERSION_CHANGES = [
    {
      version: '1.12.1',
      date: '2026-02-21',
      changes: [
        'Fix hidden modal overlays blocking clicks by making static modals hidden by default in the app and landing pages',
        'App shell: set #iconPickerModal and #confirmModal to hidden by default; Landing shell: set #landingLegalModal to hidden by default',
        'This preserves the no-inline-CSS rule while fixing interaction regressions where header/sign-in controls could be blocked by invisible modal overlays'
      ]
    },
    {
      version: '1.12.0',
      date: '2026-02-09',
      changes: [
        'Items per category: single control (slider 0–100 + number); 0 = show all (default), 1–100 = limit; limit now applied in dashboard for category cards, list, and gallery',
        'Checkboxes: theme styling with input-bg, custom checkmark when checked; all checkboxes use elistly-checkbox class',
        'Entity info modal: secondary background, detail spacing, and focus ring on close button',
        'Settings slider (items per category): track uses input-bg and accent-colored thumb',
        'Docs and cleanup: README logo and quick-install flow; DOCS project structure (index/app/img); deployment docs merged into one Cloudflare file (CLOUDFLARE_DEPLOY.md); refresh.html styles moved to styles.css'
      ]
    },
    {
      version: '1.11.0',
      date: '2026-02-09',
      changes: [
        'Multiple inventories (workspaces): switch between separate inventories in one account; add inventory opens preset picker (Blank, Library, IT, Staff, Property) with optional sample data',
        'Categories and entity types work both ways: assign multiple entity types per category (Edit Category) and multiple categories per entity type (Edit Entity Type)',
        'Add preset from Settings adds structure only (no sample entities); sample data is only loaded when you choose "Yes, load samples" at first setup or when adding a new inventory',
        'Display name stored in profiles table for reliable persistence across sessions',
        'Settings Data: current inventory name shown (e.g. "Inventory: Default"); click to rename',
        'Manage Categories styling and cache-busting for reliable updates after deploy'
      ]
    },
    {
      version: '1.10.0',
      date: '2026-02-08',
      changes: [
        'Entity view: read-first detail layout with edit toggle and improved dirty-state handling',
        'Name/ID generator: separator ordering fixes, duplicate suffix logic, and stricter title sourcing',
        'Custom HSV color picker with default reset and theme-matched styling',
        'Modal system updates: confirm modals, consistent actions layout, and improved close behavior',
        'QR code field type and sample data/preset improvements across setups'
      ]
    },
    {
      version: '1.9.0',
      date: '2025-06-01',
      changes: [
        'Version history moved to a separate file (version-history.js) and loaded only when viewing the changelog or update notice',
        'Setups (Library, IT, Staff, Property, Blank) moved to separate files (setup-*.js); add or reorder setups by editing the setup list in app.js'
      ]
    },
    {
      version: '1.8.0',
      date: '2025-05-28',
      changes: [
        'Entity form: Save button (replaces Create), prompt to save or discard when closing without saving',
        'Entity type form: dropdown options grid fixed for new fields (Display Value / Name Value rows). Part of Name only available when Enable auto-naming is on',
        'New field types: Number and Checkbox in entity types and entity forms',
        'Cards: fixed undefined on category views; generated names (e.g. computer autoName) and Visible in Card fields now show correctly everywhere',
        'Sample data: optional "Load sample data?" after choosing a preset; sample-data.js added for easy editing',
        'Dashboard: Gallery and List views show categories and empty states correctly when there are no items',
        'Settings: text size control (smaller A / larger A), view mode descriptions and hints, refresh.html for clearing app data via URL',
        'Fonts and settings gear: Roboto font, defensive styling, settings button works via inline handler'
      ]
    },
    {
      version: '1.7.5',
      date: '2025-05-20',
      changes: [
        'Code optimization and cleanup',
        'Fixed heading styles in dashboard views',
        'Improved CSS organization and efficiency'
      ]
    },
    {
      version: '1.7.4',
      date: '2025-04-29',
      changes: [
        'Major facelift to the dashboard',
        'Added different views to the dashboard from the settings menu',
        'Fixed other UI issues'
      ]
    },
    {
      version: '1.7.3',
      date: '2025-04-26',
      changes: [
        'Added the ability to add and edit associations to entities',
        'Fixed UI issues'
      ]
    },
    {
      version: '1.7.2',
      date: '2025-04-26',
      changes: [
        'Further consolidation of CSS',
        'Some bug fixes'
      ]
    },
    {
      version: '1.7.1',
      date: '2025-04-25',
      changes: [
        'Consolidated all CSS variables'
      ]
    }
  ];
})();
