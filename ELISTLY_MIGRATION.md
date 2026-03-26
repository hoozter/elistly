# Elistly JWT Authentication Migration Guide

## Overview

This guide covers migrating Elistly from Supabase authentication to custom JWT-based authentication using a Cloudflare Worker, following the Notner auth pattern.

The new architecture:
- **Cloudflare Worker** handles all authentication: signup, login, logout, MFA (TOTP), JWT generation/verification.
- **Neon PostgreSQL** database stores user credentials (`user_auth`), MFA factors (`user_mfa`), preferences (`user_preferences`), and app data (`app_data`, `profiles`, `admin_users`).
- **Frontend** uses a Supabase-compatible wrapper (`lib/db.js`) that calls Worker endpoints. No Supabase client library is used.
- JWT tokens are stored in `localStorage` (or optionally httpOnly cookies) and sent via `Authorization: Bearer` header.

## Prerequisites

1. **Neon Database** set up with the schema from `neon/schema.sql`.
2. **Cloudflare Worker** deployed with:
   - Environment variable `NEON_DATABASE_URL` (Neon connection string).
   - Environment variable `JWT_SECRET` (strong random secret for HS256 signing).
   - Dependencies: `@neondatabase/serverless`, `jsonwebtoken`, `bcryptjs`, `otplib`.
3. **Frontend** served with `ELISTLY_API_URL` pointing to the Worker URL (set in `config.js`).

## Step 1: Database Schema

Apply the updated schema in `neon/schema.sql`. It now includes:

- `user_auth` – email/password credentials
- `user_mfa` – TOTP factors
- `user_preferences` – optional metadata (e.g., user_name)
- Existing tables: `app_data`, `profiles`, `admin_users`

Run:
```bash
psql $NEON_DATABASE_URL -f neon/schema.sql
```

## Step 2: Worker Deployment

### Install Dependencies

```bash
cd worker
npm install jsonwebtoken bcryptjs otplib
```

### Code Changes

The Worker code (`worker/src/index.js`) now includes:
- JWT verification middleware
- Auth endpoints: `/auth/signup`, `/auth/login`, `/auth/refresh`, `/auth/logout`
- MFA endpoints: `/auth/mfa/factors`, `/auth/mfa/enroll`, `/auth/mfa/verify`, `/auth/mfa/challenge`, `/auth/mfa/unenroll`
- Generic `/db/query` endpoint for QueryBuilder
- Existing app data routes (`/app-data`, `/profile`, `/admin/*`, etc.) updated to use proper JWT verification.

### Secrets

Set the required secrets using Wrangler:

```bash
npx wrangler secret put NEON_DATABASE_URL   # if not already set
npx wrangler secret put JWT_SECRET          # e.g., openssl rand -hex 32
```

### Deploy

```bash
npx wrangler deploy
```

## Step 3: Frontend Changes

### Add Library Files

Copy the new library file into place:
- `lib/db.js` – Supabase-compatible client that uses Worker auth and data endpoints.

This file provides:
- `window.supabase.auth.getSession()`, `.signInWithPassword()`, `.signUp()`, `.signOut()`
- `window.supabase.auth.mfa.*` for TOTP
- `window.supabase.from(table).select()/.eq()/.upsert()/.rpc()` etc. via QueryBuilder → `/db/query`

### Update HTML

In `app.html` (and `index.html` if needed), load `lib/db.js` **before** `app.js`:

```html
<script src="config.js"></script>
<script src="lib/db.js"></script>
<script src="app.js"></script>
```

We already modified `app.html` accordingly.

### Update `app.js`

The `ensureSupabaseClient()` function now returns `window.supabase` (preloaded). The CDN loading of Supabase has been removed. Functions `getAuthSession`, `getAuthUser`, and `apiRequest` remain unchanged and work with the new wrapper.

No other changes to `app.js` are required because the wrapper maintains Supabase API compatibility.

## Step 4: Configuration

