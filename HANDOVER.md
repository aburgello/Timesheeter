# Handover

This is the document to read first if you're taking over TimeHub. It explains
what the pieces are, where things live, how to change things safely, and what
is known to be fragile. Two other documents go deeper:

- **WRIKE.md**: how data comes in from Wrike and how it's used for timesheets
  and for the PMs. Read this before changing anything that touches Wrike.
- **DEPLOY.md**: setting up Cloudflare, Supabase and the Wrike app from
  scratch, and deploying.

README.md just covers running it locally.


## What it is

TimeHub is the studio's internal web app. People use it to turn their Wrike
work into timesheets for the company timesheet site, and PMs use it to keep the
Job Book (the list of every job, its film, client and costs) in step with how
jobs are set up in Wrike. It also has the Motion Board, notes (Canvas), a
profile page with live Wrike timers, and an Administration area.


## The pieces

```
  browser (React app) ──────────────► Supabase (Postgres, auth, realtime)
        │                                   ▲
        │ /api/*                            │ service key
        ▼                                   │
  Cloudflare Worker ────────────────────────┘
        │  holds each person's Wrike token, proxies Wrike calls,
        │  receives Wrike webhooks, serves the jobs feed and panel API
        ▼
      Wrike API

  company timesheet site ◄── bookmarklet (pastes the week exported from Legacy)
  XYi Toolbox (Adobe panel) ──► Worker /api/panel/*
```

- **The website** is React, built with Vite. It's served by the same
  Cloudflare Worker as static files.
- **The Worker** (`worker/index.js`) handles Wrike login and token storage,
  forwards every Wrike call, receives Wrike's webhooks, and serves the jobs
  feed and the Toolbox panel's API. It's the only thing that holds secrets.
- **Supabase** stores everything: timesheet rows, the Job Book, profiles, the
  shared Wrike cache, notes. The browser signs in to Supabase anonymously and
  identifies itself by the person's Wrike ID.
- **Wrike** is the source of truth for work. See WRIKE.md.
- **The bookmarklet** (`bookmarklet.src.js`, built into `bookmarklet.txt`)
  runs on the company timesheet site, not in TimeHub.


## Finding your way around the code

```
src/
  App.jsx                 top-level layout, navigation, who sees which page
  components/             one file per screen, plus shared/ and legacy/ parts
  hooks/                  data loading (useWrikeCache, useTasks, useJobLookup …)
  lib/                    logic with no UI: Wrike, Supabase, access rules
  utils/                  small pure helpers (dates, times, countries, CSV)
  constants.js            countries, region codes, film code mappings
worker/index.js           the Cloudflare Worker
supabase/
  schema.sql              the full database schema, including access rules
  migrations/             every database change, in date order
tests/                    unit tests, run with npm test
bookmarklet.src.js        the timesheet-site bookmarklet (source)
```

`components/Management.jsx` is the entry point for Administration. It used to
be one 6,300-line file. It's now about 380 lines: the page shell and its
navigation. Each section and modal lives in its own file in
`components/management/` (`JobBookSection.jsx`, `StudioJobScanModal.jsx`,
`PushToWrikeModal.jsx`, `PeopleSection.jsx` and so on), and each file opens
with a line saying what it contains. Shared form controls are in `fields.jsx`,
and lists used by several sections are in `constants.js`.

Two files are still very large and are where changes are riskiest:
`components/Canvas.js` (about 5,900 lines, the notes canvas and the campaign
and DOOH boards) and `components/LegacyTimesheets.js` (about 4,000, the
timesheet). Most of each is a single component, so splitting them means
pulling state and logic out into hooks and helpers rather than moving code.
If you need to change one of them, the safest approach is to move the part
you're changing out into `lib/` or its own component first, with tests, the
way `lib/wrikeCampaign.js` was. Don't attempt a big rewrite.

