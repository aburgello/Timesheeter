-- Follow-ups after applying the rates migration against the live schema.
--
-- 1. The asset-management categories were meant to bill at an "Asset Manager"
--    rate; no such position exists, so they point at Junior Asset Manager.
--    (Watermarking is deliberately left unmapped — it bills at the logger's
--    own position until someone sets it in Administration → Rates.)
--
-- 2. profiles_write only ever matched the caller's own row, so editing anyone
--    else's department or position in People silently did nothing, and the
--    Sync-from-Wrike upsert could only ever write the syncing user's row.
--    Management ids get write access on top of the existing self-write, which
--    must stay: it's the path that stamps wrike_user_id at first login.

update public.job_categories c
   set rate_position_id = p.id
  from public.positions p
 where lower(p.title) = 'junior asset manager'
   and c.name in (
     'Digital - Approval Site Management/Maintenance',
     'Digital - Upload/Downloading',
     'Print - Upload/Downloading'
   );

-- Keep this id list in step with MANAGEMENT_IDS in src/lib/access.js — the app
-- gates the Administration UI on that list, this gates the writes behind it.
drop policy if exists "profiles_write" on public.profiles;
create policy "profiles_write" on public.profiles
  as permissive for all to authenticated
  using (
    wrike_user_id = ((auth.jwt() -> 'user_metadata'::text) ->> 'wrike_user_id'::text)
    or ((auth.jwt() -> 'user_metadata'::text) ->> 'wrike_user_id'::text)
       in ('KUAWDLVN', 'KUAQT4JC')
  )
  with check (
    wrike_user_id = ((auth.jwt() -> 'user_metadata'::text) ->> 'wrike_user_id'::text)
    or ((auth.jwt() -> 'user_metadata'::text) ->> 'wrike_user_id'::text)
       in ('KUAWDLVN', 'KUAQT4JC')
  );
