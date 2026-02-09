# Elistly – Deploy and Supabase setup

## 1. Supabase

1. Run the schema in the Supabase SQL Editor (Dashboard → SQL Editor): paste and run the contents of **`supabase/schema.sql`**. It creates the `app_data` table + RLS policies (safe to re-run).
2. (Optional) Enable email confirmation under Authentication → Providers → Email. For testing you can leave it off.
3. TOTP (2FA): Authentication → Providers → enable MFA if desired; the app promotes it in Settings but does not require it.

## 2. Local config

- Copy **`config.example.js`** to **`config.js`** (config.js is gitignored).
- Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in config.js (Project Settings → API: Project URL and **anon public** key, the long JWT). Optional: `ELISTLY_API_URL` for the Worker (delete account / admin).

## 3. Cloudflare (one push → Pages + Worker)

See **CLOUDFLARE_DEPLOY.md** for full steps. Short version:

- **Pages:** Connect the repo. Build command: `node scripts/write-config.js`. Build output directory: `/`. Env vars: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, optional `ELISTLY_API_URL` (Worker URL).
- **Worker:** Create a Worker, connect the **same** repo. Root directory: `worker`. Deploy command: `npx wrangler deploy`. In Variables and Secrets add `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

## 4. Supabase Edge Functions (optional)

- Deploy from CLI: `supabase functions deploy health`.
- Set **SUPABASE_SERVICE_ROLE_KEY** in Dashboard → Edge Functions → Secrets.
- Use for admin or other server-side logic; the service role key stays in Supabase secrets, not in the codebase.
