begin;

alter table public.badge_wallets
  add column if not exists owner_id text;

alter table public.badge_wallets
  drop constraint if exists badge_wallets_badge_id_check;

alter table public.badge_wallets
  add constraint badge_wallets_badge_id_check
  check (char_length(badge_id) between 1 and 63);

create unique index if not exists badge_wallets_owner_id_idx
  on public.badge_wallets (owner_id);

commit;
