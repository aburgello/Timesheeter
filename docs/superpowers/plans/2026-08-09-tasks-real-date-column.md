# Real Date Column for `tasks` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Give `tasks` a real `date` column so the database can filter, sort and group by date, and delete the six hand-written date parsers scattered across the app.

**Architecture:** Expand-then-contract. Add a new `work_date date` column beside the existing `date` text column, backfill it from both stored formats, teach every writer to fill both, move readers onto the new column one at a time, and only then retire the text column. Nothing reads the new column until it is fully populated, so every step before the last is reversible by ignoring it.

**Tech Stack:** React 18, Supabase (PostgREST + Postgres 17), Cloudflare Worker, Vite. No test runner exists in this repo; Task 1 adds a minimal esbuild+node harness rather than a new dependency (esbuild already ships inside Vite).


> **Status: Tasks 1-6 applied on 2026-08-09.** Migrations `tasks_work_date`
> and `tasks_work_date_index` are live on `oozopadfrupwujsagagn`; backfill
> verified (2729 filled / 2 blank / 0 mismatches). Task 7 remains open and
> must not be started until the soak query below returns 0.

## Global Constraints

- **Dates are DAY-FIRST.** `09/08/2026` is 9 August 2026. Verified against production: 234 of 497 slash-format rows have a first component greater than 12, and **zero** rows would be invalid read month-first.
- **Never let Postgres cast the text column implicitly.** Its default `DateStyle` is MDY, so `09/08/2026` would silently become 8 September. Every conversion must name the format explicitly: `to_date(date, 'DD/MM/YYYY')`.
- **Local time, never UTC.** `new Date().toISOString()` yields a UTC date and shifts the day west of Greenwich. Format from `getFullYear()`/`getMonth()`/`getDate()`.
- **The text `date` column keeps being written** until Task 7. Older browser bundles will still be writing it, and the grid still displays from it.
- Production project id: `oozopadfrupwujsagagn`. Table: `public.tasks`, currently 2731 rows.
- Migrations live in `supabase/migrations/` named `YYYYMMDDHHMMSS_snake_case.sql`, and `supabase/schema.sql` is updated in the same commit.

---

## Current State

```
tasks.date  TEXT, 2731 rows
  2232   "2026-01-05"     ISO       — every one written by the CSV importer
   497   "09/08/2026"     UK        — everything written in the app
     2   ""/NULL
     0   any other shape
```

Six independent parsers convert it back:

| File | Symbol |
|---|---|
| `src/hooks/useTasks.js:141` | `toIso` |
| `src/components/LegacyTimesheets.js:222` | `toIsoDate` |
| `src/components/LegacyTimesheets.js:1841` | `parseDate` |
| `src/components/Management.jsx:4552` | `toIso` |
| `src/components/Profile.jsx:1246` | `toIsoDate` |
| `worker/index.js` | `normaliseDate` |

## File Structure

- **Create** `src/utils/dates.js` — the single date module. Pure functions only, no React, no Supabase, so it is importable by the Worker and testable in Node.
- **Create** `tests/run.mjs` — minimal test harness (bundle with esbuild, run with node).
- **Create** `tests/dates.test.mjs` — cases for the date module.
- **Create** `supabase/migrations/20260810090000_tasks_work_date.sql` — add + backfill the column.
- **Create** `supabase/migrations/20260810091000_tasks_work_date_index.sql` — index it.
- **Modify** `src/hooks/useTasks.js` — `toDb`/`fromDb` carry `work_date`; week filter reads it.
- **Modify** `src/hooks/useLegacyRows.js`, `src/hooks/useTaskActions.js`, `src/components/TaskDetailModal.jsx`, `src/components/LegacyTimesheets.js` — writers set both shapes.
- **Modify** `src/components/Management.jsx`, `src/components/Profile.jsx` — readers use the shared module.
- **Modify** `worker/index.js` — importer writes both; jobs-feed selects `work_date`.
- **Modify** `supabase/schema.sql` — reflect the new column and index.

---

### Task 1: The shared date module

