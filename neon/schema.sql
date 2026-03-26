-- Elistly Neon schema.
-- Safe to re-run (idempotent: IF NOT EXISTS / OR REPLACE throughout).
--
-- Neon differences vs Supabase:
--   * user_id is TEXT (Neon Auth JWT sub claim), not UUID.
--   * No REFERENCES auth.users — FK removed; user_id columns kept.
--   * No auth.uid() — policies use auth.user_id() (Neon built-in JWT helper).
--   * No `to authenticated` / `to anon` role clauses — not available in Neon.
--   * No GRANTs to authenticated/anon roles.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- app_data
-- ---------------------------------------------------------------------------

create table if not exists public.app_data (
  user_id     text        primary key,
  payload     jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.app_data
  add column if not exists payload jsonb not null default '{}'::jsonb;

alter table public.app_data
  add column if not exists updated_at timestamptz not null default now();

alter table public.app_data enable row level security;

drop policy if exists "app_data_select_own" on public.app_data;
create policy "app_data_select_own"
  on public.app_data
  for select
  using ((select auth.user_id()) = user_id);

drop policy if exists "app_data_insert_own" on public.app_data;
create policy "app_data_insert_own"
  on public.app_data
  for insert
  with check ((select auth.user_id()) = user_id);

drop policy if exists "app_data_update_own" on public.app_data;
create policy "app_data_update_own"
  on public.app_data
  for update
  using  ((select auth.user_id()) = user_id)
  with check ((select auth.user_id()) = user_id);

drop policy if exists "app_data_delete_own" on public.app_data;
create policy "app_data_delete_own"
  on public.app_data
  for delete
  using ((select auth.user_id()) = user_id);

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  user_id      text        primary key,
  display_name text,
  updated_at   timestamptz not null default now()
);

-- Defensive rename: handle any pre-existing table that used 'id' instead of 'user_id'.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'id'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'user_id'
  ) then
    alter table public.profiles rename column id to user_id;
  end if;
end
$$;

alter table public.profiles
  add column if not exists display_name text;

alter table public.profiles
  add column if not exists updated_at timestamptz not null default now();

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles
  for select
  using ((select auth.user_id()) = user_id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles
  for insert
  with check ((select auth.user_id()) = user_id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles
  for update
  using  ((select auth.user_id()) = user_id)
  with check ((select auth.user_id()) = user_id);

-- ---------------------------------------------------------------------------
-- admin_users
-- ---------------------------------------------------------------------------

create table if not exists public.admin_users (
  user_id    text        primary key,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;

-- No end-user policies on admin_users.
-- The app-owned Worker accesses this table via a privileged (service-role) connection.

-- ---------------------------------------------------------------------------
-- user_auth (credentials)
-- ---------------------------------------------------------------------------

create table if not exists public.user_auth (
  id              text        primary key,
  email           text        not null,
  email_lower     text        not null,
  password_hash   text        not null,
  last_sign_in_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  email_confirmed_at timestamptz,
  unique(email_lower)
);

-- Index for email lookups
create index if not exists idx_user_auth_email_lower on public.user_auth(email_lower);

-- ---------------------------------------------------------------------------
-- user_preferences (metadata)
-- ---------------------------------------------------------------------------

create table if not exists public.user_preferences (
  user_id        text        primary key,
  user_name      text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- user_mfa (multi-factor auth factors)
-- ---------------------------------------------------------------------------

create table if not exists public.user_mfa (
  id                text        primary key,
  user_id           text        not null,
  factor_type       text        not null check (factor_type = 'totp'),
  secret_encrypted  text        not null,
  verified_at       timestamptz,
  last_used_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique(user_id, factor_type)
);

create index if not exists idx_user_mfa_user_id on public.user_mfa(user_id);

