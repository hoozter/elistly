# Elistly Deploy Notes

## Backend

Elistly now uses Neon:

- Neon Auth for signup/login.
- Neon Postgres for app data.
- Cloudflare Worker for API access to Neon Postgres.

Run or verify `neon/schema.sql` against the Neon database before production deploy.

## Frontend Config

For local development, copy `config.example.js` to `config.js` and set:

- `ELISTLY_API_URL`
- `NEON_AUTH_URL`

For Cloudflare Pages, set the same variables in Pages environment variables. The build command `node scripts/write-config.js` writes `config.js`.

## Worker Config

Set these Worker secrets:

- `NEON_DATABASE_URL`
- `NEON_AUTH_URL`
- `NEON_AUTH_JWKS_URL`

Optional:

- `ELISTLY_ADMIN_EMAILS`

Set the required non-secret Worker variable `ELISTLY_ALLOWED_ORIGINS` to a comma-separated allowlist of exact frontend HTTP(S) origins. The checked-in production default is `https://elistly.com`; override it explicitly for another deployment. Do not use `*`, paths, or trailing slashes. Missing or malformed configuration fails every request closed, and an unlisted `Origin` receives `403` without credentialed CORS headers.

See `CLOUDFLARE_DEPLOY.md` for the full Cloudflare setup.
