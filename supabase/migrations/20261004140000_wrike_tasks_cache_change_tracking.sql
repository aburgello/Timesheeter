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
select cron.schedule(
  'wrike_tasks_cache_removed_cleanup',
  '37 3 * * *',
  $$delete from public.wrike_tasks_cache_removed where removed_at < now() - interval '30 days'$$
);
