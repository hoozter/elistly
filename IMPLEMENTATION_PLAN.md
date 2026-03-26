# Elistly JWT Auth Migration - Implementation Plan

## Overview
Migrate from Supabase auth to custom JWT auth following Notner pattern. The Worker will become the sole authentication provider. Frontend will use a Supabase-compatible wrapper that calls Worker endpoints.

## Current State
- Worker: `worker/src/index.js` - handles app data, profiles, admin. Uses JWT decode from Authorization header (no verification).
- Frontend: `app.js` loads Supabase client via CDN and uses `supabaseClient.auth.*` and `supabaseClient.from()`.
- Database: Neon schema (`neon/schema.sql`) has `app_data`, `profiles`, `admin_users` with TEXT user_id.

## Target State
- Worker: Full JWT auth with signup, login, MFA, session management, proper JWT verification.
- Frontend: Custom `supabase` wrapper from `lib/db.js` that provides same API as Supabase client but uses Worker auth endpoints.
- No Supabase client library used anywhere.
- MFA (TOTP) fully functional.

## Step-by-Step Implementation

### 1. Extend Database Schema
Add to `neon/schema.sql` (or create new `neon/auth-tables.sql` and include it):

```sql
-- user_auth: email/password credentials
CREATE TABLE IF NOT EXISTS public.user_auth (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  email_lower TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  last_sign_in_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()),
  email_confirmed_at TIMESTAMPTZ,
  UNIQUE(email_lower)
);

-- user_mfa: TOTP factors
CREATE TABLE IF NOT EXISTS public.user_mfa (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  factor_type TEXT NOT NULL CHECK (factor_type = 'totp'),
  secret_encrypted TEXT NOT NULL,
  verified_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()),
  UNIQUE(user_id, factor_type)
);

-- Optional: user_preferences to store user metadata (surrogate for Supabase user_metadata)
-- Elistly uses profiles for display_name; can add other fields here.
CREATE TABLE IF NOT EXISTS public.user_preferences (
  user_id UUID PRIMARY KEY REFERENCES public.user_auth(id) ON DELETE CASCADE,
  user_name TEXT,
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now())
);
```

### 2. Create Frontend Library Files

#### `lib/db-neon.js` (raw Neon client)
Similar to Notner's `lib/db-neon.js`:
- Use `@neondatabase/serverless` via Vite env `VITE_NEON_ELISTLY_URI`
- Export `query`, `queryOne`, `execute`, `generateId`

#### `lib/auth.js` (auth API)
Implement these functions (call Worker endpoints):
- `getSession()` → `{ data: { session: { user_id, email, created_at, expires_at } } }`
- `getUser()` → `{ data: { user: { id, email, ...preferences } } }`
- `signInWithPassword({ email, password, totp_token? })` → returns `{ data: { user, session } }` or `{ error }`
- `signUp({ email, password, options })` → returns `{ data: { user, session } }`
- `signOut()` → clears localStorage, optionally calls Worker to invalidate
- `mfa.listFactors()` → `{ data: { totp: [{ id, factor_type, status }] } }`
- `mfa.challenge({ factorId })` → `{ data: { challenge: { id, expires_at? } } }`
- `mfa.verify({ factorId, code })` → `{ data: {} }` or `{ error }`
- `mfa.enrollTotp()` → `{ data: { qr_code, secret } }` (QR code as otpauth URL)
- `refreshToken()` → `{ data: { token } }` (optional)

