/**
 * Elistly config – copy to config.js and fill in. config.js is gitignored.
 *
 * Preferred provider-neutral names:
 *   ELISTLY_BACKEND_PROVIDER, ELISTLY_BACKEND_URL, ELISTLY_PUBLIC_KEY, ELISTLY_API_URL
 *
 * Backward-compatible Supabase names are still supported during migration:
 *   SUPABASE_URL, SUPABASE_ANON_KEY
 *
 * For Pages build: run `node scripts/write-config.js`; it reads env vars and writes this file.
 */
(function () {
  'use strict';
  window.ELISTLY_BACKEND_PROVIDER = 'supabase';
  window.ELISTLY_BACKEND_URL = 'https://your-project.supabase.co';
  window.ELISTLY_PUBLIC_KEY = 'your-anon-public-key';
  window.ELISTLY_API_URL = ''; // optional: full Worker URL including https:// (e.g. https://elistly-api.xxx.workers.dev)
  window.SUPABASE_URL = window.ELISTLY_BACKEND_URL;
  window.SUPABASE_ANON_KEY = window.ELISTLY_PUBLIC_KEY;
})();
