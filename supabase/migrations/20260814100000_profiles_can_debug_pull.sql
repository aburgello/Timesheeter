-- Debug Pull (pull my Wrike timelogs for one chosen date) as a per-member
-- grant, instead of riding on the single hardcoded admin id.
--
-- Until now the button was gated on `isAdmin` in App.jsx — wrikeUserId ===
-- "KUAWDLVN" — which is the same flag that opens the Administration modal, the
-- raw Wrike API explorer and the Canvas film-code scan. Giving one more person
-- a dated pull by adding them to that check would hand them all four, so the
-- capability gets its own column and is granted to a name at a time.
--
-- Scope check, because the name sounds scarier than it is: a debug pull runs
-- against the caller's OWN Wrike token and writes the caller's OWN timesheet
-- rows. It reaches no further than the ordinary Pull button — it only lets you
-- aim at a date other than today/yesterday, e.g. to recover a day you were off.
alter table public.profiles
  add column if not exists can_debug_pull boolean not null default false;

comment on column public.profiles.can_debug_pull is
  'When true, this member sees the Debug Pull control on Legacy Timesheets and can pull their own Wrike timelogs for a chosen past date. Granted by an administrator (see guard_can_debug_pull); members cannot set it on themselves.';

-- profiles_write lets every member write their OWN row, which is right for the
-- preference columns next door but wrong for a grant: without this trigger the
-- column would be self-issuable by anyone who can reach the REST endpoint.
--
-- A trigger rather than a column-level REVOKE because Postgres column
-- privileges do not subtract from a table-level GRANT — carving this one column
-- out would mean revoking UPDATE on the table and re-granting it column by
-- column, which then has to be remembered on every future column added.
--
-- Only fires when the value actually changes, so the member's own writes to
-- default_category / group_multi_country pass through untouched.
create or replace function public.guard_can_debug_pull()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  caller text := claims -> 'user_metadata' ->> 'wrike_user_id';
begin
  if new.can_debug_pull is distinct from old.can_debug_pull
     -- Only requests arriving through PostgREST are policed. A direct SQL
     -- connection (this migration, psql, the SQL editor) carries no claims at
     -- all and is already past any check this trigger could make.
     and claims is not null
     -- Server-side work (the Wrike profile sync) carries no member identity and
     -- is not what this guard is about.
     and coalesce(claims ->> 'role', '') <> 'service_role'
     -- coalesce so a claims blob without a wrike id reads as "not an
     -- administrator" rather than as NULL, which would make the whole
     -- condition NULL and let the write through.
     and coalesce(caller, '') not in ('KUAWDLVN', 'KUAQT4JC')
  then
    raise exception
      'can_debug_pull is granted by an administrator, not set by the member';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_can_debug_pull on public.profiles;
create trigger guard_can_debug_pull
  before update on public.profiles
  for each row execute function public.guard_can_debug_pull();

-- Chris Prime.
update public.profiles
   set can_debug_pull = true
 where wrike_user_id = 'KUAQLBDQ';
