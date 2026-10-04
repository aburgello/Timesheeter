-- REHEARSAL ONLY: applies both migrations inside a transaction, tests them on
-- the live table, then deliberately fails so that EVERYTHING is undone.
-- Expected outcome: an error reading "REHEARSAL RESULTS (all should be true): {...}".
-- The 3-second lock limit means it gives up rather than queue behind live reads.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '45s';

-- Lets a browser ask the shared task cache "what changed, and what was removed,
-- since I last looked?" instead of keying on Wrike's own updatedDate, which
-- misses removals entirely and misses any row rewritten without a Wrike change
-- (repairs, backfills). Read by src/lib/sharedTaskSync.js.

-- Existing rows get an old timestamp, so a browser's first catch-up after this
-- fetches only rows written since, not the whole 80 MB table.
alter table public.wrike_tasks_cache
  add column if not exists cached_at timestamptz not null default '2000-01-01T00:00:00Z';
alter table public.wrike_tasks_cache alter column cached_at set default now();
create index if not exists wrike_tasks_cache_cached_at_idx
  on public.wrike_tasks_cache (cached_at);

-- Stamped by the database, and only when the content changes: re-writing an
-- identical row (the Motion board does on every open) must not make every
-- browser download it again. clock_timestamp(), not now(): now() is when the
-- transaction began, so a slow batch could land behind a reader's cursor.
create or replace function public.wrike_tasks_cache_touch()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and new.task_data is not distinct from old.task_data then
    new.cached_at := old.cached_at;
  else
    new.cached_at := clock_timestamp();
  end if;
  return new;
end;
$$;

drop trigger if exists wrike_tasks_cache_touch on public.wrike_tasks_cache;
create trigger wrike_tasks_cache_touch
  before insert or update on public.wrike_tasks_cache
  for each row execute function public.wrike_tasks_cache_touch();

-- One row per task removed from the cache, so other browsers can drop their
-- local copy. A task that comes back loses its entry.
create table if not exists public.wrike_tasks_cache_removed (
  id text primary key,
  removed_at timestamptz not null default now()
);
create index if not exists wrike_tasks_cache_removed_at_idx
  on public.wrike_tasks_cache_removed (removed_at);

alter table public.wrike_tasks_cache_removed enable row level security;
drop policy if exists "authenticated_read" on public.wrike_tasks_cache_removed;
create policy "authenticated_read" on public.wrike_tasks_cache_removed
  as permissive for select to authenticated using (true);

create or replace function public.wrike_tasks_cache_tombstone()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    insert into wrike_tasks_cache_removed (id, removed_at) values (old.id, clock_timestamp())
      on conflict (id) do update set removed_at = excluded.removed_at;
    return old;
  end if;
  delete from wrike_tasks_cache_removed where id = new.id;
  return new;
end;
$$;

drop trigger if exists wrike_tasks_cache_tombstone on public.wrike_tasks_cache;
create trigger wrike_tasks_cache_tombstone
  after insert or delete on public.wrike_tasks_cache
  for each row execute function public.wrike_tasks_cache_tombstone();

-- A browser that hasn't caught up in 30 days re-checks every id instead.

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


-- ── The tests. This block ALWAYS ends in an error on purpose: the error is how
-- the results are shown, and it also undoes everything above. Nothing is kept.
do $t$
declare
  x text; r jsonb := '{}'::jsonb; c0 timestamptz; c1 timestamptz; c2 timestamptz; n int;
begin
  select id, cached_at into x, c0 from wrike_tasks_cache order by id limit 1;
  insert into wrike_tasks_cache (id, wrike_user_id, task_data, updated_date)
    select id, wrike_user_id, task_data, updated_date from wrike_tasks_cache where id = x
    on conflict (id) do update set task_data = excluded.task_data, wrike_user_id = excluded.wrike_user_id;
  select cached_at into c1 from wrike_tasks_cache where id = x;
  r := r || jsonb_build_object('1_unchanged_task_keeps_its_date', c1 = c0);
  update wrike_tasks_cache set task_data = task_data || '{"_rehearsal":1}'::jsonb where id = x;
  select cached_at into c2 from wrike_tasks_cache where id = x;
  r := r || jsonb_build_object('2_changed_task_gets_new_date', c2 > c0);
  insert into wrike_tasks_cache (id, wrike_user_id, task_data) values ('ZZ_REHEARSAL', 'x', '{"a":1}');
  select count(*) into n from wrike_tasks_cache_removed where id = 'ZZ_REHEARSAL';
  r := r || jsonb_build_object('3_new_task_not_marked_removed', n = 0);
  delete from wrike_tasks_cache where id = 'ZZ_REHEARSAL';
  select count(*) into n from wrike_tasks_cache_removed where id = 'ZZ_REHEARSAL';
  r := r || jsonb_build_object('4_deleted_task_recorded', n = 1);
  insert into wrike_tasks_cache (id, wrike_user_id, task_data) values ('ZZ_REHEARSAL', 'x', '{"a":2}');
  select count(*) into n from wrike_tasks_cache_removed where id = 'ZZ_REHEARSAL';
  r := r || jsonb_build_object('5_readded_task_unmarked', n = 0);
  select count(*) into n from claim_wrike_webhook_events(array[-1,-2]::bigint[]);
  r := r || jsonb_build_object('6_first_tab_wins_2_of_2', n = 2);
  select count(*) into n from claim_wrike_webhook_events(array[-2,-3]::bigint[]);
  r := r || jsonb_build_object('7_second_tab_wins_only_1', n = 1);
  raise exception 'REHEARSAL RESULTS (all should be true): %', r;
end
$t$;
