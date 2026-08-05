-- Editable country aliases (Administration → Translation Countries).
--
-- An overlay on the ~500 aliases hardcoded in constants.js, not a replacement:
-- REGION_ALIASES and MAGI_MARKET_CODES stay the built-in baseline so the
-- resolver works with no fetch and MAGI's sheet stays a verbatim copy that can
-- be re-diffed against theirs. Rows here are added on top, and win where they
-- collide — which is what makes them useful as corrections.
--
-- The unique index is on the NORMALISED alias, matching codeKey() in
-- countryCodes.js exactly (uppercased, everything but A-Z0-9 stripped). An
-- alias is a lookup key, so two rows normalising to the same key would make
-- resolution depend on row order — "BE-FL" and "befl" are the same key and the
-- second one has to be rejected at write time rather than silently shadow the
-- first.

create table if not exists public.country_aliases (
  id bigint generated always as identity primary key,
  alias text not null,
  territory text not null,
  created_at timestamp with time zone default now()
);

create unique index if not exists country_aliases_norm_key
  on public.country_aliases (upper(regexp_replace(alias, '[^A-Za-z0-9]', '', 'g')));

create index if not exists country_aliases_territory_idx
  on public.country_aliases (territory);

alter table public.country_aliases enable row level security;

-- Same policy shape as the other reference tables in this schema.
create policy "auth_all" on public.country_aliases
  as permissive for all to public using (true) with check (true);
