# Deploy Elistly to Cloudflare with Neon

Elistly uses:

- **Cloudflare Pages** for the static frontend.
- **Cloudflare Worker** for the API.
- **Neon Auth** for signup/login and session JWTs.
- **Neon Postgres** for app data.

The frontend must never receive the Neon database connection string.

## Cloudflare Pages

Connect this GitHub repo to Cloudflare Pages.

Build settings:

- Framework preset: `None`
- Build command: `node scripts/write-config.js`
- Build output directory: `/`

Production environment variables:

- `ELISTLY_API_URL` = the Worker URL, for example `https://elistly-api.<subdomain>.workers.dev`
- `NEON_AUTH_URL` = the Neon Auth URL, ending in `/auth`

Pages deploys from the repo root and generates `config.js` during the build.

## Cloudflare Worker

Connect the same GitHub repo to a Cloudflare Worker project, or deploy manually with Wrangler.

Build/deploy settings:

- Root directory: `worker`
- Build command: `npm install`
- Deploy command: `npx wrangler deploy`

Worker secrets:

- `NEON_DATABASE_URL` = Neon pooled Postgres connection string
- `NEON_AUTH_URL` = Neon Auth URL
- `NEON_AUTH_JWKS_URL` = Neon Auth JWKS URL

Optional Worker secret:

- `ELISTLY_ADMIN_EMAILS` = comma-separated admin email recovery allowlist

## Admin Bootstrap

The first Neon Auth user becomes admin automatically when there are no active Neon Auth admins yet.

After deployment:

1. Open the app.
2. Create your account first.
3. Open the profile menu.
4. The Admin link should appear after `/admin/me` confirms admin status.

If you need recovery access later, set `ELISTLY_ADMIN_EMAILS` to your email and redeploy/retry.

## Deployment Flow

If Cloudflare Pages and the Worker are both connected to GitHub, pushing to `main` should trigger both deployments. If the Worker is not connected to GitHub, deploy it manually:

```bash
cd worker
npx wrangler deploy
```

Wrangler deployment requires `wrangler login` on this machine.
