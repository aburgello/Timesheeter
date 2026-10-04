-- Lets exactly one open tab act on each Wrike webhook event. Every tab receives
-- every event over Realtime; without this, each one fetched the changed task
-- from Wrike and wrote it to the shared cache. A tab claims the events it was
-- sent, works only on the ones it won, and picks up the rest from the shared
-- cache. Read by src/lib/sharedTaskSync.js.
--
-- A separate table rather than a column on wrike_webhook_events: that table is
-- in the Realtime publication, and updating its rows would put every claim on
-- the wire too.
create table if not exists public.wrike_webhook_claims (
  event_id bigint primary key,
  claimed_at timestamptz not null default now()
);
alter table public.wrike_webhook_claims enable row level security;
-- No policies: reached only through the function below.

create or replace function public.claim_wrike_webhook_events(event_ids bigint[])
returns setof bigint
language sql
security definer
set search_path = public
as $$
  insert into wrike_webhook_claims (event_id)
  select distinct unnest(event_ids)
  on conflict do nothing
  returning event_id;
$$;

revoke all on function public.claim_wrike_webhook_events(bigint[]) from public, anon;
grant execute on function public.claim_wrike_webhook_events(bigint[]) to authenticated;

-- Events themselves are purged after 24 hours; claims outlive them by a day.
select cron.schedule(
  'wrike_webhook_claims_cleanup',
  '47 3 * * *',
  $$delete from public.wrike_webhook_claims where claimed_at < now() - interval '2 days'$$
);
