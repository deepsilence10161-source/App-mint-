-- Profiles: one row per person, readable only by its owner.
-- RLS is switched on in the same migration that creates the table, so there is
-- no window in which the table exists unprotected.

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  avatar_path text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.profiles force row level security;

create policy "profiles are readable by their owner"
  on public.profiles for select to authenticated
  using (id = auth.uid());

create policy "profiles are writable by their owner"
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy "profiles are created by their owner"
  on public.profiles for insert to authenticated
  with check (id = auth.uid());
