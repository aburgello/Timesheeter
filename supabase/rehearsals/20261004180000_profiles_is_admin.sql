-- Rehearsal for migrations/20261004180000_profiles_is_admin.sql. Paste the
-- whole file into Supabase's SQL editor and run it. It applies the migration,
-- tests it, and ends with an error on purpose that lists the results and undoes
-- everything. Nothing is kept.

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

-- ── The tests. Always ends in an error, which shows the results and rolls back.
do $t$
declare
  r jsonb := '{}'::jsonb; admin_id text := 'KUAWDLVN'; member text; other text; n int; ok boolean;
begin
  select wrike_user_id into member from profiles where not is_admin and left_at is null order by wrike_user_id limit 1;
  select wrike_user_id into other from profiles where not is_admin and left_at is null and wrike_user_id <> member order by wrike_user_id limit 1;
  r := r || jsonb_build_object('01_three_admins', (select count(*) from profiles where is_admin) = 3);
  r := r || jsonb_build_object('02_old_trigger_gone', not exists (select 1 from pg_trigger where tgname = 'guard_can_debug_pull'));

  -- As a member.
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'user_metadata', jsonb_build_object('wrike_user_id', member))::text, true);
  perform set_config('role', 'authenticated', true);
  r := r || jsonb_build_object('03_member_not_admin', not caller_is_admin());
  update profiles set updated_at = updated_at where wrike_user_id = member;
  get diagnostics n = row_count;
  r := r || jsonb_build_object('04_member_edits_own_row', n = 1);
  update profiles set department = department where wrike_user_id = other;
  get diagnostics n = row_count;
  r := r || jsonb_build_object('05_member_cant_edit_others', n = 0);
  ok := false;
  begin update profiles set is_admin = true where wrike_user_id = member;
  exception when others then ok := sqlerrm like 'Debug Pull and Administration%'; end;
  r := r || jsonb_build_object('06_member_cant_make_self_admin', ok);
  ok := false;
  begin update profiles set can_debug_pull = true where wrike_user_id = member;
  exception when others then ok := sqlerrm like 'Debug Pull and Administration%'; end;
  r := r || jsonb_build_object('07_member_cant_grant_self_debug_pull', ok);

  -- As someone signing in for the first time.
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'user_metadata', jsonb_build_object('wrike_user_id', 'ZZ_REHEARSAL'))::text, true);
  insert into profiles (wrike_user_id) values ('ZZ_REHEARSAL');
  r := r || jsonb_build_object('08_new_person_can_create_own_profile', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'user_metadata', jsonb_build_object('wrike_user_id', 'ZZ_REHEARSAL2'))::text, true);
  ok := false;
  begin insert into profiles (wrike_user_id, is_admin) values ('ZZ_REHEARSAL2', true);
  exception when others then ok := sqlerrm like 'Debug Pull and Administration%'; end;
  r := r || jsonb_build_object('09_new_profile_cant_start_as_admin', ok);

  -- As an administrator.
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'user_metadata', jsonb_build_object('wrike_user_id', admin_id))::text, true);
  r := r || jsonb_build_object('10_admin_is_admin', caller_is_admin());
  update profiles set department = department where wrike_user_id = other;
  get diagnostics n = row_count;
  r := r || jsonb_build_object('11_admin_edits_others', n = 1);
  update profiles set is_admin = true, can_debug_pull = true where wrike_user_id = other;
  get diagnostics n = row_count;
  r := r || jsonb_build_object('12_admin_grants_access', n = 1);
  update profiles set is_admin = false where wrike_user_id <> admin_id and is_admin;
  get diagnostics n = row_count;
  r := r || jsonb_build_object('13_admin_removes_other_admins', n = 3);
  ok := false;
  begin update profiles set is_admin = false where wrike_user_id = admin_id;
  exception when others then ok := sqlerrm like 'At least one administrator%'; end;
  r := r || jsonb_build_object('14_last_admin_stays', ok);
  ok := false;
  begin update profiles set left_at = now() where wrike_user_id = admin_id;
  exception when others then ok := sqlerrm like 'At least one administrator%'; end;
  r := r || jsonb_build_object('15_last_admin_cant_be_marked_left', ok);

  -- A former administrator who has left loses access.
  perform set_config('role', 'postgres', true);
  update profiles set is_admin = true where wrike_user_id = other;
  update profiles set left_at = now() where wrike_user_id = other;
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'user_metadata', jsonb_build_object('wrike_user_id', other))::text, true);
  r := r || jsonb_build_object('16_leaver_is_not_admin', not caller_is_admin());

  raise exception 'REHEARSAL RESULTS (all should be true): %', r;
end
$t$;
