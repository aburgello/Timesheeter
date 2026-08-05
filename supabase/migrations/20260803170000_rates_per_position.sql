-- Rates move from the person to the position.
--
-- The first cut put hourly_rate on profiles. It belongs on positions: two
-- artworkers bill the same, and a person changing position should change what
-- their time costs without anyone re-keying a number.
--
-- On top of that, some Item Categories bill at a *different* position's rate
-- than the person's own — a designer proofreading bills the Proofreader rate,
-- not the designer rate. That override lives on job_categories, alongside a
-- flag for the categories that don't bill at all (waiting time).
--
-- Safe to run whether or not 20260803120000 was applied: the profiles column
-- is dropped only if it's there.

alter table public.positions
  add column if not exists hourly_rate numeric(10,2) default 150;

update public.positions set hourly_rate = 150 where hourly_rate is null;

-- Per-category rate override. null rate_position_id = bill at whatever
-- position the person who logged the time holds.
alter table public.job_categories
  add column if not exists rate_position_id bigint;
alter table public.job_categories
  add column if not exists unbilled boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'job_categories_rate_position_id_fkey'
  ) then
    alter table public.job_categories
      add constraint job_categories_rate_position_id_fkey
      foreign key (rate_position_id) references positions(id) on delete set null;
  end if;
end $$;

-- The known overrides. Each is a no-op if the position doesn't exist yet under
-- that exact title — the mapping is editable in Administration → Rates, so a
-- missed match is corrected there rather than by re-running this.
update public.job_categories c
   set rate_position_id = p.id
  from public.positions p
 where lower(p.title) = 'proofreader'
   and c.name in ('Digital - Proofreading', 'Print - Proofreading');

update public.job_categories c
   set rate_position_id = p.id
  from public.positions p
 where lower(p.title) = 'asset manager'
   and c.name in (
     'Digital - Approval Site Management/Maintenance',
     'Digital - Upload/Downloading',
     'Print - Upload/Downloading'
   );

update public.job_categories c
   set rate_position_id = p.id
  from public.positions p
 where lower(p.title) = 'project manager'
   and c.name in ('Digital - Project Management', 'Print - Project Management');

update public.job_categories c
   set rate_position_id = p.id
  from public.positions p
 where lower(p.title) = 'watermarking'
   and c.name = 'Watermarking';

-- Waiting time is logged but never billed.
update public.job_categories
   set unbilled = true
 where name = 'Additional hours waiting time';

-- Superseded by positions.hourly_rate.
alter table public.profiles drop column if exists hourly_rate;
