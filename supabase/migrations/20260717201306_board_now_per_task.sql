-- Move board_now from one row per person to one row per (person, task), so a
-- note lives with its task and switching your active task no longer wipes it.
-- The green dot is now driven by the `active` flag rather than row existence.

alter table public.board_now add column active boolean not null default false;

-- Existing rows were each the person's active task -> flag them active.
update public.board_now set active = true;

-- task_id becomes part of the key, so it can no longer be null.
delete from public.board_now where task_id is null;
alter table public.board_now alter column task_id set not null;

alter table public.board_now drop constraint board_now_pkey;
alter table public.board_now add constraint board_now_pkey primary key (wrike_user_id, task_id);
