# Neon Schema Migration Notes

## Summary of changes from `supabase/schema.sql` → `neon/schema.sql`

### Removed (Supabase-specific)

| Removed | Reason |
|---|---|
| `REFERENCES auth.users(id) ON DELETE CASCADE` on all three tables | Neon has no `auth` schema / `auth.users` table |
| `(select auth.uid())` in RLS policy conditions | `auth.uid()` is a Supabase function; not available in Neon |
| `TO authenticated` role clause on all policies | `authenticated` is a Supabase-managed role; not available in Neon |
| `TO anon` role clauses (none were present, but guarded against) | Same reason |

### Changed

| Change | Detail |
|---|---|
| `user_id UUID` → `user_id TEXT` | Neon Auth JWT `sub` claims are strings; no UUID cast needed |
| `auth.uid()` → `auth.user_id()` | Neon's built-in JWT helper reads the `sub` claim from the session token |
| Policy role clause dropped | Without `TO <role>`, policies apply to all non-superuser roles — appropriate since Neon Auth controls access via JWT, not Postgres roles |

### Kept / Added

| Item | Detail |
|---|---|
| `create extension if not exists pgcrypto` | Retained for any pgcrypto usage in the app |
| All three tables (`app_data`, `profiles`, `admin_users`) | Identical columns, RLS enabled |
| `ALTER TABLE … ADD COLUMN IF NOT EXISTS` idempotent guards | Safe to re-run on existing databases |
| Defensive `id → user_id` rename block on `profiles` | Ported from `supabase/schema.sql`; handles legacy table shape |
| No policies on `admin_users` | Worker accesses via privileged connection; unchanged from Supabase version |

### Not needed

- `supabase/functions/health/` — edge function only; no database objects to migrate.

## Re-running the schema

The schema is fully idempotent. Run it against your Neon database at any time:

```bash
psql "$NEON_DATABASE_URL" -f neon/schema.sql
```

## Data migration

When moving data from Supabase to Neon, note that `user_id` was `uuid` in Supabase and is `text` in Neon. Cast appropriately during export:

```sql
-- Supabase export
COPY (SELECT user_id::text, payload, updated_at FROM public.app_data) TO '/tmp/app_data.csv' CSV HEADER;
COPY (SELECT user_id::text, display_name, updated_at FROM public.profiles) TO '/tmp/profiles.csv' CSV HEADER;
COPY (SELECT user_id::text, created_at FROM public.admin_users) TO '/tmp/admin_users.csv' CSV HEADER;
```

If Neon Auth issues different user IDs than Supabase Auth, map them before importing (see `NEON_MIGRATION.md` in the project root).
