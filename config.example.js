/**
 * Elistly config – copy to config.js and fill in. config.js is gitignored.
 * Get keys from Supabase: Project Settings → API → Project URL and anon public key (long JWT).
 * For Cloudflare Pages: set env vars SUPABASE_URL and SUPABASE_ANON_KEY, then
 * run `node scripts/write-config.js` in the build step; it writes config.js from env.
 */
(function () {
  'use strict';
  window.ELISTLY_CONFIG = {
    supabaseUrl: 'https://your-project.supabase.co',
    supabaseAnonKey: 'your-anon-public-key'
  };
})();
