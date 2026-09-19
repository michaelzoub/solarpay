-- Run this once in the Supabase SQL editor, then configure the server with
-- SUPABASE_URL and SUPABASE_SECRET_KEY. No wallet private keys are stored here.
create table if not exists public.badge_wallets (
  badge_id text primary key check (char_length(badge_id) between 1 and 63),
  owner_id text,
  role text not null check (role in ('customer', 'merchant')),
  solana_address text not null unique,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.badge_wallets
  add column if not exists owner_id text;

alter table public.badge_wallets
  drop constraint if exists badge_wallets_badge_id_check;

alter table public.badge_wallets
  add constraint badge_wallets_badge_id_check
  check (char_length(badge_id) between 1 and 63);

-- Unique per (owner, role), not per owner: one laptop owns at most one sender
-- and one merchant badge. See supabase/20260919_badge_per_role.sql.
drop index if exists public.badge_wallets_owner_id_idx;

create unique index if not exists badge_wallets_owner_role_idx
  on public.badge_wallets (owner_id, role);

alter table public.badge_wallets enable row level security;
revoke all on table public.badge_wallets from anon, authenticated;
grant all on table public.badge_wallets to service_role;

create index if not exists badge_wallets_role_idx
  on public.badge_wallets (role, enabled);
