# Migrating the Supabase project to a new organization

This documents how to move the Timesheeter database off the current
organization (**xyi**, project `oozopadfrupwujsagagn`) and onto a new
organization in the same Supabase account, and why.

## Why we're doing this

A fetching bug pushed the **xyi** org over the Free-plan **egress** limit. Egress
is metered per *organization, per billing cycle*, so the fix (already shipped)
stops the bleed going forward, but the current cycle's overage on **xyi** still
has to roll off (~1 week). Moving the project to a fresh org gives it a clean
egress meter immediately.

> **Does moving reset egress?** For the project's *future* usage, yes — after the
> move, all its egress counts against the **new** org's clean meter (Supabase
> bills the source org for usage up to the transfer, the target org after it). It
> does **not** erase the old **xyi** overage, which expires on its own.

## What's in this folder

| File | Contents |
|------|----------|
| `schema.sql` | Full schema: 27 tables, 44 constraints, 7 indexes, 2 functions, 2 triggers, 27 RLS-enabled tables + 26 policies, 2 storage buckets, sequence positions. |
| `seed_data.sql` | Non-sensitive data: `tasks` (274 rows) + `canvas_notes_pages` (13 rows). |

**Deliberately NOT committed (never put in git):**

- **Secrets** — `wrike_oauth_tokens` (access/refresh/session tokens) and
  `wrike_webhook_config.secret`. These move with a transfer automatically; for a
  recreate, see "Handling secrets" below.
- **Storage objects** — the 23 binary files in the `dooh-specs` (17) and
  `notes-images` (6) buckets. Bucket *definitions* are in `schema.sql`; the files
  are copied separately.
- **Regenerable data** — `wrike_webhook_events` (event log) and
  `wrike_tasks_cache` (repopulates on next Wrike sync).

---

## Option A — Native project transfer  ✅ recommended

Supabase supports self-serve project transfer between organizations you own. It
moves the **entire** project — data, storage objects, edge config, **and keeps
the same project ref, URL, and API keys**.

**Why it's the best option here:**

- **Zero code changes.** `wrangler.jsonc` (`SUPABASE_URL`) and the Worker secret
  `SUPABASE_SERVICE_ROLE_KEY` stay valid. No redeploy, no Wrike redirect-URI edit.
- **No data copy → no egress** is spent doing the migration.
- Storage objects and secrets come along automatically.

**Steps (Supabase dashboard — this is a UI-only action):**

1. Make sure the destination org already exists in your account (it does).
2. Open the **source** project → **Project Settings → General → Transfer project**.
3. Pick the destination org as the target, confirm.
4. Wait for it to complete (brief downtime possible), then verify (below).

**Caveat to check first:** while **xyi** is under the Fair-Use restriction from
the egress overage, Supabase may disable transfers (HTTP 402). Right now the
project reads `ACTIVE_HEALTHY` and is queryable, so you're likely in a soft/grace
state where the transfer works — **just try it**. If it's blocked, either wait
for the overage to roll off (~1 week) and transfer then, or use Option B.

> The empty project you pre-created in the new org isn't needed for a transfer —
> the transfer moves the existing project in. You can delete that empty one
> afterward (Free orgs cap at 2 active projects).

---

## Option B — Recreate in a new project  (fallback if transfer is blocked)

Use this only if the transfer can't be initiated. Trade-offs: the new project has
a **different ref → different URL**, so the Worker must be re-pointed and
redeployed, and storage + secrets are moved by hand.

### B1. Create the target project
In the new org, create a project (or use the empty one you already made). Note
its **ref**, **Project URL**, **service_role key**, and **anon/publishable key**.

### B2. Load schema + data
From your Mac with the [Supabase CLI](https://supabase.com/docs/guides/local-development)
or `psql` (get the connection string from **Project Settings → Database**):

```bash
psql "<TARGET_DB_CONNECTION_STRING>" -f supabase/schema.sql
psql "<TARGET_DB_CONNECTION_STRING>" -f supabase/seed_data.sql
```

`schema.sql` must run **before** `seed_data.sql`. Both are wrapped in
transactions, so a failure rolls back cleanly.

### B3. Handling secrets (`wrike_oauth_tokens`)
These are OAuth tokens — pick one:

- **Simplest: don't migrate them.** Users just sign in through Wrike again on the
  new deployment; fresh tokens get written. No secret handling at all.
- **Preserve sessions:** copy the table directly DB-to-DB (never via git):
  ```bash
  pg_dump "<SOURCE_DB_CONNECTION_STRING>" \
    --data-only --table=public.wrike_oauth_tokens \
    | psql "<TARGET_DB_CONNECTION_STRING>"
  ```
  (If the webhook is in use, do the same for `public.wrike_webhook_config`.)

### B4. Migrate storage objects (23 files)
Bucket definitions are already created by `schema.sql`. Copy the files with the
Supabase CLI or a short script using the JS/Python client:
list each bucket on the source, download, upload to the same bucket id on the
target. Buckets: `dooh-specs`, `notes-images` (both public). Then confirm the
`dooh_assets.storage_path` / `dooh_assets.url` values still resolve.

### B5. Re-point the Worker
- `wrangler.jsonc` → set `SUPABASE_URL` to the new project URL.
- Rotate the Worker secret:
  ```bash
  npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY   # paste the new key
  ```
- Redeploy: `npm run deploy`.
- Wrike redirect URI is unchanged (same domain), so no Wrike app edits.

---

## Full-fidelity alternative (either option)

For a byte-perfect dump that includes everything (all data, secrets, sequences)
without hand-assembly, run from your Mac:

```bash
supabase db dump --db-url "<SOURCE_DB_CONNECTION_STRING>" -f full_dump.sql
# schema only: add --schema-only ; data only: --data-only
```

The committed `schema.sql` / `seed_data.sql` here are the reviewable, secret-free
baseline (and the schema baseline the repo previously lacked); a live
`supabase db dump` is the option when you want an exact copy including secrets.

---

## Post-migration verification (both options)

1. Row counts on the target match the source for `tasks` (274) and
   `canvas_notes_pages` (13); storage buckets list 17 + 6 objects.
2. Sign in through Wrike OAuth end-to-end on the deployed app.
3. Timesheet read/write works (exercises `tasks` RLS with the JWT
   `wrike_user_id`), and DOOH asset images load (storage).
4. Confirm the app points at the intended project (Option A: unchanged URL;
   Option B: new URL in `wrangler.jsonc` + deployed).
