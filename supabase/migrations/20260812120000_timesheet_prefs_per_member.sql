-- Two per-person timesheet preferences, stored against the profile rather than
-- in localStorage.
--
-- Both of these are statements about how a PERSON works, not about the device
-- they happen to be sitting at: "my work is nearly always print retouching",
-- "I spread small amounts of time across many markets and want them as one
-- entry". On localStorage they would silently reset on a second machine and
-- would never be visible to anything outside the Legacy grid — so they live
-- here, keyed by wrike_user_id like every other per-member fact in this app.
--
-- (Contrast xyi_legacy_frozenDays, which stays in localStorage on purpose: a
-- day lock is a UI state for one browser, not something about the person.)
--
-- No new policy is needed. profiles_write already lets a member write their own
-- row (and Management ids write anyone's), which is exactly the access these
-- two columns want — see 20260803183000_asset_manager_rate_and_profiles_admin_write.sql.

-- NULL, not a default: null means "this member has never chosen", which is the
-- state the app must be able to tell apart from a real choice. Only when it is
-- null does the category guess fall back to its keyword rules; any non-null
-- value wins outright, including one the keyword rules would have contradicted.
-- A default here would make every existing member look like they had opted in.
alter table public.profiles
  add column if not exists default_category text;

-- Deliberately DEFAULT FALSE rather than true. Merging markets into one entry
-- is lossy — 2h Brazil + 30m Denmark becomes 2.5h across both, and the split
-- cannot be recovered from the merged row's own fields — so it is opt-in, and
-- existing members keep the one-row-per-market behaviour until they ask for
-- otherwise. NOT NULL so the app never has to treat null as a third state.
alter table public.profiles
  add column if not exists group_multi_country boolean not null default false;

comment on column public.profiles.default_category is
  'Timesheet category this member''s pulled rows default to, from CATEGORIES in src/constants.js. NULL = no preference; the pull falls back to its PRINT/REVISION keyword guess. A non-null value beats that guess.';

comment on column public.profiles.group_multi_country is
  'When true, a Wrike pull merges this member''s rows that share job + day + category and differ only by market into a single entry covering every market, summing the raw time before rounding. The merged row keeps every constituent timelog id in wrike_timelog_id, so the merge can be traced back.';
