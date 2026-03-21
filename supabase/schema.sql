-- Elistly core schema: per-user app data store.
-- Safe to re-run to align schema and policies.

create table if not exists public.app_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
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
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "app_data_insert_own" on public.app_data;
create policy "app_data_insert_own"
  on public.app_data
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "app_data_update_own" on public.app_data;
create policy "app_data_update_own"
  on public.app_data
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "app_data_delete_own" on public.app_data;
create policy "app_data_delete_own"
  on public.app_data
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- Profile display name (persists reliably; auth.user_metadata is not always persisted).
create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  updated_at timestamptz not null default now()
);

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'id'
  ) and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'user_id'
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
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Admins: list is used by the API Worker (service role) to allow admin routes.
-- Add your user: insert into public.admin_users (user_id) values ('your-auth-user-uuid');
create table if not exists public.admin_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;

-- No policies: only the Worker (service role) reads this table.
