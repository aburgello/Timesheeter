# Incremental migrations

`../schema.sql` is the consolidated, byte-reviewable **baseline** — apply it to a
fresh Postgres to reproduce the full current schema (tables, constraints,
functions, triggers, RLS, policies, storage-bucket metadata). It's the schema
load in Phase 1 of `../MIGRATION.md`.

The files here are **incremental change scripts**, each named
`<version>_<name>.sql` to match the version recorded in the project's Supabase
migration ledger (`supabase_migrations.schema_migrations`). They document *how*
the live database changed over time, in apply order.

Two things `schema.sql` deliberately leaves out, so they live **only** here:

- **Realtime publication membership** — `alter publication supabase_realtime
  add table …`. This is Supabase Realtime-specific; on a non-Supabase target
  (see `../MIGRATION.md`) realtime is rebuilt a different way and these
  statements are simply skipped.
- **`pg_cron` jobs** — e.g. `board_now_cleanup`. `pg_cron` isn't enabled by
  default on a fresh project (Supabase *or* Cloud SQL), so running it from
  `schema.sql` would break the rebuild.

**Applying these after `schema.sql`:** once the extension exists
(`create extension pg_cron;`), re-run the `cron.schedule(…)` statements from the
files here. The `alter publication …` lines apply only if the target still uses
Supabase Realtime — a native Supabase **project transfer** carries both across
automatically; a Cloud SQL / AlloyDB move drops the publication lines and
rebuilds realtime per `../MIGRATION.md` Phase 5.

> Historical note: only the `board_now` migrations are captured as files so far.
> Earlier changes were folded straight into `schema.sql`; this folder was
> started when the working-now feature landed.
