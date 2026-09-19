-- One laptop must be able to own a sender AND a merchant badge at the same
-- time.
--
-- badge_wallets_owner_id_idx was UNIQUE on owner_id alone, which allowed a
-- laptop only one badge. Registering a second one could not insert a row, so
-- setup renamed the first badge instead; the badge that lost its row then
-- failed approval with CUSTOMER_NOT_FOUND. This mirrors migration
-- migrations/006_badge_per_role.sql on the local SQLite store.
--
-- Safe to run more than once. Run it in the Supabase SQL editor.

begin;

-- Surface any rows that would violate the new constraint BEFORE dropping the
-- old one, so a duplicate is reported rather than silently blocking the create.
do $$
declare
  duplicate record;
begin
  for duplicate in
    select owner_id, role, count(*) as n
    from public.badge_wallets
    where owner_id is not null
    group by owner_id, role
    having count(*) > 1
  loop
    raise exception
      'badge_wallets has % rows for owner_id=% role=%; resolve the duplicates before applying this migration',
      duplicate.n, duplicate.owner_id, duplicate.role;
  end loop;
end $$;

drop index if exists public.badge_wallets_owner_id_idx;

-- Postgres treats NULLs as distinct in a unique index, so unowned rows (the
-- legacy badges with owner_id null) are unconstrained, as before.
create unique index if not exists badge_wallets_owner_role_idx
  on public.badge_wallets (owner_id, role);

commit;
