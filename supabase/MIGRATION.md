# Migrating off Supabase to Google Cloud

This documents how to move Timesheeter off hosted Supabase (project
`oozopadfrupwujsagagn`) onto **Google Cloud SQL for PostgreSQL**, and — more
importantly — what that actually entails.

> **Read this first.** Supabase is not "a Postgres database." It's Postgres
> *plus* a bundle of managed services the app leans on directly from the
> browser: **Auth**, **Realtime**, **Storage**, and an **auto-generated data
> API** (PostgREST) enforced by **row-level security**. Moving the *data* to a
> Google database is the easy 20%. Replacing those four services is the other
> 80%, and it touches ~150 call sites across 21 frontend files. Budget for a
> re-platform, not a database export.
>
> If your goal is just to *stop paying hosted Supabase* (cost/egress) rather
> than to *adopt native Google services*, skip to
> [The cheaper alternative](#the-cheaper-alternative-self-host-supabase-on-gcp)
> before committing to any of this.

The prior version of this file covered an intra-Supabase org transfer (to reset
an egress overage); that approach is preserved in git history.

---

## What the app uses Supabase for

| Capability | How the app uses it | Google replacement | Rework |
|---|---|---|---|
| **Postgres** | 28 tables, RLS, 2 `pg_cron` jobs, `pgcrypto`/`uuid-ossp` | **Cloud SQL for PostgreSQL** (or AlloyDB) | Low — schema ports almost as-is |
| **Auth** | Anonymous session (`signInAnonymously`) stamped with `wrike_user_id` in `user_metadata`; RLS reads it via `auth.jwt()` | Worker-minted session JWT (identity is really Wrike OAuth) | Medium |
| **Data API** (PostgREST) | `supabase.from(...)` directly from the browser, ~148 calls | Route all reads/writes through the Cloudflare Worker | **High** |
| **Realtime** | `.channel()` — Postgres Changes (`board_now`, `tasks`, `wrike_webhook_events`, canvas notes) + Broadcast (Yjs docs, presence) | **Cloudflare Durable Objects** (already on Workers) or Pub/Sub + Cloud Run | **High** |
| **Storage** | `supabase.storage` buckets `dooh-specs`, `notes-images` (23 objects) | **Google Cloud Storage** | Medium |
| **Vault** (`supabase_vault`) | Present; secrets also in `wrike_oauth_tokens` / `wrike_webhook_config` | GCP Secret Manager, or keep in a table | Low |

**Compute stays on Cloudflare.** The Worker doesn't move — it just changes how
it reaches the database (a Postgres driver over Cloudflare **Hyperdrive**
instead of the Supabase REST client). You do *not* need Cloud Run unless you
choose it for the Realtime service.

---

## Target: Cloud SQL for PostgreSQL

Chosen because it's the closest thing to what's already running, so the schema,
RLS, extensions, and `pg_cron` jobs port with minimal change.

- **Cloud SQL for PostgreSQL 15+** — the default. Supports `pg_cron`,
  `pgcrypto`, `uuid-ossp` (enable via the `cloudsql.enable_pg_cron` flag +
  `CREATE EXTENSION`). Right-sized and cheapest for this workload.
- **AlloyDB for PostgreSQL** — the scale-up alternative (also
  Postgres-compatible, also supports `pg_cron`). Overkill and pricier for
  ~28 small tables; pick it only if analytics load grows.
- **Not Spanner / Firestore / Bigtable.** They aren't Postgres — RLS, the
  extensions, `pg_cron`, and the SQL in `schema.sql` would all have to be
  rebuilt. That defeats the point of a low-friction DB move.

`supabase_vault` and the `auth`/`storage` internal schemas are Supabase-managed
and do **not** exist on Cloud SQL; nothing in `schema.sql` recreates them (it's
scoped to `public` + bucket metadata), so the schema load is unaffected.

---

## What's in this folder

| File | Contents |
|------|----------|
| `schema.sql` | Full `public`-schema baseline: tables, constraints, indexes, functions, triggers, RLS + policies, storage-bucket *metadata*, sequence positions. Portable to any Postgres 15+. |
| `seed_data.sql` | Non-sensitive data: `tasks` (274 rows) + `canvas_notes_pages` (13 rows). |
| `migrations/` | Incremental change scripts (realtime publication + `pg_cron` jobs live here — see `migrations/README.md`). |

**Never committed (move separately, never via git):** secrets
(`wrike_oauth_tokens`, `wrike_webhook_config.secret`), the 23 storage objects,
and regenerable data (`wrike_webhook_events`, `wrike_tasks_cache`).

---

## Migration plan

### Phase 0 — Provision
1. Create a Cloud SQL for PostgreSQL 15 instance (region near your Workers, e.g.
   `europe-west2`). Note the connection name, public IP, and set a strong
   `postgres` password.
2. Set the `cloudsql.enable_pg_cron` flag **on the instance** (required before
   the extension will install).
3. Create the database and a least-privilege app role.

### Phase 1 — Move the data  *(the easy part)*
Two options:

- **Reviewable baseline** (what's in this folder):
  ```bash
  psql "<CLOUD_SQL_CONN>" -f supabase/schema.sql       # before seed_data.sql
  psql "<CLOUD_SQL_CONN>" -f supabase/seed_data.sql
  psql "<CLOUD_SQL_CONN>" -c "create extension if not exists pg_cron;"
  # then re-run the ALTER PUBLICATION / cron.schedule bits from migrations/
  # (see migrations/README.md) — but see Phase 4 on whether you still need them
  ```
- **Full-fidelity dump** (all data + sequences, no hand-assembly):
  ```bash
  supabase db dump --db-url "<SOURCE_CONN>" -f dump.sql   # or pg_dump
  psql "<CLOUD_SQL_CONN>" -f dump.sql
  ```
  Strip any `auth.*` / `storage.*` / `supabase_*` references the dump carries —
  those schemas don't exist on Cloud SQL. `pg_dump --schema=public` avoids most.

Verify: row counts for `tasks` (274) and `canvas_notes_pages` (13) match.

### Phase 2 — Reconnect the Worker
- Provision **Cloudflare Hyperdrive** pointing at the Cloud SQL public IP
  (add Cloudflare egress ranges, or your VPC connector, to Cloud SQL authorized
  networks; use SSL). Hyperdrive pools connections so the Worker isn't opening a
  fresh TCP+TLS handshake per request.
- In the Worker, replace Supabase service-role REST calls with a Postgres client
  (`postgres`/`pg`) over the Hyperdrive binding.
- `wrangler.jsonc`: drop `SUPABASE_URL`; add the Hyperdrive binding. Replace the
  `SUPABASE_SERVICE_ROLE_KEY` secret with the DB connection string
  (`wrangler secret put DATABASE_URL`).

### Phase 3 — Replace the browser data API  *(the big one)*
The frontend currently calls `supabase.from(...)` directly (~148 sites). Cloud
SQL has no PostgREST, and you do not want to expose Postgres to the browser.
**Route every read/write through the Worker:**
- Add Worker HTTP endpoints (or one RPC endpoint) for the queries the frontend
  makes, and swap `supabase.from(...)` for `fetch()` calls to them.
- Centralize this behind a small client module so it's one shape to change, not
  148. `src/lib/supabaseClient.js` becomes the seam to replace.

### Phase 4 — Replace Auth + RLS
Today: an **anonymous** Supabase session carries `wrike_user_id` in its JWT, and
two RLS policies (`profiles_write`, `tasks` isolation) enforce per-user access
via `auth.jwt()`. Once all traffic flows through the Worker (Phase 3), the
browser no longer holds a DB credential, so:
- The **Worker** verifies the Wrike identity (it already manages Wrike OAuth in
  `wrike_oauth_tokens`) and is the sole thing talking to Postgres.
- **Enforce access in the Worker** — it knows the caller's `wrike_user_id` and
  adds the `where wrike_user_id = $1` filters the RLS policies used to. This is
  the simpler path and RLS becomes redundant.
- *If you want defense-in-depth RLS at the DB too:* keep the policies but
  replace `auth.jwt()` with a shim that reads a per-transaction GUC, and have
  the Worker `SET LOCAL app.wrike_user_id = ...` on each connection checkout.

### Phase 5 — Replace Realtime  *(the other big one)*
Supabase Realtime is doing two distinct jobs; both need a home:
- **Postgres Changes** (live `board_now` dots, canvas notes, task updates):
  the Worker already mediates writes after Phase 3, so have it **publish to a
  Cloudflare Durable Object** that fans out over WebSocket to subscribed
  browsers. No DB log-tailing needed.
- **Broadcast** (Yjs collaborative docs + presence, in
  `src/lib/yjsSupabaseProvider.js`): repoint the provider's transport from
  `supabase.channel(...)` broadcast to a **Durable Object** WebSocket room.
  The Yjs protocol (`sync`/`update`/`aware`) is transport-agnostic — only the
  send/subscribe plumbing changes.
- Alternative if you'd rather not use DOs: **Google Pub/Sub** + a small
  WebSocket relay on **Cloud Run**. More moving parts than DOs for an app
  already on Workers.

Mind the egress lesson that started all this: throttle awareness/broadcast
traffic exactly as the current provider already does.

### Phase 6 — Replace Storage
- Create two **GCS buckets** mirroring `dooh-specs` and `notes-images`.
- Copy the 23 objects: `gsutil rsync` from local, or download-from-Supabase →
  upload-to-GCS with a short script.
- Swap `supabase.storage.from(bucket)` calls (`upload`/`remove`/`download`/
  `getPublicUrl`) for GCS — either public-object URLs (both buckets are public
  today) or Worker-issued signed URLs. Re-point `dooh_assets.storage_path` /
  `.url` values.

### Phase 7 — Cron
`pg_cron` carries over. After `create extension pg_cron`, re-create the two jobs
(`migrations/` has the SQL):
- `purge-wrike-webhook-events` — `17 3 * * *`
- `board_now_cleanup` — `0 * * * *`

### Phase 8 — Cutover & verify
1. Freeze writes on Supabase; take a final dump; load to Cloud SQL.
2. Deploy the reworked Worker + frontend.
3. Verify end to end:
   - Wrike OAuth sign-in issues a session and per-user data scoping holds.
   - Timesheet read/write works (Phase 3/4 path).
   - `board_now` dots and canvas notes update live across two browsers
     (Phase 5), and the `board_now_cleanup` cron still prunes.
   - DOOH asset images and note images load from GCS (Phase 6).
4. Keep Supabase in read-only standby for a rollback window before deleting.

---

## The cheaper alternative: self-host Supabase on GCP

If the motivation is leaving *hosted* Supabase — not adopting native Google
services — then **run the open-source Supabase stack on Google infrastructure**
instead of doing Phases 3–6:

- Deploy the Supabase Docker stack (GoTrue, PostgREST, Realtime, Storage,
  Kong) on **GKE** or a **Compute Engine** VM, backed by **Cloud SQL for
  PostgreSQL** as the database.
- The frontend keeps using `supabase-js` unchanged — you only swap the URL and
  keys. Auth, Realtime, Storage, RLS, and the data API all keep working.
- Trade-off: you now operate that stack (upgrades, scaling, backups) yourself,
  versus Supabase managing it. But it's days of work, not the multi-week
  re-platform above, and there are **zero** frontend code changes.

Choose the full Cloud SQL re-platform only if standardizing on native Google
services (or shedding the Supabase runtime entirely) is itself the goal.

---

## Effort summary

| Phase | Effort | Risk |
|---|---|---|
| 1 · Data → Cloud SQL | Low | Low |
| 2 · Worker ↔ Hyperdrive | Low–Med | Low |
| 3 · Browser data API → Worker | **High** (~148 sites) | Med |
| 4 · Auth + RLS | Med | Med |
| 5 · Realtime → Durable Objects | **High** | Med–High |
| 6 · Storage → GCS | Med | Low |
| 7 · Cron | Low | Low |
| **Self-host alternative** | **Low–Med** | Low (no app changes) |
