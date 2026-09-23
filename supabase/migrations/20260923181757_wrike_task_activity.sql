-- Who changed a task's status, to what, and who got assigned — kept for six
-- weeks, so "What did I work on?" in Legacy can tell when work on a task began.
--
-- Wrike's API has no status history. The webhook does report every change,
-- but wrike_webhook_events only keeps the task id and event type (it exists to
-- tell open tabs which tasks to refresh) and is emptied after 24 hours. People
-- often don't comment on a task until they send something for review, so the
-- comments alone put the start of the work in the wrong place. A task being
-- moved into Motion, or a designer being assigned, is the real cue.
--
-- Load, which has bitten us before:
--   * No extra Wrike calls: it's all already in the webhook deliveries.
--   * No extra Supabase requests: the worker's one insert per delivery becomes
--     one call to record_wrike_webhook_events, which writes both tables.
--   * wrike_webhook_events is unchanged. It's in the Realtime publication and
--     broadcast to every open tab, so new columns there would ride along on
--     every one of ~6k events a day. The detail lives in this table instead,
--     which is not published.
--   * ~2,300 status changes and ~450 assignment changes a day, so about 115k
--     small rows at the six-week cap.

create table if not exists public.wrike_task_activity (
  id bigint generated always as identity primary key,
  task_id text not null,
  event_type text not null,        -- TaskStatusChanged | TaskResponsiblesAdded | TaskResponsiblesRemoved
  author_id text,                  -- who made the change (Wrike eventAuthorId)
  status text,                     -- status name Wrike sent, for a status change
  custom_status_id text,
  old_custom_status_id text,
  user_ids text[],                 -- who was added or removed, for an assignment change
  occurred_at timestamptz not null
);

-- Wrike can deliver the same payload twice; the second copy is dropped.
create unique index if not exists wrike_task_activity_dedupe
  on public.wrike_task_activity (task_id, event_type, occurred_at, custom_status_id, user_ids)
  nulls not distinct;

-- The modal's two reads: a day's changes for a list of tasks, and a day's
-- assignments to one person.
create index if not exists wrike_task_activity_task_time
  on public.wrike_task_activity (task_id, occurred_at);
create index if not exists wrike_task_activity_assigned
  on public.wrike_task_activity using gin (user_ids)
  where event_type = 'TaskResponsiblesAdded';

alter table public.wrike_task_activity enable row level security;
drop policy if exists "authenticated_read" on public.wrike_task_activity;
create policy "authenticated_read" on public.wrike_task_activity
  as permissive for select to authenticated using (true);

-- The worker's single write per delivery. The events insert is the one that
-- matters (it drives live refresh in every tab), so a problem with the history
-- insert is logged and swallowed rather than allowed to take it down too.
create or replace function public.record_wrike_webhook_events(events jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into wrike_webhook_events (task_id, event_type, occurred_at)
  select e->>'task_id',
         e->>'event_type',
         coalesce((e->>'occurred_at')::timestamptz, now())
  from jsonb_array_elements(events) e;

  begin
    insert into wrike_task_activity
      (task_id, event_type, author_id, status, custom_status_id, old_custom_status_id, user_ids, occurred_at)
    select e->>'task_id',
           e->>'event_type',
           e->>'author_id',
           e->>'status',
           e->>'custom_status_id',
           e->>'old_custom_status_id',
           case when jsonb_typeof(e->'user_ids') = 'array'
                then array(select jsonb_array_elements_text(e->'user_ids'))
           end,
           coalesce((e->>'occurred_at')::timestamptz, now())
    from jsonb_array_elements(events) e
    where e->>'event_type' in ('TaskStatusChanged', 'TaskResponsiblesAdded', 'TaskResponsiblesRemoved')
    on conflict do nothing;
  exception when others then
    raise warning 'wrike_task_activity insert failed: %', sqlerrm;
  end;
end;
$$;

revoke all on function public.record_wrike_webhook_events(jsonb) from public, anon, authenticated;
grant execute on function public.record_wrike_webhook_events(jsonb) to service_role;

-- Six weeks: a timesheet week plus room to look back over a month.
select cron.schedule(
  'wrike_task_activity_cleanup',
  '27 3 * * *',
  $$delete from public.wrike_task_activity where occurred_at < now() - interval '42 days'$$
);
