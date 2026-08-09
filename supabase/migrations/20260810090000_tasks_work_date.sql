-- A real date beside the text one.
--
-- tasks.date is TEXT carrying two shapes at once — "2026-01-05" from the CSV
-- importer, "09/08/2026" from everything written in the app — so the database
-- cannot compare them. Text sorting fails twice over: within the UK shape it
-- orders by day-of-month ("30/06/2026" sorts after "01/07/2026"), and across
-- the two shapes '0' precedes '2' so every slash date sorts before every ISO
-- one. Asking for July 2026 with a text range returns 0 rows; the real answer
-- is 247.
--
-- Added alongside rather than converted in place. An in-place cast would use
-- Postgres's DateStyle, which is MDY by default, and silently reinterpret
-- "09/08/2026" as 8 September — 263 rows are ambiguous enough for that to pass
-- unnoticed. Both branches below name their format explicitly.
--
-- DAY FIRST is verified, not assumed: 234 of the 497 slash rows have a first
-- component above 12, and zero rows would be valid read month-first.
--
-- Nothing reads this column yet. Writers start filling it in the next commit,
-- readers move over after that, and the text column is retired last.

alter table public.tasks add column if not exists work_date date;

update public.tasks
   set work_date = case
         when date ~ '^\d{4}-\d{2}-\d{2}$'     then date::date
         when date ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(date, 'DD/MM/YYYY')
       end
 where work_date is null
   and date is not null
   and trim(date) <> '';

comment on column public.tasks.work_date is
  'The day the work happened. Authoritative; tasks.date is the legacy text form kept for older clients.';