**Files:**
- Create: `src/utils/dates.js`
- Create: `tests/run.mjs`
- Create: `tests/dates.test.mjs`
- Modify: `package.json` (add a `test` script)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `toIsoDate(value: string|null): string|null` — any stored shape → `"YYYY-MM-DD"`, else `null`
  - `isoToday(d?: Date): string` — a Date → `"YYYY-MM-DD"` in **local** time
  - `isoToUk(iso: string|null): string` — `"YYYY-MM-DD"` → `"DD/MM/YYYY"`, `""` when unparseable

- [x] **Step 1: Write the test harness**

Create `tests/run.mjs`:

```js
// Minimal test runner: bundle each *.test.mjs with esbuild (already present via
// Vite) so Node can resolve the app's extensionless imports, then run it.
// Deliberately not a new dependency — this repo has no test framework and one
// isn't warranted for a handful of pure functions.
import { build } from "esbuild";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let failed = 0;
const results = [];

globalThis.check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`));
};

const files = readdirSync("tests").filter((f) => f.endsWith(".test.mjs"));
for (const f of files) {
  const out = join(tmpdir(), `xyi-${f}.bundled.mjs`);
  await build({ entryPoints: [join("tests", f)], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
  await import(pathToFileURL(out).href);
}

console.log(results.join("\n"));
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
```

Add to `package.json` scripts:

```json
"test": "node tests/run.mjs"
```

- [x] **Step 2: Write the failing test**

Create `tests/dates.test.mjs`:

```js
import { toIsoDate, isoToday, isoToUk } from "../src/utils/dates.js";

// Both stored shapes normalise
check("ISO passes through",           toIsoDate("2026-01-05"), "2026-01-05");
check("UK slash is DAY first",        toIsoDate("09/08/2026"), "2026-08-09");
check("unpadded UK slash",            toIsoDate("9/8/2026"),   "2026-08-09");
check("day > 12 proves day-first",    toIsoDate("30/06/2026"), "2026-06-30");

// The ordering failures this whole change exists to fix
check("30 June sorts before 1 July",
  [toIsoDate("30/06/2026"), toIsoDate("01/07/2026")].sort(),
  ["2026-06-30", "2026-07-01"]);
check("mixed formats sort together",
  [toIsoDate("09/08/2026"), toIsoDate("2026-01-05")].sort(),
  ["2026-01-05", "2026-08-09"]);

// Absent / unusable input is null, never a guess and never today's date
check("null",        toIsoDate(null),          null);
check("empty",       toIsoDate(""),            null);
check("whitespace",  toIsoDate("   "),         null);
check("nonsense",    toIsoDate("not a date"),  null);
check("partial",     toIsoDate("2026-08"),     null);

// isoToday is LOCAL — a UTC formatter returns tomorrow for this input
check("local, not UTC", isoToday(new Date(2026, 7, 9, 23, 30)), "2026-08-09");

// Display helper
check("iso to UK",        isoToUk("2026-08-09"), "09/08/2026");
check("iso to UK, null",  isoToUk(null),         "");
```

- [x] **Step 3: Run it to make sure it fails**

Run: `npm test`
Expected: FAIL — `Could not resolve "../src/utils/dates.js"`

- [x] **Step 4: Write the module**

Create `src/utils/dates.js`:

```js
// The one place that understands what a stored task date looks like.
//
// `tasks.date` is TEXT holding two shapes at once: "2026-01-05" from the CSV
// importer and "09/08/2026" from everything written in the app. Six separate
// parsers used to convert it back, each free to drift from the others. This
// replaces all of them.
//
// DAY FIRST, always. "09/08/2026" is 9 August. Checked against production:
// 234 of 497 slash rows carry a first component above 12, and not one row
// would be valid-but-different read month-first.

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const UK_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/** Any stored shape → "YYYY-MM-DD". null when there is nothing usable. */
export function toIsoDate(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (ISO_RE.test(s)) return s;
  const uk = UK_RE.exec(s);
  if (!uk) return null;
  const [, d, m, y] = uk;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

/**
 * A Date → "YYYY-MM-DD" in LOCAL time.
 *
 * Not toISOString(): that is UTC, so an evening entry west of Greenwich lands
 * on tomorrow. The same bug was fixed in wrikeApi.logTimeToWrike.
 */
export function isoToday(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" → "DD/MM/YYYY" for display and for the legacy text column. */
export function isoToUk(iso) {
  const m = ISO_RE.exec(String(iso ?? "").trim());
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}
```

- [x] **Step 5: Run the tests and make sure they pass**

Run: `npm test`
Expected: `14/14 passed`

- [x] **Step 6: Commit**

```bash
git add src/utils/dates.js tests/ package.json
git commit -m "Add one shared date module for tasks.date, with tests"
```

---

### Task 2: Add and backfill `work_date`

**Files:**
- Create: `supabase/migrations/20260810090000_tasks_work_date.sql`
- Create: `supabase/migrations/20260810091000_tasks_work_date_index.sql`
- Modify: `supabase/schema.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `public.tasks.work_date date` — nullable, populated for every row whose `date` text is parseable.

- [x] **Step 1: Record the before-counts**

Run against project `oozopadfrupwujsagagn`:

```sql
select count(*) as total,
       count(*) filter (where date ~ '^\d{4}-\d{2}-\d{2}$')       as iso,
       count(*) filter (where date ~ '^\d{1,2}/\d{1,2}/\d{4}$')   as uk,
       count(*) filter (where date is null or trim(date) = '')     as blank
from public.tasks;
```

Expected today: `total 2731, iso 2232, uk 497, blank 2`. Write the numbers down — Step 4 checks against them.

- [x] **Step 2: Write the migration**

Create `supabase/migrations/20260810090000_tasks_work_date.sql`:

```sql
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
```

- [x] **Step 3: Apply it**

Apply as migration `tasks_work_date` to project `oozopadfrupwujsagagn`.

- [x] **Step 4: Verify the backfill against the before-counts**

```sql
select count(*)                                          as total,
       count(work_date)                                  as filled,
       count(*) filter (where work_date is null)         as unfilled,
       min(work_date) as earliest, max(work_date) as latest,
       count(*) filter (where work_date <> to_date(date,'DD/MM/YYYY')
                          and date ~ '^\d{1,2}/\d{1,2}/\d{4}$') as uk_mismatches,
       count(*) filter (where work_date <> date::date
                          and date ~ '^\d{4}-\d{2}-\d{2}$')     as iso_mismatches
from public.tasks;
```

Expected: `filled = 2729`, `unfilled = 2` (the two blank rows), `uk_mismatches = 0`, `iso_mismatches = 0`, and `latest` a real recent date rather than something in June.

**If `unfilled` is greater than the blank count, STOP.** It means a shape exists that neither branch matched. List them with `select distinct date from public.tasks where work_date is null and trim(coalesce(date,'')) <> '';` and extend the migration before going on.

- [x] **Step 5: Prove the original failure is fixed**

```sql
select count(*) as july_via_real_date
from public.tasks
where work_date between date '2026-07-01' and date '2026-07-31';
```

Expected: `247` — the number the text-column query returned 0 for.

- [x] **Step 5b: Index it**

The whole point of the column is date-range queries, so give them an index.
Create `supabase/migrations/20260810091000_tasks_work_date_index.sql`:

```sql
-- Range scans on work_date are the reason the column exists (week filters,
-- month reports, the jobs feed's date ordering). Partial: the only null rows
-- are the two blank-date ones, and they are never in a date range.
create index if not exists tasks_work_date_idx
  on public.tasks (work_date)
  where work_date is not null;
```

Apply as migration `tasks_work_date_index`.

- [x] **Step 5c: Confirm PostgREST can see the new column**

Adding a column does not always refresh PostgREST's schema cache immediately.
Until it does, any insert carrying `work_date` fails with
`PGRST204 Could not find the 'work_date' column of 'tasks' in the schema cache`
— which would break every write in Task 3.

```sql
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'tasks' and column_name = 'work_date';
```

Expected: one row, `work_date | date`. Then confirm the API layer agrees by
selecting the column through PostgREST (not just SQL) before starting Task 3.
If it 404s on the column, run `notify pgrst, 'reload schema';` and retry.

- [x] **Step 6: Update schema.sql**

In `supabase/schema.sql`, inside `create table public.tasks`, after the `date text` line:

```sql
  date text,
  -- The day the work happened. `date` above is the legacy text form — two
  -- formats in one column, uncomparable in SQL — kept only until every client
  -- has moved over. See migrations/20260810090000_tasks_work_date.sql.
  work_date date,
```

- [x] **Step 7: Commit**

```bash
git add supabase/migrations/20260810090000_tasks_work_date.sql \
        supabase/migrations/20260810091000_tasks_work_date_index.sql \
        supabase/schema.sql
git commit -m "Add tasks.work_date and backfill it from both stored formats"
```

---

### Task 3: Writers fill both columns

**Files:**
- Modify: `src/hooks/useTasks.js` (`toDb` ~line 25, `fromDb` ~line 57)
- Test: `tests/dates.test.mjs` (extend)

**Interfaces:**
- Consumes: `toIsoDate`, `isoToday` from Task 1.
- Produces: every row inserted through `useTasks` carries both `date` (text, unchanged) and `work_date` (real date). `fromDb` exposes `workDate`.

- [x] **Step 1: Write the failing test**

Append to `tests/dates.test.mjs`:

```js
import { toDbDate } from "../src/utils/dates.js";

// The value that goes into the work_date column, from whatever a caller set.
check("from UK text",      toDbDate("09/08/2026"), "2026-08-09");
check("from ISO text",     toDbDate("2026-08-09"), "2026-08-09");
check("unparseable → null", toDbDate("garbage"),   null);
check("absent → null",     toDbDate(null),         null);
```

- [x] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `toDbDate` is not exported.

- [x] **Step 3: Add `toDbDate` to the module**

In `src/utils/dates.js`:

```js
/**
 * The value for the work_date column, given whatever shape a caller set on
 * `date`. Null rather than a guess: a row whose date we cannot read should be
 * visibly undated, not silently dated today.
 */
export const toDbDate = (value) => toIsoDate(value);
```

- [x] **Step 4: Run the tests and make sure they pass**

Run: `npm test`
Expected: `18/18 passed`

- [x] **Step 5: Wire it into `toDb` and `fromDb`**

In `src/hooks/useTasks.js`, add the import:

```js
import { toDbDate } from "../utils/dates";
```

In `toDb`, beside the existing `date` line:

```js
  date: task.date ?? null,
  // Both, for now. `date` stays because older browser bundles still read it
  // and the grid still displays from it; work_date is what the database can
  // actually sort and filter on.
  work_date: toDbDate(task.date),
```

In `fromDb`, beside the existing `date` line:

```js
  date: row.date,
  workDate: row.work_date ?? null,
```

- [x] **Step 6: Verify a new row carries both**

Run: `npx vite build` — expect a clean build.

Then in the app, log one entry (Tracker → log, or Legacy → add a row) and check:

```sql
select id, source, date, work_date, created_at
from public.tasks order by created_at desc limit 3;
```

Expected: the new row has `work_date` populated and matching `date`.

- [x] **Step 7: Commit**

```bash
git add src/utils/dates.js src/hooks/useTasks.js tests/dates.test.mjs
git commit -m "Write tasks.work_date alongside the legacy text date"
```

---

### Task 4: Move `useTasks`'s week filter onto the real column

**Files:**
- Modify: `src/hooks/useTasks.js:110-159`

**Interfaces:**
- Consumes: `toIsoDate` from Task 1, `workDate` from Task 3.
- Produces: no interface change. `useTasks` still returns the same task shape.

- [x] **Step 1: Replace the local parser and the filter**

In `src/hooks/useTasks.js`, delete the inline `toIso` (lines ~141-146) and change the week filter to:

```js
        if (weekStart) {
          // work_date when the row has it, the legacy text otherwise — a row
          // written by a browser still running the old bundle has no
          // work_date until it next syncs. Drop the fallback in Task 7.
          setTasks(mapped.filter((t) => {
            const iso = t.workDate || toIsoDate(t.date);
            return iso && iso >= weekStart;
          }));
        } else {
          setTasks(mapped);
        }
```

Add to the imports at the top:

```js
import { toIsoDate } from "../utils/dates";
```

- [x] **Step 2: Verify the week view is unchanged**

Run: `npx vite build`, then open Legacy Timesheets. The current week's rows must be exactly the ones shown before this task — same count, same rows.

Cross-check the expected count:

```sql
select count(*) from public.tasks
where source = 'legacy' and work_date >= date_trunc('week', current_date)::date;
```

- [x] **Step 3: Commit**

```bash
git add src/hooks/useTasks.js
git commit -m "Filter the week from work_date, dropping useTasks' local parser"
```

---

### Task 5: Retire the remaining four readers

**Files:**
- Modify: `src/components/LegacyTimesheets.js:222` (`toIsoDate`), `:1841` (`parseDate`)
- Modify: `src/components/Management.jsx:4552` (`toIso`)
- Modify: `src/components/Profile.jsx:1246` (`toIsoDate`)

**Interfaces:**
- Consumes: `toIsoDate` from Task 1, `workDate` from Task 3.
- Produces: nothing new. Four local functions deleted.

- [x] **Step 1: LegacyTimesheets — replace both parsers**

Delete the local `toIsoDate` at line 222 and add to the imports:

```js
import { toIsoDate } from "../utils/dates";
```

At line ~1841 replace `parseDate` with:

```js
      // Recency: code -> most recent date it was logged. Sorting ISO strings
      // is the whole point of the shared parser; no Date objects needed.
      const isoOf = (r) => r.work_date || toIsoDate(r.date) || "";
```

and update its caller at ~1852:

```js
        const t = isoOf(r);
        if (!(k in recency) || t > recency[k]) recency[k] = t;
```

- [x] **Step 2: Management — replace `toIso`**

Delete the local `toIso` at line 4552, import the shared one, and change its three call sites (lines ~4569, ~4570, ~4613) to prefer the real column:

```js
      const da = a.work_date || toIsoDate(a.date) || "";
      const db = b.work_date || toIsoDate(b.date) || "";
```

```js
        _iso: t.work_date || toIsoDate(t.date),
```

- [x] **Step 3: Profile — replace `toIsoDate`**

Delete the local `toIsoDate` at line 1246, import the shared one, and change line ~1309:

```js
      const key = t.work_date || toIsoDate(t.date) || "Unknown";
```

- [x] **Step 4: Verify no local parsers remain**

Run:

```bash
grep -rn "const toIso\|function toIsoDate\|const parseDate" src/ | grep -v "src/utils/dates.js"
```

Expected: no output.

- [x] **Step 5: Verify the three screens are unchanged**

Run: `npx vite build`, then check each screen renders the same groupings as before:
- Legacy Timesheets — job dropdown order (recency-sorted) unchanged
- Administration → Jobs Feed — date sort unchanged
- Profile Hub → day groups — same days, same order, no "Unknown" group that wasn't there before

- [x] **Step 6: Commit**

```bash
git add src/components/LegacyTimesheets.js src/components/Management.jsx src/components/Profile.jsx
git commit -m "Delete the four remaining date parsers in favour of the shared one"
```

---

### Task 6: The Worker — importer and jobs feed

**Files:**
- Modify: `worker/index.js` (`normaliseDate`, `handleJobsFeedImport`, `handleJobsFeed`)

**Interfaces:**
- Consumes: nothing from Task 1 — see below.
- Produces: imported rows carry both `date` and `work_date`.

> **No import needed.** An earlier draft added `import { toIsoDate }` here, but
> nothing in this task uses it: `normaliseDate` already returns ISO, so Step 1
> just copies that value across, and Step 2 is SQL. Adding the import would
> leave dead code in the Worker bundle.

- [x] **Step 1: Have the importer write both columns**

`normaliseDate` in the Worker accepts shapes the app's parser does not — `dd.mm.yy`, a trailing time from a spreadsheet — so it stays as the CSV-shape reader. It already returns ISO, so the task row gains one line. In `handleJobsFeedImport`, in the `task` object:

```js
      date,
      // The same day in both columns. `date` is what the feed's export writes
      // and older clients read; work_date is what the database can query.
      work_date: date,
```

- [x] **Step 2: Have the jobs feed order by the real column**

In `handleJobsFeed`, change the query from ordering by `id` to ordering by the date, which is what the feed actually presents:

```js
  const res = await sbFetch(env, "/tasks?select=*&order=work_date.desc.nullslast,id.desc&limit=20000");
```

- [x] **Step 3: Verify**

Run: `npx vite build` — the Worker is bundled by the same build.

Then run a **dry-run** import (the UI always previews first) with a small CSV and confirm the plan reports the same `toInsert` count as before this task. Then check the feed still lists newest-first.

- [x] **Step 4: Commit**

```bash
git add worker/index.js
git commit -m "Worker: import into work_date and order the jobs feed by it"
```

---

### Task 7: Retire the text column — SEPARATE, AFTER A SOAK

**Do not start this task in the same session as Tasks 1-6.** Every browser with the old bundle cached still writes only `date`; this task assumes they have all reloaded. Leave at least a full working week, then confirm with the query in Step 1.

**Files:**
- Create: `supabase/migrations/<timestamp>_tasks_drop_text_date.sql`
- Modify: `src/hooks/useTasks.js`, `src/components/LegacyTimesheets.js`, `src/components/Management.jsx`, `src/components/Profile.jsx`, `worker/index.js`, `supabase/schema.sql`

- [ ] **Step 1: Confirm nothing is still writing text-only**

```sql
select count(*) as text_only_rows_last_14_days
from public.tasks
where work_date is null
  and date is not null and trim(date) <> ''
  and created_at > now() - interval '14 days';
```

Expected: `0`. **If it is not 0, stop** — a client is still on the old bundle, or a writer was missed in Task 3.

- [ ] **Step 2: Remove the `|| toIsoDate(t.date)` fallbacks**

Every site touched in Tasks 4 and 5 currently reads `t.work_date || toIsoDate(t.date)`. Drop the second half at each, leaving `t.work_date`.

- [ ] **Step 3: Stop writing the text column**

In `src/hooks/useTasks.js` `toDb`, delete the `date:` line, keeping `work_date`. In `fromDb`, delete `date:`, keeping `workDate`. Then fix the resulting build errors — anything still reading `.date` on a task should read `.workDate` and format for display with `isoToUk`.

- [ ] **Step 4: Write and apply the drop migration**

```sql
-- The legacy text date. Two formats in one column, uncomparable in SQL; see
-- 20260810090000_tasks_work_date.sql for the whole story. Dropped only after
-- confirming no row had been written text-only for a fortnight.
alter table public.tasks drop column if exists date;
```

- [ ] **Step 5: Verify and commit**

Run: `npm test`, `npx vite build`, then exercise Legacy, Tracker, Profile and the Jobs Feed.

```bash
git add -A
git commit -m "Drop the legacy text date column from tasks"
```

---

## Self-Review

**Spec coverage.** Every one of the six parsers has a task: `useTasks` in Task 4; the two in `LegacyTimesheets`, plus `Management` and `Profile`, in Task 5; the Worker's `normaliseDate` in Task 6 (deliberately kept — it reads CSV shapes the app never produces). Every writer is covered by Task 3, because all of them funnel through `useTasks.toDb`. The two blank-date rows are accounted for in Task 2 Step 4.

**Placeholders.** None — every code step carries the actual code, and every verification step names the exact query or command and its expected result.

**Type consistency.** `toIsoDate` returns `string|null` everywhere. `toDbDate` is a named alias for it, used only at the write boundary so the intent reads clearly at the call site. `fromDb` exposes `workDate` (camelCase, matching its neighbours); the raw column is `work_date` and is only referenced in `toDb`, in Task 5's readers (which read raw Supabase rows, not `fromDb` output) and in SQL.

**One risk not eliminated:** Task 5's readers use `r.work_date` on rows that come straight from Supabase rather than through `fromDb`. If a future refactor routes those through `fromDb`, they would need `r.workDate`. The `|| toIsoDate(r.date)` fallback masks that until Task 7 removes it — so Task 7 Step 2 is the point at which any such mistake surfaces, and its verification step exists for that reason.
