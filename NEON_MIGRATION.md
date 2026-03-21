# Neon Migration Notes

Elistly now has a provider-neutral config shape and an app-owned Worker API surface so the backend can move off Supabase incrementally.

## Current status

- Frontend auth is still Supabase-backed.
- The Worker now exposes stable app routes for:
  - `GET /me`
  - `GET /app-data`
  - `PUT /app-data`
  - `GET /profile`
  - `PUT /profile`
  - `POST /secondary-email/send`
  - `POST /secondary-email/confirm`
  - existing admin and delete-account routes
- The Neon-ready SQL lives in `neon/schema.sql`.

## Config names

Preferred config/env names:

- `ELISTLY_BACKEND_PROVIDER`
- `ELISTLY_BACKEND_URL`
- `ELISTLY_PUBLIC_KEY`
- `ELISTLY_SERVICE_ROLE_KEY`
- `ELISTLY_API_URL`

Backward-compatible Supabase names are still supported:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

## Suggested migration order

1. Create the Neon project and run `neon/schema.sql`.
2. Keep the Worker as the stable integration point.
3. Export `app_data`, `profiles`, and `admin_users` from Supabase.
4. Import those tables into Neon.
5. Implement the Worker's Neon backend branch.
6. Swap frontend auth from Supabase to Neon Auth.
7. Cut traffic over after validation.

## Data export/import

Use SQL or CSV export from Supabase for:

- `public.app_data`
- `public.profiles`
- `public.admin_users`

Then import those rows into the matching Neon tables. If Neon Auth user IDs differ from Supabase auth IDs, map them before importing because `user_id` is the join key for all three tables.

## Important caveat

The current Worker implementation still executes against a Supabase-compatible backend. Neon support should be added by implementing a new provider branch in `worker/src/index.js`, then switching `ELISTLY_BACKEND_PROVIDER` once auth verification, user management, and data access are wired up.
