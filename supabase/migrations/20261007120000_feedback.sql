-- "Report a problem" on the timesheet page: what someone typed, who they are
-- and which page they sent it from. Read in Administration › Feedback.
--
-- Anyone signed in may add a report under their own Wrike id. Only an
-- administrator reads them, marks them done or deletes them.

create table public.feedback (
  id bigint generated always as identity primary key,
  created_at timestamp with time zone not null default now(),
  wrike_user_id text not null,
  user_name text,
  page text,
  message text not null check (char_length(btrim(message)) between 1 and 4000),
  resolved_at timestamp with time zone
);

alter table public.feedback enable row level security;

create policy "feedback_send" on public.feedback
  as permissive for insert to authenticated
  with check (wrike_user_id = caller_wrike_id());

create policy "feedback_admin_read" on public.feedback
  as permissive for select to authenticated
  using (caller_is_admin());

create policy "feedback_admin_update" on public.feedback
  as permissive for update to authenticated
  using (caller_is_admin()) with check (caller_is_admin());

create policy "feedback_admin_delete" on public.feedback
  as permissive for delete to authenticated
  using (caller_is_admin());
