# Elistly – Deploy and Supabase setup

## 1. Supabase

1. Run the schema in the Supabase SQL Editor (Dashboard → SQL Editor): paste and run the contents of **`supabase/schema.sql`**. It creates `app_data`, `profiles`, and `admin_users`, plus the RLS policies, and is safe to re-run.
2. (Optional) Enable email confirmation under Authentication → Providers → Email. For testing you can leave it off.
3. TOTP (2FA): Authentication → Providers → enable MFA if desired; the app promotes it in Settings but does not require it.

## 2. Local config

- Copy **`config.example.js`** to **`config.js`** (config.js is gitignored).
- Set `ELISTLY_BACKEND_PROVIDER`, `ELISTLY_BACKEND_URL`, and `ELISTLY_PUBLIC_KEY` in config.js (Project Settings → API: Project URL and **anon public** key, the long JWT). Legacy `SUPABASE_URL` / `SUPABASE_ANON_KEY` still work. Optional: `ELISTLY_API_URL` for the Worker API.

## 3. Cloudflare (one push → Pages + Worker)

See **CLOUDFLARE_DEPLOY.md** for full steps. Short version:

- **Pages:** Connect the repo. Build command: `node scripts/write-config.js`. Build output directory: `/`. Preferred env vars: `ELISTLY_BACKEND_PROVIDER`, `ELISTLY_BACKEND_URL`, `ELISTLY_PUBLIC_KEY`, optional `ELISTLY_API_URL` (Worker URL). Legacy `SUPABASE_*` names still work.
- **Worker:** Create a Worker, connect the **same** repo. Root directory: `worker`. Deploy command: `npx wrangler deploy`. In Variables and Secrets add `ELISTLY_BACKEND_PROVIDER`, `ELISTLY_BACKEND_URL`, `ELISTLY_PUBLIC_KEY`, `ELISTLY_SERVICE_ROLE_KEY`.

## 4. Supabase Edge Functions (optional)

- Deploy from CLI: `supabase functions deploy health`.
- For Worker-only secrets, prefer **`ELISTLY_SERVICE_ROLE_KEY`**. Legacy **`SUPABASE_SERVICE_ROLE_KEY`** still works during migration.
- Use for admin or other server-side logic; the service role key stays in Supabase secrets, not in the codebase.
