-- Enforce one Job Book row per XY code.
--
-- jobs_job_number_key is UNIQUE (job_number) — it guards the LABEL. But the
-- code is what identifies a job; the rest of the string is description, and one
-- job is legitimately written several ways by different parts of the app:
--
--     XY014384
--     XYi Design House Job : XY014384, Showreel
--
--     Shrek 5 : XY023362, Titles
--     Shrek 5 : XY023362, INT - Titles          (folder scan adds the region)
--
-- Those are different strings, so the label constraint filed both. That is
-- where the 13 duplicate pairs cleaned up on 9 Aug 2026 came from, and where
-- the 53 bare-code stubs come from: ensureJob writes "XY025091" the first time
-- a code is seen, and a canonical row for the same job never blocked it.
--
-- More seriously, the label constraint cannot catch the allocation race.
-- nextJobCode() reads the highest code in use and adds one, with nothing
-- reserving it in between, so two people activating slots at the same moment
-- both get XY026048. Under different film names those are different strings
-- and BOTH save cleanly — two unrelated jobs sharing one number, silently.
--
-- Indexing the extracted code closes all three. substring(text from text) is
-- IMMUTABLE, so it is indexable. Rows carrying no code index as NULL and
-- Postgres treats NULLs as distinct, so free-text internal jobs are unaffected
-- (there are none today; this keeps the door open for them).
--
-- The existing label constraint stays. It still stops two rows sharing a
-- string, which matters for any future row without a code.
--
-- Verified clean before creating: 949 rows, 949 distinct codes, 0 without a
-- code. The index will refuse to build if that ever stops being true, which is
-- the right failure — it means duplicates were reintroduced.
--
-- The application already cooperates:
--   • useJobLookup.ensureJob ignores 23505, so it simply stops writing a stub
--     beside a canonical row.
--   • createDraftJob retries with a freshly allocated code on 23505, so the
--     allocation race becomes self-healing rather than silently corrupting.
--   • The CSV importer (worker/index.js) and the Job Book editor were changed
--     alongside this migration to match on the code and to surface 23505.

create unique index if not exists jobs_job_code_key
  on public.jobs ((substring(job_number from 'XY\d{5,6}')));

comment on index public.jobs_job_code_key is
  'One row per XY code. jobs_job_number_key guards the label; this guards the identity.';
