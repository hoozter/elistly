/**
 * Elistly config – copy to config.js and fill in. config.js is gitignored.
 *
 * Set ELISTLY_API_URL to your Cloudflare Worker URL.
 * Set NEON_AUTH_URL to your Neon Auth URL.
 * Auth is handled by the Worker via Neon Auth; do not expose database secrets here.
 * For Pages build: run `node scripts/write-config.js`; it reads env vars and writes this file.
 */
(function () {
  'use strict';
  window.ELISTLY_API_URL = ''; // full Worker URL, e.g. https://elistly-api.xxx.workers.dev
  window.NEON_AUTH_URL = ''; // full Neon Auth URL, e.g. https://ep-xxx.neonauth.region.aws.neon.tech/neondb/auth
})();
