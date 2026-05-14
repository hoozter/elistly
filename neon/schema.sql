-- Elistly Neon schema.
-- Safe to re-run.
--
-- Auth is provided by Neon Auth in the neon_auth schema.
-- The Cloudflare Worker owns authorization for these public tables and connects
-- with NEON_DATABASE_URL. Browser clients must never receive that URL.

-- ---------------------------------------------------------------------------
-- app_data
-- ---------------------------------------------------------------------------

create table if not exists public.app_data (
  user_id    text        primary key,
  payload    jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Older migration attempts used a `data` column. Preserve existing rows by
-- renaming it when possible, or copying it into the canonical `payload` column.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'app_data' and column_name = 'data'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'app_data' and column_name = 'payload'
  ) then
    alter table public.app_data rename column data to payload;
  end if;
end
$$;

alter table public.app_data
  add column if not exists payload jsonb not null default '{}'::jsonb;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'app_data' and column_name = 'data'
  ) then
    update public.app_data
      set payload = data
      where payload = '{}'::jsonb and data is not null;
  end if;
end
$$;

alter table public.app_data
  add column if not exists updated_at timestamptz not null default now();

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  user_id      text        primary key,
  email        text,
  display_name text,
  updated_at   timestamptz not null default now()
);

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
  add column if not exists email text;

alter table public.profiles
  add column if not exists display_name text;

alter table public.profiles
  add column if not exists updated_at timestamptz not null default now();

-- ---------------------------------------------------------------------------
-- admin_users
-- ---------------------------------------------------------------------------

create table if not exists public.admin_users (
  user_id    text        primary key,
  created_at timestamptz not null default now()
);
