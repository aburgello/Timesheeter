-- Administration is now three named people — Antonio, Guillaume and Ben Gladwyn
-- (KUAQGSEW) — and no longer anyone's by department. The app decides who sees
-- the page from MANAGEMENT_IDS in src/lib/access.js; these two are what let the
-- page's writes through, so the new id has to land in both or Ben gets a People
-- page and Debug Pull grants that silently do nothing.
--
-- Nothing is taken away here: the Project Managers who lose the Administration
-- page never had these writes.

drop policy if exists "profiles_write" on public.profiles;
create policy "profiles_write" on public.profiles
  as permissive for all to authenticated
  using (
    wrike_user_id = ((auth.jwt() -> 'user_metadata'::text) ->> 'wrike_user_id'::text)
    or ((auth.jwt() -> 'user_metadata'::text) ->> 'wrike_user_id'::text)
       in ('KUAWDLVN', 'KUAQT4JC', 'KUAQGSEW')
  )
  with check (
    wrike_user_id = ((auth.jwt() -> 'user_metadata'::text) ->> 'wrike_user_id'::text)
    or ((auth.jwt() -> 'user_metadata'::text) ->> 'wrike_user_id'::text)
       in ('KUAWDLVN', 'KUAQT4JC', 'KUAQGSEW')
  );

-- Same body as 20260814100000_profiles_can_debug_pull.sql (see there for why
-- each condition is in the guard), with the id added.
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
     and claims is not null
     and coalesce(claims ->> 'role', '') <> 'service_role'
     and coalesce(caller, '') not in ('KUAWDLVN', 'KUAQT4JC', 'KUAQGSEW')
  then
    raise exception
      'can_debug_pull is granted by an administrator, not set by the member';
  end if;
  return new;
end;
$$;