**Following history across the split.** Code that moved into
`components/management/` keeps its history, but plain `git blame` (and
GitHub's blame page) will credit every line to the split commit. Use:

```
git blame -C5 -C5 src/components/management/JobBookSection.jsx
```

That traces moved lines back to the commit that really wrote them. In
testing it recovered all but the new header and import lines of each file
(for example 625 of 635 lines in `StudioJobScanModal.jsx`). The lower
threshold matters: the default `-C` doesn't recognise this move. On GitHub,
open `components/Management.jsx` as it was before the split commit instead.

**How the code is commented.** Comments mostly explain *why*, often with the
incident that made a rule necessary, including the date and the numbers
involved. Before "simplifying" something that looks over-careful, read the
comment above it. It usually describes the bug that the simpler version had.


## Making a change safely

```
npm install
npm run dev        # local site at http://localhost:5173
npm run check      # tests + lint + bookmarklet check + production build
```

`npm run check` runs the same steps as CI. GitHub runs them on every pull
request and every push to `main` (`.github/workflows/ci.yml`), so a change that
breaks a test or the build shows up on the pull request before it's merged.

- **Tests** live in `tests/*.test.mjs` and run with `npm test`. They cover the
  pure logic: time and date handling, country resolution, Wrike folder
  climbing, the Job Book scan, CSV parsing and so on. They don't cover screens.
  To add one, copy the shape of an existing file. `check(name, got, want)` is
  the whole API.
- **Lint** (`npm run lint`) looks for real bugs (undefined variables, hooks
  used incorrectly, duplicate keys) rather than style. Errors fail CI.
  Warnings, of which there are about 140 in existing code, don't. Clearing them
  file by file as you touch things is worthwhile but not urgent.
- **Formatting** isn't enforced, on purpose. Reformatting 45,000 lines would
  bury the git history that the comments refer back to. `.editorconfig` covers
  the basics (two-space indent, LF line endings).
- **The bookmarklet check** fails if `bookmarklet.txt` wasn't regenerated after
  `bookmarklet.src.js` was edited.

**Before changing the Job Book scan or the studio list**
(`src/lib/wrikeCampaign.js`, `src/lib/studios.js`), run the scan regression
gate by hand. It runs the real scanner over the real cached Wrike folder tree
and shows you every job whose film, client or region would change:

```
git switch main && npm run scan:accept      # snapshot what main does today
git switch your-branch && npm run scan:diff # what your change moves
```

Read the list before merging. It isn't in CI because the Wrike tree changes
every day, so it would fail for reasons unrelated to the code.

**Changing the database.** Add a new file to `supabase/migrations/` named with
the date and time, apply it in Supabase, and update `supabase/schema.sql` to
match. Never edit an old migration.


## Deploying

**Merging to `main` on `aburgello/Timesheeter` deploys to the live site.**
Cloudflare Workers Builds is connected to that repository. A push to its
`main` builds and deploys the `timesheeter` Worker within a couple of
minutes, and every other branch gets a preview build with its own URL,
which is posted as a check on the pull request. So the pull request's checks
are the last stop before production. Read them before merging.

To check a deploy really went live, compare the `assets/index-….js` file
named in the live site's page with the one in `dist/client/index.html`
from a local `npm run build` of the same commit. They match when the
site is serving that commit.

`npm run deploy` still works for deploying by hand from your machine. Full
setup is in DEPLOY.md.

The other two copies of the repository (`aburgelloxyi/TimeHub` and
`xyidesign/timehub`) aren't connected to Cloudflare as far as anyone has
checked, so pushing there doesn't deploy. Confirm that under Workers →
timesheeter → Settings → Build before relying on it.


## Accounts, secrets and configuration

Values are never written here. This is a list of what exists and where it
lives. Fill in the owner column during handover.

| What | Where it lives | Owner |
|---|---|---|
| Cloudflare account and the `timesheeter` Worker | Cloudflare dashboard | |
| `WRIKE_CLIENT_SECRET` | Worker secret (Cloudflare) | |
| `SUPABASE_SERVICE_ROLE_KEY` | Worker secret (Cloudflare) | |
| `PANEL_KEY` (Toolbox panel's shared key) | Worker secret, and in the panel | |
| `WRIKE_CLIENT_ID`, `SUPABASE_URL` | `wrangler.jsonc` (not secret) | |
| Wrike OAuth app | Wrike, under the app's developer settings | |
| Wrike webhook and its signing secret | registered from Admin; secret stored in Supabase | |
| Supabase project | Supabase dashboard | |
| Supabase anon key | `src/lib/supabaseClient.js` (public by design) | |
| GitHub repository | GitHub | |

The Supabase anon key is meant to be public. It's in every visitor's browser
anyway. That only holds up if the database's access rules (row level security,
in `schema.sql`) are what actually protect the data. See "Known issues" below.

**Who can open Administration** is decided by a hardcoded list of Wrike IDs in
`src/lib/access.js`. Giving someone access takes three changes, which have to
match: that list, the `profiles_write` policy, and the `guard_can_debug_pull`
trigger, both in a migration. The comment at the top of `access.js` explains
why. Adding someone in only one place gives them the screens but writes that
silently fail.


## Keeping an eye on it

- **Worker logs.** Observability is switched on in `wrangler.jsonc`, so the
  Worker's logs are in the Cloudflare dashboard under the `timesheeter` Worker.
  Useful things to search for: `[webhook]` for webhook problems,
  `token_refresh_failed` for people being signed out of Wrike, and `503` for
  Supabase being slow.
- **Errors in the browser** aren't collected anywhere yet. If something breaks
  on someone's screen, you'll only hear about it from them. Adding an error
  service (Sentry's free tier is enough) is the next step, but it needs an
  account created by whoever owns the project.
- **The Wrike webhook** can be suspended by Wrike without anyone noticing,
  because the fifteen-minute sync carries on. If boards feel slow to update,
  re-register it from Admin.
- **Backups.** Check in the Supabase dashboard that backups (ideally
  point-in-time recovery) are on, and try a restore into a scratch project
  once, so you know it works before you need it.


## Routine upkeep

- **Weekly:** Dependabot opens a pull request or two with dependency updates.
  If CI passes, minor and patch updates are usually safe to merge. Major
  versions come separately and need reading, particularly React, Vite, Tiptap
  and Supabase.
- **When the studio changes how it organises Wrike** (new studio, new kind of
  folder, new naming habit), check the Job Book scan's "disagrees with Wrike"
  list afterwards. A sudden jump there means a folder convention changed. New
  studios go in `src/lib/studios.js`.
- **When the company timesheet site changes**, check the bookmarklet still
  works. It depends on functions that site defines.
- **When people join or leave**, check `src/lib/access.js` for
  Administration access. `src/lib/people.js` lists Wrike accounts that aren't
  real people (shared inboxes, bots), which are kept out of people lists. Add
  any new ones there.


## Known issues and open decisions

These were found during a review in October 2026 and haven't been resolved.

1. **Security review needed before handover.** The way the database identifies
   who is making a request needs reworking so that it can't be influenced from
   the browser. The details have been passed on privately rather than written
   here, because this repository is public. Treat this as the first job.
2. **The repository is public** and contains the Supabase URL and anon key.
   Decide whether it should be private, and in a company-owned GitHub
   organisation.
3. **There are three copies of the repository** (`aburgelloxyi/TimeHub`,
   `xyidesign/timehub`, `aburgello/Timesheeter`) with different histories.
   Choose one as the real one and archive or mirror the others.
4. **Access lists are hardcoded** (see above), so staff changes need a code
   change and a deploy.
5. **No error reporting from browsers** (see above).
6. **The Toolbox panel borrows a person's Wrike login**: whichever connected
   person's token was refreshed most recently. If nobody stays connected, the
   panel stops working.
7. **Frozen timesheet days are stored in the browser**, so they don't follow a
   person between computers.
8. **Two very large files** remain, Canvas.js and LegacyTimesheets.js (see
   above), which make changes there riskier than they need to be.
