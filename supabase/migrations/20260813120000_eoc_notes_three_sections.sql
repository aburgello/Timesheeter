-- End of Campaign notes go from one free page per person to three prompted
-- sections, matching the debrief format the studio now runs to:
--
--   Positives              What worked well? Any specific shout outs?
--   Negatives & Solutions  What didn't work well? What solution do you propose?
--   Additional Improvements Do you have additional solutions or improvements?
--
-- The point is EXTRACTION. A free page per person can only be read one person
-- at a time; three known fields can be pulled out and regrouped -- every
-- Positive from the whole team together, say -- which is how the debrief is
-- actually run. Structure enforced by the schema rather than by everyone
-- remembering to type the same three headings.
--
-- Same storage shape as `content`: a JSON-stringified TipTap document in a text
-- column, parsed at the call site. Not jsonb -- the app never queries inside
-- these, and matching `content` keeps one serialisation story for the editor.

alter table public.campaign_eoc_notes
  add column if not exists positives text;

alter table public.campaign_eoc_notes
  add column if not exists negatives text;

alter table public.campaign_eoc_notes
  add column if not exists improvements text;

-- `content` IS DELIBERATELY LEFT IN PLACE AND UNTOUCHED.
--
-- The app stops rendering it: a write-up is now the three sections, and the old
-- free page is not shown anywhere. But it is not dropped and not migrated into
-- one of the new columns either -- an old note is a paragraph about the whole
-- campaign, and silently filing it under "Positives" would put words in
-- somebody's mouth. Every past write-up therefore survives verbatim and can be
-- read (or restored to the UI) any time; it is invisible, not gone.
comment on column public.campaign_eoc_notes.content is
  'LEGACY free-form note, superseded by positives/negatives/improvements and no longer rendered by the app. Kept verbatim so past write-ups are never lost; see migrations/20260813120000_eoc_notes_three_sections.sql.';

comment on column public.campaign_eoc_notes.positives is
  'TipTap JSON. "What worked well? Any specific shout outs?"';

comment on column public.campaign_eoc_notes.negatives is
  'TipTap JSON. "What didn''t work well? What solution do you propose?"';

comment on column public.campaign_eoc_notes.improvements is
  'TipTap JSON. "Do you have additional solutions or improvements to highlight?"';