Ensure `config.js` (or the built version from `config.example.js`) sets:

```javascript
window.ELISTLY_API_URL = 'https://your-worker.workers.dev'; // full https URL
```

The legacy Supabase variables (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) are no longer used but can remain for backward compatibility.

## Step 5: Migrate Existing Users

If you have existing users from Supabase, you need to migrate their credentials and profile data.

### Export from Supabase

```sql
-- user credentials (email, encrypted password using bcrypt)
SELECT id, email, email_confirmed_at, created_at, updated_at, encrypted_password
FROM auth.users
WHERE deleted_at IS NULL;

-- user profiles (if using a separate profiles table)
SELECT user_id, display_name, ... FROM profiles;

-- app_data
SELECT user_id, payload, updated_at FROM app_data;

-- admin_users
SELECT user_id, created_at FROM admin_users;
```

### Import into Neon

**Important**: The `user_auth.id` must match the original Supabase user ID (UUID) to preserve data relationships. If you want to keep the same IDs, use the same UUIDs from Supabase.

- Map `auth.users.id` → `user_auth.id`
- Map `auth.users.email` → `user_auth.email`
- Map `auth.users.encrypted_password` → `user_auth.password_hash` (same bcrypt format)
- Map `profiles.user_id` → `profiles.user_id` (keep same)
- Map `app_data.user_id` → `app_data.user_id` (keep same)
- Map `admin_users.user_id` → `admin_users.user_id` (keep same)

Insert into `user_preferences` for each user (optional):
```sql
INSERT INTO user_preferences (user_id, created_at, updated_at)
VALUES (<user_id>, NOW(), NOW())
ON CONFLICT (user_id) DO NOTHING;
```

**Note**: If you choose to generate new user IDs, existing users will need to create new accounts because their data links will break. It's simpler to preserve IDs.

## Step 6: Testing

### Test Locally

1. Start the Worker locally (if using `wrangler dev`):
   ```bash
   cd worker
   npx wrangler dev
   ```
   Set env vars in `.dev.vars` or via command line.

2. Serve the frontend (any static server ensuring `ELISTLY_API_URL` points to the dev Worker, usually `http://127.0.0.1:8787`).

3. Sign up a new account:
   - Enter email and password.
   - Should receive `200` with `token` and `user`. Token stored in `localStorage`.
   - `localStorage.getItem('elistly_token')` should contain the JWT.

4. Log out and log back in:
   - Use same credentials.
   - Should succeed and populate `apiRequest` calls.

5. Test MFA enrollment:
   - Go to Profile → Security → Enable TOTP.
   - The app calls `supabase.auth.mfa.enroll({ factorType: 'totp' })`.
   - Should return `{ id, totp: { qr_code, secret } }`.
   - Scan QR with authenticator app.
   - Enter code to verify; calls `supabase.auth.mfa.verify({ factorId, code })`.
   - Should return success.

6. Test MFA-protected login:
   - Enable MFA first.
   - Log out, then log in again with correct password.
   - Should get `{ totp_required: true, factor_id }`.
   - Then call `signInWithPassword` again with `totp_token` to complete.

7. Test protected routes:
   - Access `/app-data` (GET/PUT) – should work with valid JWT.
   - Access `/profile` – works.
   - Access `/admin/me` if user is in `admin_users` – returns `{ admin: true }`.
   - Try without token – should get `401`.

8. Test admin panel:
   - Insert your user ID into `admin_users`.
   - Access admin users list via UI or `apiRequest('/admin/users')`.
   - Should return list of users.

### Production Testing

1. Deploy Worker to production.
2. Update `config.js` to point `ELISTLY_API_URL` to production Worker URL.
3. Clear browser storage, sign up new account, etc.
4. Migrated users: test login with migrated bcrypt passwords.

## Step 7: Update Deployment Processes

- Ensure `wrangler.toml` includes the correct `name` and `compatibility_date`.
- Add secret management to CI/CD: `wrangler secret put JWT_SECRET`.
- Rebuild and upload frontend with the updated `lib/db.js` and `app.html`.

