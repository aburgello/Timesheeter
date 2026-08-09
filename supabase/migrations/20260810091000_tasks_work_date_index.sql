-- Range scans on work_date are the reason the column exists (week filters,
-- month reports, the jobs feed's date ordering). Partial: the only null rows
-- are the two blank-date ones, and they are never in a date range.
create index if not exists tasks_work_date_idx
  on public.tasks (work_date)
  where work_date is not null;
