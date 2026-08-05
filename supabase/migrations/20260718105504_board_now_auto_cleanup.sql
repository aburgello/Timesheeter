-- Keep board_now from accumulating forever. Two triggers for removal:
--   1. stale: no activity in 3 days
--   2. done:  the task's cached Wrike status is no longer "Active"
--            (Completed or Cancelled) -- cleared on the next hourly tick.

-- (1) Make updated_at mean "last activity". The client upserts don't set it,
--     so without this it would only ever reflect row-creation time and the
--     3-day TTL would measure age, not staleness.
create or replace function public.set_board_now_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists board_now_touch on public.board_now;
create trigger board_now_touch
  before update on public.board_now
  for each row execute function public.set_board_now_updated_at();

-- (2) The garbage collector. A row goes when it's stale OR its task is done.
--     A task missing from the cache falls through to the age rule only, so a
--     transient cache gap never wipes a fresh note.
--     (Recreated as plpgsql in 20260718110221 so it's order-independent.)
create or replace function public.cleanup_board_now()
returns void
language sql
as $$
  delete from public.board_now b
  where b.updated_at < now() - interval '3 days'
     or exists (
       select 1 from public.wrike_tasks_cache c
       where c.id = b.task_id
         and coalesce(c.task_data->>'status', '') <> 'Active'
     );
$$;

-- (3) Run it hourly. cron.schedule upserts by name, so this is re-runnable.
select cron.schedule('board_now_cleanup', '0 * * * *', 'select public.cleanup_board_now();');
