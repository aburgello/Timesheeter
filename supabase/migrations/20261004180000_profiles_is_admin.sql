-- Administration access becomes a per-person flag, profiles.is_admin, set from
-- Administration › People, instead of a list of ids repeated in the app, the
-- profiles_write policy and the guard trigger.
--
-- caller_wrike_id() is the one place the access rules read who is asking, so
-- changing where that comes from later touches only that function.

alter table public.profiles add column if not exists is_admin boolean not null default false;
update public.profiles set is_admin = true
  where wrike_user_id in ('KUAWDLVN', 'KUAQT4JC', 'KUAQGSEW');

create or replace function public.caller_wrike_id()
returns text
language sql
stable
as $$
  select auth.jwt() -> 'user_metadata' ->> 'wrike_user_id'
$$;

-- security definer so the policy on profiles can read profiles without
-- evaluating itself.
create or replace function public.caller_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles
    where wrike_user_id = caller_wrike_id() and is_admin and left_at is null
  )
$$;

drop policy if exists "profiles_write" on public.profiles;
create policy "profiles_write" on public.profiles
  as permissive for all to authenticated
  using (wrike_user_id = caller_wrike_id() or caller_is_admin())
  with check (wrike_user_id = caller_wrike_id() or caller_is_admin());

-- Members may edit their own row, so the grants on it (Debug Pull,
-- Administration) are checked here: only an administrator changes them, and
-- the last active administrator can't be removed. Requests without claims
-- (the SQL editor) and the service role are let through.
create or replace function public.guard_profile_grants()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  checked boolean := claims is not null and coalesce(claims ->> 'role', '') <> 'service_role';
  grants_changed boolean;
begin
  if tg_op = 'INSERT' then
    grants_changed := new.is_admin or coalesce(new.can_debug_pull, false);
  else
    grants_changed := new.is_admin is distinct from old.is_admin
      or new.can_debug_pull is distinct from old.can_debug_pull;
  end if;
  if grants_changed and checked and not caller_is_admin() then
    raise exception 'Debug Pull and Administration access are granted by an administrator';
  end if;

  if tg_op = 'UPDATE' and old.is_admin and old.left_at is null
     and (not new.is_admin or new.left_at is not null)
     and not exists (
       select 1 from profiles
       where is_admin and left_at is null and wrike_user_id <> old.wrike_user_id
     )
  then
    raise exception 'At least one administrator has to remain';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_can_debug_pull on public.profiles;
drop function if exists public.guard_can_debug_pull();
create trigger guard_profile_grants
  before insert or update on public.profiles
  for each row execute function public.guard_profile_grants();