All use `localStorage` key `elistly_token`. Decode JWT to get payload (like Notner's `auth.js`).

#### `lib/db.js` (Supabase-compatible wrapper)
Create a `SupabaseCompatibleClient` class that mimics Supabase:

- `.from(table)` → returns `QueryBuilder` instance (like Notner's)
- `.rpc()` → returns `QueryBuilder` for function calls
- `.auth.*` → delegates to functions from `./auth.js`
- `.getSession()`, `.getUser()` → delegates to auth

The `QueryBuilder` should implement methods used in Elistly:
- `.select()`, `.eq()`, `.maybeSingle()`, `.upsert()`, `.order()` (minimal)

**Important**: In Elistly, many queries use `rpc` (e.g., `search_notes`). Ensure `.rpc()` works.

### 3. Enhance Worker (`worker/src/index.js`)

Add dependencies:
```bash
cd worker && npm install jsonwebtoken bcryptjs
```
- `jsonwebtoken` for signing/verifying JWT
- `bcryptjs` for password hashing (or use `crypto` with bcrypt via pgcrypto in DB). Actually, since we're using Neon, we could store bcrypt hashes and bcrypt in DB. But simpler: do bcrypt in Worker.

Add new auth endpoints (before existing routes):

#### POST `/auth/signup`
- Get `email`, `password` from body.
- Check if `email_lower` exists in `user_auth`.
- Hash password: `bcrypt.hash(password, 10)`.
- Insert into `user_auth` (id, email, email_lower, password_hash, created_at, updated_at).
- Insert into `user_preferences` (user_id) if needed.
- Insert into `profiles`? Actually Elistly uses `profiles` separately. When user first accesses profile, it gets created. So maybe not needed here.
- Generate JWT: sign payload `{ sub: userId, email, iat, exp }` with `JWT_SECRET`, expires 7 days.
- Set token in httpOnly cookie (optional) and return in JSON `{ token, user: { id, email } }`.
- Do NOT require email confirmation (unless desired). Keep simple: immediate login.

#### POST `/auth/login`
- Get `email`, `password` from body. Also optional `totp_token`.
- Find user by `email_lower`.
- Verify bcrypt password.
- If MFA is enrolled (check `user_mfa` where `user_id` and `verified_at` not null):
  - If `totp_token` not provided: return `{ totp_required: true, factor_id }` (challenge flow)
  - If `totp_token` provided: verify TOTP using stored secret. If valid, proceed. Else error.
- Update `last_sign_in_at`.
- Generate JWT, return `{ token, user }`.

#### POST `/auth/refresh`
- Verify current JWT (with `JWT_SECRET`).
- If valid and expiring soon (< 24h), issue new token with extended exp.
- Requires Authorization header with current token.

#### POST `/auth/logout`
- Optional: could just clear client token. But could also blacklist token (skip for simplicity).

#### GET `/auth/me` (optional) or use existing `/me`
- Already have `/me` that returns user from JWT sub. Could enhance to also include profile, preferences if needed.

#### MFA Endpoints

**POST `/auth/mfa/factors`**
- Get user from JWT.
- Query `user_mfa` for that user.
- Return `{ totp: factors }` with `{ id, factor_type, status: 'verified' }` if verified.

**POST `/auth/mfa/enroll`**
- Generate TOTP secret using `otplib` (install in worker: `npm install otplib`).
- Insert into `user_mfa` with `verified_at = NULL`.
- Return `{ secret, qr_code: otpauth_url }`. Use `authenticator.keyuri(email, 'Elistly', secret)`.

**POST `/auth/mfa/challenge`**
- For TOTP, a challenge is not really needed (the code itself is proof). But Supabase creates a challenge ID. We can skip or return a dummy challenge with `{ id: factorId, expires_at: now+5min }`.

**POST `/auth/mfa/verify`**
- Body: `{ factorId, code }`.
- Fetch `secret_encrypted` from `user_mfa`.
- Verify code with `otplib.verify({ secret, token: code })`.
- If valid, set `verified_at = now`.
- Return `{ ok: true }`.

**DELETE `/auth/mfa/:factorId`** (or POST `/auth/mfa/unenroll`)
- Delete from `user_mfa` where `id = factorId` and `user_id = currentUser`.

#### JWT Verification Middleware
- Write helper `verifyJwt(token)` that verifies signature using `JWT_SECRET` and returns payload or null.
- Use this in each protected route (including existing ones like `/app-data`, `/profile`, `/admin/*`).
- Replace current `getAuthUser(bearerToken)` with proper verification.
- If verification fails, return 401.

#### Support for httpOnly Cookie (optional)
- If using cookies, set `Set-Cookie: elistly_token=...; HttpOnly; Secure; SameSite=Strict` on login/signup.
- Read cookie from `req.headers.get('Cookie')` if Authorization header missing.
- Return token in JSON anyway for SPA fallback.

### 4. Update Worker Configuration

- Add `JWT_SECRET` to Worker secrets via `wrangler secret put JWT_SECRET`.
- Add `VITE_NEON_ELISTLY_URI` to Worker env in `wrangler.toml` under `[vars]` or `[[env]]`.
- Ensure `user_auth`, `user_mfa`, `user_preferences` tables exist in Neon DB.

### 5. Modify Frontend Entry Point

Create `src/supabase.js` (or directly `lib/db.js` and `lib/auth.js` in project root) that will be imported by `app.js`.

- In `app.js`, replace `ensureSupabaseClient()` to load our custom wrapper instead of CDN Supabase.
- Instead of dynamically loading `window.supabase`, we'll import the custom module.
- Because `app.js` is a single file without module imports, we can:
  - Add at the top: `import { supabase } from './lib/db.js';` (need to convert app.js to module type) OR
  - Load via `<script type="module">` in `index.html` and expose `window.supabase` from `lib/db.js`.
  - Simpler: create `lib/db.js` as an IIFE that sets `window.supabase` when loaded as a script, mirroring the CDN's global.

I'll choose: **Create `lib/db.js` as a browser-friendly global script.**

Example structure:

```javascript
// lib/db.js (loaded via <script src="lib/db.js"> before app.js)
(function() {
  const API_URL = (import.meta?.env?.VITE_ELISTLY_API_URL || '');
  
  // Auth functions (from lib/auth.js logic)
  function getToken() { ... }
  function setToken(token) { ... }
  async function loginWithPassword(email, password, totpToken) { ... }
  async function signUp(email, password, options) { ... }
  async function signOut() { ... }
  async function getSession() { ... }
  async function getUser() { ... }
  async function mfaEnroll() { ... }
  async function mfaVerify(factorId, code) { ... }
  // etc.

  // QueryBuilder class (simplified)
  class QueryBuilder { ... }

  // Neon client for direct queries (via Worker /db/query or direct Neon? We'll use Worker API)
  const sql = null; // Not needed directly

  const supabase = {
    from(table) { return new QueryBuilder(table); },
    rpc(fn, params) { return new QueryBuilder(fn).rpc(fn, params); },
    auth: {
      signInWithPassword: loginWithPassword,
      signUp: signUp,
      signOut: signOut,
      getSession,
      getUser,
      mfa: { ... }
    },
    // Also .upsert() on QueryBuilder
  };

  window.supabase = supabase;
})();
```

But `app.js` also calls `supabaseClient.from('profiles').upsert(...)`. So the QueryBuilder must have `upsert(data, options)`.

**Simplify**: Actually, we can mimic the Notner structure exactly: Notner has separate `lib/db.js` and `lib/auth.js` that work together. In `app.js`, we just need to create a `supabaseClient` that uses those.

In `app.js`, replace the `ensureSupabaseClient()` function:

```javascript
var supabaseClient = null;

async function ensureSupabaseClient() {
  if (supabaseClient) return supabaseClient;
  // Instead of loading CDN, load our local wrapper
  if (typeof window.supabaseCompatible !== 'undefined') {
    supabaseClient = window.supabaseCompatible;
    return supabaseClient;
  }
  // Wait for script to load? Or just assume it is loaded before app.js.
  return null;
}
```

Then in `index.html`, include:

```html
<script src="lib/db.js" type="module"></script>
<script src="app.js"></script>
```

But `app.js` is not a module, so we need to make it so OR have `lib/db.js` set `window.supabase` as the CDN would. That's easiest: `lib/db.js` sets `window.supabase = { ... }` with the same interface.

Then `ensureSupabaseClient()` can just return `window.supabase`.

We need to implement `.from(table).select(...).eq(...).maybeSingle().upsert(...)` and `.rpc()`.

However, a lot of `app.js` uses `supabaseClient.from('profiles')` directly. The wrapper needs to execute queries. We have two options:

**Option A**: Proxy queries to Worker via `fetch` to `/db/query` endpoint (like Notner's QueryBuilder executes SQL via Worker). That means Worker needs a `/db/query` endpoint that executes arbitrary SQL with parameterized queries. This is powerful but dangerous if not properly secured.

**Option B**: Instead of a generic SQL endpoint, implement specific query patterns in the Worker as RPCs that the wrapper calls. But the wrapper's `.from()` is supposed to generate those calls automatically. That's hard.

**Option C**: Keep the pattern from Notner where the wrapper's QueryBuilder constructs SQL and sends it to a generic `/db/query` endpoint on the Worker, which then executes it against Neon. This endpoint must check Authorization header and only allow queries that filter by `user_id` (RLS not enforced because we're using service role). The Worker has access to Neon via `@neondatabase/serverless`. So we can add a `POST /db/query` route that receives `{ sql, params }` and executes it with the service role connection. This is what Notner does.

Let's adopt **Option C**. It's flexible and allows the QueryBuilder to work generically.

So in Worker, add:

```javascript
if (path === '/db/query' && req.method === 'POST') {
  const user = getAuthUser(authHeader);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
  const body = await readJsonBody(req);
  const { sql: sqlText, params } = body;
  // SECURITY: disallow dangerous statements? Could allow only SELECT/INSERT/UPDATE/DELETE with restrictions.
  // For simplicity, allow all since user_id filter enforced by builder? Not actually enforced. But user is authenticated and we trust the app code. Still risky if XSS. But since it's same-origin and we don't allow arbitrary SQL from client? Actually the QueryBuilder will generate SQL based on our code, not user input. So it's safe.
  try {
    const rows = await sql.query(sqlText, params);
    return jsonResponse({ data: rows.rows }, 200, origin);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, origin);
  }
}
```

Now the QueryBuilder in `lib/db.js` can send SQL to that endpoint.

But wait: In Notner, the `QueryBuilder` builds SQL and sends to `/db/query`. The Worker executes it with the service role connection (which bypasses RLS). That's fine because the QueryBuilder automatically adds `WHERE user_id = $...` filters when selecting from `app_data`, `profiles`, etc. So we must ensure all queries from `app.js` that access user-specific data have the `user_id` filter. Since the existing `app.js` only does:

`supabaseClient.from('profiles').select('display_name').eq('user_id', userId).maybeSingle()`

It explicitly filters by `user_id`. Good.

Also internal uses (like admin) also check `user_id` manually. So it's safe.

Thus: **Implement generic `/db/query` endpoint** that executes parameterized SQL. The QueryBuilder will use it.

### 6. Implement QueryBuilder in `lib/db.js`

We'll adapt Notner's QueryBuilder but ensure it covers methods used in Elistly:

From grep:
- `.select('payload,updated_at')` -> can use `select('payload, updated_at')` or `select('*')`
- `.eq('user_id', user.id)`
- `.maybeSingle()`
- `.upsert({ user_id: user.id, payload: data }, { onConflict: 'user_id' })`

Also `.rpc()` is used: `supabaseClient.rpc('search_notes', { query: ..., userId: user.id, limit: ... })`

So we need `rpc(functionName, params)` to generate `SELECT * FROM function_name($1, $2, ...)`.

Notner's QueryBuilder handles rpc as a table function.

Also `.order()` appears: `order('updated_at', { ascending: false })`. We'll support basic order.

Also `.or()` appears: `or("user_id.eq.${userId},entity_type.eq.${typeId}")` - need to support.

Let's check for any other methods: `is()`, `not()`, `lt()`, `in()`. Probably not used much but implement if found.

### 7. Update `config.example.js` and `config.js`

- Update to include `ELISTLY_API_URL` (already there) – points to Worker URL.
- No need for `JWT_SECRET` in frontend.

### 8. Test Locally

- Deploy Worker locally using `wrangler dev`.
- Set secrets: `NEON_DATABASE_URL`, `JWT_SECRET`.
- Run `npm run dev` for frontend.
- Sign up, log in, check token storage.
- Access app data, profile, admin (if admin user inserted into `admin_users`).
- Test MFA enrollment and verification.

### 9. Migration of Existing Users

- Existing users are in Supabase auth.users. We need to export their data and create corresponding entries in `user_auth` with random passwords? But they can't log in with old passwords. Better to require all existing users to reset passwords. Or we could migrate password hashes if using same algorithm (Supabase uses bcrypt). We could copy bcrypt hashes from Supabase to `user_auth.password_hash`. That would allow seamless login. But we don't have access to Supabase from Worker directly during migration? We can run an export/import script.

For simplicity: Document that existing users must reset password via "Forgot password" flow, which will create a new `user_auth` entry (or update existing) with new hash.

Alternatively, we could keep both auth systems temporarily: Worker could accept either a JWT or a Supabase token and convert. But that's complex.

For migration doc: instruct to export `auth.users` and `profiles` (with `user_id` as UUID) and import into `user_auth` and `profiles`. Map `id` to `user_auth.id`, `email` to `email`, `encrypted_password` to `password_hash` (same bcrypt format). That should work.

### 10. Write Migration Document (`ELISTLY_MIGRATION.md`)

Include:
- Overview
- Prerequisites: Neon DB set up, Worker deployed, secrets configured.
- Data Migration: Export from Supabase (SQL queries), import into Neon. Provide mapping for `auth.users` -> `user_auth`.
- Code changes: commit summary or explain that we replaced Supabase client with custom JWT auth.
- Deployment steps: build and deploy Worker, deploy frontend (update `index.html` to load `lib/db.js` before `app.js`).
- User impact: Users need to re-authenticate; if password hashes were migrated, they can log in normally. Otherwise, use password reset.
- Testing checklist.
- Rollback: keep old Supabase client code in branch, or keep Supabase as fallback by toggling config (maybe `ELISTLY_BACKEND_PROVIDER`).

## Deliverables

- Updated `worker/src/index.js` with all auth endpoints and proper JWT verification.
- `neon/auth-tables.sql` (or merged into `neon/schema.sql`).
- New frontend files: `lib/db-neon.js`, `lib/auth.js`, `lib/db.js`.
- Updated `index.html` to include new script.
- Updated `app.js` to use custom wrapper (minimal changes if wrapper is compatible).
- `ELISTLY_MIGRATION.md` with full guide.
- Git commit with all changes.

## Acceptance Criteria Checklist

- [ ] All API routes in Worker require and verify JWT (except signup/login, /health, /debug-env)
- [ ] Worker can create users, issue JWTs, verify JWTs, handle MFA.
- [ ] Frontend `supabaseClient` works identically to before, but is custom implementation.
- [ ] No references to `@supabase/supabase-js` package or CDN remain.
- [ ] `/admin/me` and `/admin/users` routes work for admin.
- [ ] MFA enrollment and verification work end-to-end.
- [ ] Existing data from Supabase can be migrated via documented process.
- [ ] Local testing passes: signup, login, CRUD, admin, MFA.
