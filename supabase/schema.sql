-- Otto AI — per-user persistence (watchlist + track record).
-- Run this once in the Supabase SQL Editor (Dashboard → SQL Editor → New query).
--
-- Mirrors the shapes in src/lib/otto/persistence.ts. RLS ensures every user
-- can only ever see/edit their own rows — enforced by Postgres itself, not
-- application code, so a bug in a route handler can't leak one user's data
-- into another's response.

create table if not exists public.watchlist (
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null,
  company_name text not null,
  added_at timestamptz not null,
  added_price numeric not null,
  added_conviction_score numeric not null,
  added_verdict text not null,
  primary key (user_id, symbol)
);

alter table public.watchlist enable row level security;

create policy "watchlist_select_own" on public.watchlist
  for select using (auth.uid() = user_id);
create policy "watchlist_insert_own" on public.watchlist
  for insert with check (auth.uid() = user_id);
create policy "watchlist_update_own" on public.watchlist
  for update using (auth.uid() = user_id);
create policy "watchlist_delete_own" on public.watchlist
  for delete using (auth.uid() = user_id);

create table if not exists public.call_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null,
  company_name text not null,
  called_at timestamptz not null,
  called_price numeric not null,
  conviction_score numeric not null,
  verdict text not null,
  created_at timestamptz not null default now()
);

create index if not exists call_log_user_id_idx on public.call_log(user_id);

alter table public.call_log enable row level security;

create policy "call_log_select_own" on public.call_log
  for select using (auth.uid() = user_id);
create policy "call_log_insert_own" on public.call_log
  for insert with check (auth.uid() = user_id);
create policy "call_log_delete_own" on public.call_log
  for delete using (auth.uid() = user_id);
