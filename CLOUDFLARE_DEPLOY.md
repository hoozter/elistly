# Deploy Elistly to Cloudflare

You use **Cloudflare Pages** for the app (frontend) and a **Cloudflare Worker** for the API (health, delete-account, admin list/delete users). Both connect to the **same GitHub repo**: one push deploys both (Pages runs the build, Worker runs `npx wrangler deploy` from the `worker/` directory).

**Admin:** The Worker exposes `/admin/me`, `/admin/users`, `DELETE /admin/users/:id`, and `DELETE /users/me`. To add yourself as admin: in Supabase run `insert into public.admin_users (user_id) values ('your-auth-user-uuid');` (get your UUID from Supabase → Authentication → Users). Then the Admin link appears in the profile dropdown and you can list/delete accounts. The frontend still talks to Supabase directly for normal app data; the Worker is used only for delete-account and admin.

---

## 1. Prerequisites

- GitHub repo pushed (this project).
- Supabase project created and `supabase/schema.sql` run.
- Cloudflare account.

---

## 2. Cloudflare Pages (the app)

1. In Cloudflare: **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
2. Select your GitHub repo and the branch you use for production (e.g. `main`).
3. **Build settings:**
   - **Framework preset:** None.
   - **Build command:** `node scripts/write-config.js`
   - **Build output directory:** `/`
4. **Environment variables** (Settings → Environment variables): add for **Production** (and optionally Preview):
   - `SUPABASE_URL` = your Supabase project URL (e.g. `https://xxxx.supabase.co`)
   - `SUPABASE_ANON_KEY` = your Supabase anon public key (long JWT)
   - `ELISTLY_API_URL` = your Worker URL (e.g. `https://elistly-api.xxxx.workers.dev`) — optional; needed for Delete account and Admin.
5. Save and deploy. The build runs `write-config.js`, which creates `config.js` from those env vars so the app can connect to Supabase. No secrets are stored in the repo.
6. After the first deploy you get a URL like `https://your-project.pages.dev`. Open it; you should see the Elistly sign-in screen.

---

## 3. Cloudflare Worker (API / future admin)

1. **Workers & Pages** → **Create** → **Worker** → create a new Worker (e.g. name it `elistly-api` or use the default and rename in Settings). You get a URL like `https://elistly-api.xxxx.workers.dev`.
2. **Connect to Git:** In the Worker’s **Settings** → **Build** (or **Builds & deployments**), connect the **same** GitHub repo and branch as Pages.
3. **Build configuration:**
   - **Root directory:** `worker`  
     (so Cloudflare uses the folder that contains `wrangler.toml` and `src/index.js`).
   - **Build command:** `npm install`  
     (so `npx wrangler deploy` can run; leave empty if deploy works without it).
   - **Deploy command:** `npx wrangler deploy`
4. **Variables and Secrets:** In the Worker → **Settings** → **Variables and Secrets**, add `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` as **Secret** (encrypted), not Variable (plaintext). Secrets persist across deploys.
5. Save and deploy (or push a commit so the Worker rebuilds from `worker/`).

The Worker implements: `GET /` and `GET /health`; `GET /admin/me` (returns `{ admin: true/false }`); `GET /admin/users` (list users, admin only); `DELETE /admin/users/:id` (delete user, admin only); `DELETE /users/me` (delete own account).

---

## 4. Point the app at the Worker (for Delete account and Admin)

For **Delete account** (Profile) and **Admin** (profile dropdown → Admin), the frontend must know the Worker URL:

1. In **Pages** → your project → **Settings** → **Environment variables**, add `ELISTLY_API_URL` = `https://elistly-api.xxxx.workers.dev` (your Worker URL).
2. The build script reads env var **`ELISTLY_API_URL`** and writes it into `config.js` as **`window.ELISTLY_API_URL`** (same name as the env var). If `ELISTLY_API_URL` is not set, the app still works but Delete account and Admin will be unavailable or show a message that the API is not configured.

---

## 5. One-push flow

Once both are connected to the same repo:

- **Push to your production branch** → Cloudflare runs the **Pages** build (root of repo, `node scripts/write-config.js`, output `/`) and the **Worker** deploy (root directory `worker`, `npx wrangler deploy`). Both update from the same push.

**Summary**

| What | Where |
|------|--------|
| Static app | Repo root; Pages builds and serves it. |
| Worker API | `worker/` (wrangler.toml, src/index.js, package.json); Worker project uses root directory `worker`, deploy command `npx wrangler deploy`. |
| Secrets | Pages env vars for the site (e.g. SUPABASE_URL, ELISTLY_API_URL); Worker Variables and Secrets for the API (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY). |
