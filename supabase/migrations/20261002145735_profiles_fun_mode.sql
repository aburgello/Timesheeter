-- One switch for the timesheet's playful extras (the coins a time stepper
-- throws into the day total, and whatever joins them), set by the member in
-- Profile → Settings.
--
-- On the profile for the same reason the timesheet preferences are (see
-- 20260812120000_timesheet_prefs_per_member.sql): it's a statement about the
-- person, and on localStorage it would come back on at their second machine.
--
-- DEFAULT TRUE: the extras are on until someone says otherwise, so existing
-- members get them without doing anything. NOT NULL so the app has no third
-- state to read. No new policy — profiles_write already lets a member write
-- their own row.
alter table public.profiles
  add column if not exists fun_mode boolean not null default true;

comment on column public.profiles.fun_mode is
  'When true (the default), this member sees the timesheet''s playful extras, such as the coins a time stepper throws into the day total. Set by the member in Profile → Settings; it changes nothing about their logged time.';
