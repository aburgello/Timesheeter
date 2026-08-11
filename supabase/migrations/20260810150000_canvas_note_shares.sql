-- Share an individual note or sketch with named teammates.
--
-- This is a VISIBILITY feature, not an access-control one. canvas_notes_pages
-- already carries a permissive "anon all" policy (ALL / authenticated /
-- true), so every logged-in member can already read and write every page
-- through the API. A share row does not grant access that didn't exist; it
-- puts the page in someone's "Shared with me" list so they know to look at
-- it. Anything genuinely confidential needs the page policies tightened
-- first — this table would then be the natural thing to key them on.
create table if not exists public.canvas_note_shares (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references public.canvas_notes_pages(id) on delete cascade,
  -- Wrike ids, matching profiles.wrike_user_id and
  -- canvas_notes_folders.owner_wrike_id. Not FKs: profiles is synced from
  -- Wrike and a person can leave, and a dangling share should not block the
  -- sync or delete the page's history.
  shared_with_wrike_id text not null,
  shared_by_wrike_id text,
  created_at timestamptz default now(),
  -- Sharing the same page to the same person twice is the same share, so the
  -- UI can upsert without first checking.
  unique (page_id, shared_with_wrike_id)
);

-- The read every session makes: "what has been shared with me".
create index if not exists canvas_note_shares_shared_with_idx
  on public.canvas_note_shares (shared_with_wrike_id);

alter table public.canvas_note_shares enable row level security;

-- Matches the convention the neighbouring canvas tables already use.
drop policy if exists "auth_all" on public.canvas_note_shares;
create policy "auth_all" on public.canvas_note_shares
  as permissive for all to authenticated using (true) with check (true);
