-- When the daily people sync from Wrike last ran (lib/peopleSync.js). An
-- administrator's browser claims the day's run by moving this forward first.
alter table public.wrike_sync_meta add column if not exists people_synced_at timestamp with time zone;
