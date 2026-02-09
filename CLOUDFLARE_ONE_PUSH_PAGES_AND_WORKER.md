# How this project does “one push → Cloudflare Pages + Cloudflare Worker”

This is a **reusable explanation** of the setup. Use it in another project when you want: push to Git once → both the **static site (Pages)** and the **API (Worker)** deploy automatically.

---

## Goal

- **One GitHub repo.**
- **One push** to the production branch.
- **Two deploys:**
  1. **Cloudflare Pages** – the front-end (HTML/JS/CSS, or built output).
  2. **Cloudflare Worker** – the backend API (runs in Cloudflare’s edge; e.g. auth, delete user, admin routes).

No manual “paste Worker code” or “run wrangler deploy” from your machine. Everything is driven by Git.

---

## How it works

Cloudflare has two **separate** products that can both be connected to the **same** repo:

1. **Pages** – “Connect to Git” → chooses repo and branch. Each push runs your **build** (e.g. `node scripts/write-config.js`) and deploys the **output directory** (e.g. `/`).
2. **Worker** – “Connect to Git” (or add Git in **Settings → Build**) → same repo and branch. Each push runs the **deploy command** (e.g. `npx wrangler deploy`) from a **root directory** you set (e.g. `worker/`).

So the repo layout is:

- **Root (or any path):** the static site / app (what Pages builds and serves).
- **`worker/` (or any subdirectory):** the Worker source. That folder must contain:
  - **`wrangler.toml`** – Worker name, `main` entry (e.g. `src/index.js`), `compatibility_date`.
  - **`src/index.js`** (or whatever `main` points to) – the Worker code (export a `fetch` handler).
  - **`package.json`** (recommended) – so `npx wrangler deploy` works in Cloudflare’s build environment (e.g. `"devDependencies": { "wrangler": "^3.91.0" }`).

Secrets (API keys, etc.) are **not** in the repo. They are set in the **Worker’s** **Settings → Variables and Secrets** in the Cloudflare dashboard and persist across Git-based deploys.

---

## Steps to replicate in another project

### 1. Repo layout

- Put the Worker in a subdirectory, e.g. `worker/`.
- Inside `worker/`:
  - **`wrangler.toml`** – at least: `name = "your-worker-name"`, `main = "src/index.js"`, `compatibility_date = "2024-01-01"`.
  - **`src/index.js`** – export `default { async fetch(req, env, ctx) { ... } }`.
  - **`package.json`** – e.g. `"scripts": { "deploy": "wrangler deploy" }`, `"devDependencies": { "wrangler": "^3.91.0" }`.

### 2. Cloudflare Pages (static site)

- **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → select the repo and branch.
- **Build:** set **Build command** (e.g. `node scripts/write-config.js` or `npm run build`) and **Build output directory** (e.g. `/` or `dist`).
- **Environment variables:** add any vars the *site* needs at build or runtime (e.g. `SUPABASE_URL`, `DELETE_ACCOUNT_URL`). The Worker URL can be added here after the Worker is created.

### 3. Cloudflare Worker (API)

- **Workers & Pages** → **Create** → **Create Worker** (e.g. “Hello World”) so the Worker exists and you get its URL.
- **Settings → Build:** connect the **same repo and branch** as Pages.
- Set:
  - **Root directory:** `worker` (the path to the folder that contains `wrangler.toml`).
  - **Build command:** empty, or `npm install` if the deploy step fails.
  - **Deploy command:** `npx wrangler deploy`.
- **Settings → Variables and Secrets:** add the Worker’s secrets (API keys, etc.). These are not in the repo.
- Redeploy the Worker once (or push a commit) so it builds from the `worker/` directory.

### 4. Tie them together

- In the **Pages** project, add an env var (e.g. `DELETE_ACCOUNT_URL` or `API_URL`) whose value is the Worker URL (e.g. `https://your-worker.xxxx.workers.dev` or `https://your-worker.xxxx.workers.dev/some-path`). The static site uses this to call the Worker.
- Redeploy Pages (or push) so the site gets that env var.

---

## Summary

| What | Where |
|------|--------|
| Static site / app | Repo root (or path you set as Pages “root”) |
| Worker code | Subdirectory, e.g. `worker/`, with `wrangler.toml` + `src/index.js` + `package.json` |
| Pages | Connected to repo; builds from root (or custom root); deploys build output |
| Worker | Connected to **same** repo; **Root directory** = `worker`; deploy command = `npx wrangler deploy` |
| Secrets | Only in Cloudflare: Pages env vars for the site, Worker Variables and Secrets for the API |

**One push** → Cloudflare runs the Pages build and the Worker deploy (from `worker/`). Replicate the layout and the two Git connections (Pages + Worker with root directory) to get the same “push once, both update” behavior elsewhere.
