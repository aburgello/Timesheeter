-- "_Multiple_" is now "Multiple (Title/Launch)", the company timesheet site's
-- own name for it (constants.js, TERRITORIES).
--
-- The app doesn't need this to have run: it reads the old name as the new one
-- (LEGACY_TERRITORY_NAMES). This brings the stored rows into line so the table
-- says what the screen says. Apply it after the code is live, not before: the
-- older code doesn't know the new name.
--
-- Re-runnable: nothing matches the second time.

update public.tasks
  set territory = replace(territory, '_Multiple_', 'Multiple (Title/Launch)')
  where position('_Multiple_' in territory) > 0;

update public.country_aliases
  set territory = 'Multiple (Title/Launch)'
  where territory = '_Multiple_';

-- name is unique, so step aside if someone has already added the new one.
update public.translation_countries
  set name = 'Multiple (Title/Launch)'
  where name = '_Multiple_'
    and not exists (
      select 1 from public.translation_countries where name = 'Multiple (Title/Launch)'
    );
