-- End of Campaign notes go from one shared note per campaign to one note per
-- person per campaign.
--
-- The single shared note was a blank page with everyone's name implicitly on
-- it, which is nobody's — the first person to write set the tone and the rest
-- edited around them, or didn't write at all. A box each is a lower bar: you
-- add your own take without editing over anyone.
--
-- Existing notes are kept as-is under author_id = '' and render as a team note
-- alongside the individual ones, so nothing anyone already wrote is lost or
-- silently reattributed to whoever happens to open the page next.
--
-- author_id holds a wrike_user_id (text), matching profiles.wrike_user_id —
-- the id this app already identifies people by everywhere else.

-- Must run as one transaction: between dropping the old key and adding the new
-- one the table has no uniqueness guarantee, and a write landing in that gap
-- could leave a duplicate the new key then refuses to build over. No explicit
-- begin/commit here — the migration runner already wraps each file in a
-- transaction, and nesting one inside it commits the outer transaction early.

alter table public.campaign_eoc_notes
  add column if not exists author_id text not null default '';

-- The primary key has to widen with it: (campaign, department) allowed exactly
-- one row, which is the thing being changed.
alter table public.campaign_eoc_notes
  drop constraint if exists campaign_eoc_notes_pkey;

alter table public.campaign_eoc_notes
  add constraint campaign_eoc_notes_pkey
  primary key (campaign_id, department, author_id);

-- Every read is "all notes for this campaign+department", ordered by who wrote
-- them; the PK's leading columns already serve that, so no extra index.

comment on column public.campaign_eoc_notes.author_id is
  'profiles.wrike_user_id of the person who wrote this note. Empty string = the legacy shared team note that predates per-member notes.';
