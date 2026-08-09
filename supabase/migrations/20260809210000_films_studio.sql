-- Films belong to a studio, but only the title was ever saved: Film Setup
-- syncs projects out of a studio folder in Wrike, then inserts bare titles, so
-- the studio association was dropped on the floor. The Job Setup film picker
-- now groups films by studio (newest first within each group), so the picker
-- needs it back.

alter table public.films add column studio text;

-- One-time backfill: a film's studio is the studio that most of its jobs bill
-- to (jobs.client carries the studio client name, e.g. "Paramount Pictures").
-- mode() over the mapped studios ignores the free-text clients that map to
-- NULL. Films with no mapped jobs — still in Wrike, nothing in the Job Book
-- yet — stay NULL ("Other" in the picker) until their studio's film sync runs
-- again, which now records the studio at insert time.
update public.films f
set studio = c.studio
from (
  select film_title, mode() within group (order by studio) as studio
  from (
    select j.film_title,
           case
             when j.client ilike 'paramount%'  then 'Paramount'
             when j.client ilike 'universal%'  then 'Universal'
             when j.client ilike 'sony%'       then 'Sony'
             when j.client ilike 'disney%'     then 'Disney'
             when j.client ilike 'warner%'     then 'Warner'
             when j.client ilike 'netflix%'    then 'Netflix'
             when j.client ilike 'apple%'      then 'Apple'
             when j.client ilike 'amazon%'     then 'Amazon'
             when j.client ilike 'lionsgate%'  then 'Lionsgate'
             when j.client ilike 'xyi%'        then 'XYi'
             else null
           end as studio
    from public.jobs j
    where j.film_title is not null and j.film_title <> ''
  ) t
  where studio is not null
  group by film_title
) c
where f.title = c.film_title
  and f.studio is null;

comment on column public.films.studio is
  'The studio whose Wrike folder this film was synced from. NULL until the film is synced or backfilled; the Job Setup picker groups on it.';
