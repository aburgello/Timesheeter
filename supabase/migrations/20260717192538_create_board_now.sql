-- "Working now" board indicators. First cut: one row per person, holding the
-- single task they're currently active on plus a free-text note.
-- (Superseded by 20260717201306_board_now_per_task, which makes it per-task.)

create table public.board_now (
  wrike_user_id text primary key,
  department text not null,
  task_id text,
  task_title text,
  note text,
  user_name text not null,
  user_color text,
  updated_at timestamptz default now()
);

alter table public.board_now enable row level security;
create policy "anon all" on public.board_now
  as permissive for all to authenticated using (true) with check (true);

-- Realtime needs the full old row on DELETE so the client's department filter
-- (a non-PK column) still matches.
alter table public.board_now replica identity full;
alter publication supabase_realtime add table public.board_now;