## Step 8: Troubleshooting

### "Supabase client not loaded" error
- Ensure `lib/db.js` is included before `app.js` in HTML.
- Check console for `ELISTLY_API_URL` being set.

### 401 Unauthorized on API calls
- Verify JWT is present in `Authorization` header (Network tab).
- Check Worker logs for verification errors.
- Ensure `JWT_SECRET` matches the one used to sign tokens.

### MFA enrollment fails
- Verify `user_mfa` table exists and `otplib` installed.
- Check that the Worker can write to `user_mfa`.

### Password migration issues
- If migrating bcrypt hashes from Supabase, ensure the hash format is exactly the same (e.g., `$2b$10$...`). `bcryptjs` can verify standard bcrypt hashes.
- If you used a different bcrypt version, you may need to migrate by forcing password resets.

## Rollback Plan

If critical issues arise:

1. Revert frontend to previous version that loads Supabase CDN.
2. Restore `ensureSupabaseClient` to CDN loading logic (keep the old code in a branch).
3. Keep the Worker deployed but ignore its auth endpoints; continue using Supabase.
4. Optionally, you can keep both auth systems and switch via configuration.

## Acceptance Checklist

- [ ] All major API routes (`/app-data`, `/profile`, `/admin/*`) require and accept JWTs.
- [ ] Admin panel functions correctly (admin check, user listing, deletion).
- [ ] 2FA (TOTP) enrollment and verification work end-to-end.
- [ ] No references to `@supabase/supabase-js` or `SUPABASE_URL` used at runtime.
- [ ] `ELISTLY_MIGRATION.md` (this document) is present.
- [ ] Migrated users can log in with their existing passwords.
- [ ] New users can sign up without email confirmation (optional: can add later).
- [ ] Token refresh works (`/auth/refresh`).
- [ ] Logout clears token and cookie.

## Appendix: Configuration Variables

### Frontend (`config.js`)

- `ELISTLY_API_URL` (required): full URL of the Worker API.
- Optional: `VITE_NEON_ELISTLY_URI` for direct Neon access (not used in this migration).

### Worker (Secrets/Env)

- `NEON_DATABASE_URL` (required): Neon connection string.
- `JWT_SECRET` (required): random string for HS256 signing (minimum 256-bit).

### Database Connection

The Worker connects to Neon using `@neondatabase/serverless` via the provided `NEON_DATABASE_URL`.

## Appendix: API Reference

### Auth Endpoints

- `POST /auth/signup` – `{ email, password }` → `{ token, user }`
- `POST /auth/login` – `{ email, password }` or `{ email, password, totp_token }` → `{ token, user }` or `{ totp_required, factor_id }`
- `POST /auth/refresh` – requires `Authorization: Bearer <token>` → `{ token }`
- `POST /auth/logout` – clears server-side cookie (client clears localStorage)
- `GET  /auth/mfa/factors` – returns `{ totp: [...] }`
- `POST /auth/mfa/enroll` – enrolls TOTP, returns `{ factor_id, qr_code, secret }`
- `POST /auth/mfa/verify` – `{ factor_id, code }` → `{}`
- `POST /auth/mfa/challenge` – `{ factorId }` → `{ challenge: { id, expires_at } }` (dummy for TOTP)
- `POST /auth/mfa/unenroll` – `{ factor_id }` → `{}`

### Data Endpoints

Same as before, but now require valid JWT in `Authorization` header:
- `GET /me`
- `GET/PUT /app-data`
- `GET/PUT /profile`
- `GET /admin/me`
- `GET/DELETE /admin/users` and `/admin/users/:id`
- `DELETE /users/me`

### Generic Query

- `POST /db/query` – `{ sql, params }` → `{ data: [...] }` – used by QueryBuilder. Protected by JWT.

## Credits

Based on the Notner auth pattern described in `~/projects/notner/AUTH_PATTERN.md`.
