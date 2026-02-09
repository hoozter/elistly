# Deploy Elistly to Cloudflare

You use **Cloudflare Pages** for the app (frontend) and a **Cloudflare Worker** for the API (right now just a health check; admin routes can be added later). Both can be connected to the same GitHub repo so one push deploys both.

**Admin note:** No admin features are implemented yet. The Worker only exposes a `/health` endpoint. The frontend talks to Supabase directly from the browser. The Worker is there so you can add admin or server-side routes (e.g. delete user, reports) later without changing where the app is hosted.

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
4. **Environment variables** (Settings → Environment variables): add these for **Production** (and optionally Preview):
   - `SUPABASE_URL` = your Supabase project URL (e.g. `https://xxxx.supabase.co`)
   - `SUPABASE_ANON_KEY` = your Supabase anon public key (long JWT)
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
4. **Variables and Secrets:** In the Worker’s **Settings** → **Variables and Secrets**, add:
   - `SUPABASE_URL` = your Supabase project URL
   - `SUPABASE_SERVICE_ROLE_KEY` = your Supabase service role key (from Supabase → Project Settings → API; **never** put this in the repo or in the frontend)
5. Save and deploy (or push a commit so the Worker rebuilds from `worker/`).

The Worker currently only responds to `GET /` and `GET /health` with `{ "ok": true, "service": "elistly-api" }`. You can add admin routes later in `worker/src/index.js` and use `env.SUPABASE_URL` and `env.SUPABASE_SERVICE_ROLE_KEY` there.

---

## 4. Optional: point the app at the Worker

The Elistly frontend does **not** call the Worker today; it talks to Supabase from the browser. When you add admin or other API features that the frontend should call:

1. In **Pages** → your project → **Settings** → **Environment variables**, add e.g. `API_URL` = `https://elistly-api.xxxx.workers.dev`.
2. In your build or frontend code, use that env var as the base URL for API requests (e.g. `fetch(API_URL + '/admin/...')`). For build-time injection you’d need to expose it in `write-config.js` (e.g. `window.ELISTLY_CONFIG.apiUrl`) if the app needs it at runtime.

---

## 5. One-push flow

Once both are connected to the same repo:

- **Push to your production branch** → Cloudflare runs the **Pages** build (root of repo, `node scripts/write-config.js`, output `/`) and the **Worker** deploy (root directory `worker`, `npx wrangler deploy`). Both update from the same push.

See **CLOUDFLARE_ONE_PUSH_PAGES_AND_WORKER.md** for the generic pattern and troubleshooting.
