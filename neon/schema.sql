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

-- Immutable offline reports and idempotency receipts. Ordinary app-data saves,
-- device deletion, and workspace edits cannot erase source observations.
-- Account deletion cascades for privacy; restoring app JSON is not a history restore.
create table if not exists public.inventory_import_reports (
  owner_user_id text not null references public.app_data(user_id) on delete cascade,
  workspace_id text not null,
  report_id text not null,
  content_digest text not null check (content_digest ~ '^[a-f0-9]{64}$'),
  hardware_identity text not null check (hardware_identity ~ '^[a-f0-9]{64}$'),
  serial_key text not null,
  uuid_key text not null,
  collected_key text not null,
  device_id text not null,
  report jsonb not null,
  imported_at timestamptz not null default clock_timestamp(),
  primary key (owner_user_id, workspace_id, report_id)
);
create index if not exists inventory_import_identity_idx
  on public.inventory_import_reports(owner_user_id, workspace_id, hardware_identity);
create index if not exists inventory_import_serial_idx
  on public.inventory_import_reports(owner_user_id, workspace_id, serial_key);
create index if not exists inventory_import_uuid_idx
  on public.inventory_import_reports(owner_user_id, workspace_id, uuid_key);
create index if not exists inventory_import_history_idx
  on public.inventory_import_reports(owner_user_id, workspace_id, device_id, collected_key desc, report_id);
