-- When someone left the company. Leavers keep their profile row (their old
-- timesheet rows refer to it) but drop out of team boards, the shared cache's
-- team list, the Toolbox panel's name matching and Administration › People's
-- main list. Set by "Sync from Wrike" when Wrike reports the account deleted,
-- or by hand in People; cleared by hand ("Restore").
--
-- The app reads profiles with select * and checks this in code, so it works
-- before this column exists (nobody counts as having left) and after.
alter table public.profiles add column if not exists left_at timestamp with time zone;
