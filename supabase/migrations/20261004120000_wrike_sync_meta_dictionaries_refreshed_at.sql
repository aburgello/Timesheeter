-- The folder/contact/status dictionaries on the shared wrike_sync_meta row get
-- their own refresh clock.
--
-- They were meant to refresh daily, but "a day old" was measured from
-- last_synced_at, which every 15-minute sync moves forward, so in practice
-- they only refreshed when someone forced a full sync. useWrikeCache now reads
-- this column when it exists and only moves it after a refresh that came back
-- complete. Null means "never", so the first sync after this runs refreshes
-- them once.
--
-- Safe in either order with the app change: the app checks the column is
-- there before using it, and nothing else reads or writes it.
alter table public.wrike_sync_meta
  add column if not exists dictionaries_refreshed_at timestamp with time zone;
