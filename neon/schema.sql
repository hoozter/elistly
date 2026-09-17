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

alter table public.app_data
  add column if not exists payload jsonb not null default '{}'::jsonb;

alter table public.app_data
  add column if not exists updated_at timestamptz not null default now();

-- Opaque one-purpose secrets for unattended device registration. The secret
-- itself is never stored; token_hash is SHA-256 of the value shown once.
create table if not exists public.device_registration_tokens (
  id text primary key,
  owner_user_id text not null,
  workspace_id text not null,
  token_hash text not null unique,
  label text,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  constraint device_registration_tokens_hash_length check (char_length(token_hash) = 64)
);
alter table public.device_registration_tokens alter column expires_at drop not null;

create index if not exists device_registration_tokens_owner_workspace_idx
  on public.device_registration_tokens (owner_user_id, workspace_id);

-- Per-device secrets for scheduled inventory reporting. Unlike registration
-- secrets, each credential is permanently bound to one existing device.
create table if not exists public.device_reporting_tokens (
  id text primary key,
  owner_user_id text not null,
  workspace_id text not null,
  device_id text not null,
  token_hash text not null unique,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  constraint device_reporting_tokens_hash_length check (char_length(token_hash) = 64)
);

create index if not exists device_reporting_tokens_owner_device_idx
  on public.device_reporting_tokens (owner_user_id, device_id);

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  user_id      text        primary key,
  email        text,
  display_name text,
  updated_at   timestamptz not null default now()
);

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
