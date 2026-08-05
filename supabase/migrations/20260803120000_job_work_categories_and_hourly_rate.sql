-- Two unrelated additions that landed together off the same round of feedback.
--
-- 1. job_work_categories — the "Job Work Category" list on a job. Deliberately
--    NOT job_categories: that table holds the *Item* Categories (Digital -
--    Retouching, Print - Flight Checking, …) picked per timesheet line. A job's
--    work category is a separate, territory-prefixed taxonomy (AUS - Publicity,
--    …), and the Job Book form was wrongly pointed at the item list. The column
--    it writes to (jobs.job_work_category) was already correct, so only the
--    source list changes — existing rows still hold item-category values and
--    are left alone rather than guessed at.
--
-- 2. profiles.hourly_rate — drives the Rate / Total columns in the Jobs Feed,
--    which were hardcoded placeholders. 150 for everyone to start with; per
--    person from the People admin after that.

create table if not exists public.job_work_categories (
  id bigint generated always as identity not null,
  name text not null,
  created_at timestamp with time zone default now()
);

alter table public.job_work_categories
  add constraint job_work_categories_pkey primary key (id);
alter table public.job_work_categories
  add constraint job_work_categories_name_key unique (name);

alter table public.job_work_categories enable row level security;
create policy "auth_all" on public.job_work_categories
  as permissive for all to authenticated using (true) with check (true);

-- Starter values only — the ones legible in the source system's picker. The
-- rest are added from Administration → Supporting Content → Job Work
-- Categories rather than invented here.
insert into public.job_work_categories (name) values
  ('AUS - House Job'),
  ('AUS - Media'),
  ('AUS - Partnerships / Exhibition'),
  ('AUS - Publicity')
on conflict (name) do nothing;

-- Numeric, not money: the app formats the currency at render time, and money
-- carries a locale-dependent symbol into the column itself.
alter table public.profiles
  add column if not exists hourly_rate numeric(10,2) default 150;

-- Backfill people who already existed — the default only applies to new rows.
update public.profiles set hourly_rate = 150 where hourly_rate is null;
