# Neon Migration Notes

## Current status

Elistly is now wired for:

- **Neon Auth** for signup, login, session JWTs, and user records in the `neon_auth` schema.
- **Cloudflare Worker** for app data, profile, admin, and account deletion routes.
- **Neon Postgres** for `app_data`, `profiles`, and `admin_users`.

The browser receives only public URLs:

- `ELISTLY_API_URL`
- `NEON_AUTH_URL`

The Worker receives secrets:

- `NEON_DATABASE_URL`
- `NEON_AUTH_URL`
- `NEON_AUTH_JWKS_URL`
- `ELISTLY_ADMIN_EMAILS`

## Runtime flow

1. The browser signs users in directly through Neon Auth.
2. The browser reads the `set-auth-jwt` response header from Neon Auth `/get-session`.
3. The browser sends that JWT to the Worker as `Authorization: Bearer <token>`.
4. The Worker verifies the JWT against the Neon Auth JWKS endpoint.
5. The Worker reads/writes rows in Neon Postgres for the authenticated `sub`.

## Database notes

The canonical app data column is `app_data.payload`.

Older migration attempts created `app_data.data`; `neon/schema.sql` now preserves existing rows by renaming or copying `data` into `payload`.

## Admin setup

The first Neon Auth user becomes admin automatically when there are no active Neon Auth admins yet. This lets a fresh deployment bootstrap itself: deploy, create your account, then open the app.

For recovery or explicit assignment, set `ELISTLY_ADMIN_EMAILS` on the Worker to the email address that should be admin. Multiple admin accounts can be comma-separated.

When an authenticated user's email matches `ELISTLY_ADMIN_EMAILS`, the Worker also inserts that user's Neon Auth ID into `admin_users`, so the admin relationship is preserved by user ID after first login.

## Remaining migration work

- Deploy the updated Worker with the required secrets.
- Deploy the updated frontend with `NEON_AUTH_URL` in generated `config.js`.
- Create the new Neon Auth account using the email configured in `ELISTLY_ADMIN_EMAILS`.
- Add production-grade password reset/email-change flows through Neon Auth.
- Revisit MFA once Neon Auth MFA requirements are defined for this app.
