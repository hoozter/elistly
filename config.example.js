/**
 * Elistly config – copy to config.js and fill in. config.js is gitignored.
 * Get keys from Supabase: Project Settings → API → Project URL and anon public key (long JWT).
 *
 * Names match Cloudflare/CI env vars so you know what to set:
 *   SUPABASE_URL, SUPABASE_ANON_KEY, ELISTLY_API_URL
 * For Pages build: run `node scripts/write-config.js`; it reads those env vars and writes this file.
 */
(function () {
  'use strict';
  window.SUPABASE_URL = 'https://your-project.supabase.co';
  window.SUPABASE_ANON_KEY = 'your-anon-public-key';
  window.ELISTLY_API_URL = ''; // optional: full Worker URL including https:// (e.g. https://elistly-api.xxx.workers.dev)
})();
