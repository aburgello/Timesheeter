-- Film codes corrected, added or removed by hand in the Campaign Canvas codes
-- panel: { CODE: "Film name" } to set one, { CODE: null } to remove one.
-- Applied on top of what syncs and Map Films discover, so a scan can't bring
-- back a removed code or undo a corrected name.
alter table public.wrike_sync_meta
  add column if not exists film_code_overrides jsonb not null default '{}'::jsonb;
