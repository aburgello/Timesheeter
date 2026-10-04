# How TimeHub gets its data from Wrike, and what it does with it

Wrike is where the studio's work lives: every film has a project, every job
has a folder, every piece of work is a task, and people log their time against
those tasks. TimeHub doesn't replace any of that. It reads Wrike, makes sense of
it, and turns it into two things Wrike can't produce on its own: timesheets the
company's timesheet site will accept, and an organised view of jobs for the
project managers.

This document explains how that works in practice. It is written for whoever
looks after TimeHub next, so it describes the system as it actually behaves,
including the parts that are fragile. File names are given where they help you
find the code, but you shouldn't need to read the code to follow it.


## Getting permission to talk to Wrike

Each person connects their own Wrike account once, from inside TimeHub. That
sends them to Wrike's login page, Wrike asks them to approve access, and they
come back connected. Behind the scenes Wrike hands us an access token and a
refresh token for that person.

Those tokens never reach the browser. They are stored in Supabase in a table
called `wrike_oauth_tokens`, which the browser can't read at all; only the
Cloudflare Worker can, using the Supabase service key it holds as a secret. The
browser just gets a cookie that identifies the session (it lasts 180 days).

From then on, every time the website wants something from Wrike it asks the
Worker instead, at an address starting `/api/wrike/`. The Worker looks up the
person's token, attaches it, forwards the request to Wrike, and passes the
answer back. So when you read code that calls `/api/wrike/tasks`, that is a
real Wrike API call, made on behalf of whoever is logged in, with their
permissions. If someone can't see a project in Wrike, they won't see it in
TimeHub either.

Access tokens expire, so the Worker refreshes them shortly before they do. This
is more delicate than it sounds, because Wrike issues a brand new refresh token
every time one is used and the old one stops working immediately. If the new
pair is lost before it is saved, that person is logged out for good and has to
reconnect by hand. Most of the long comments at the top of `worker/index.js`
exist because of this, and because of a Supabase slowdown on 28 August 2026
that caused exactly that problem. The short version: concurrent requests share
a single refresh rather than racing, new tokens are held in memory and retried
if the save fails, and a hiccup reaching Wrike or Supabase is never reported to
the user as "you've been signed out". Only Wrike explicitly rejecting the token
does that.

There is one exception to "every request is made as the logged-in person". The
XYi Toolbox panel (the Adobe extension, described further down) has no Wrike
login of its own, so when it needs Wrike it borrows whichever connected
person's token was refreshed most recently. That works, but it means the panel
quietly depends on at least one person staying connected.


## The three ways data comes in

**The shared sync.** This is how the Motion Board and most of the app get their
tasks. It lives in `src/hooks/useWrikeCache.js`. Roughly every fifteen minutes,
the first person to have the app open checks a shared timestamp in Supabase. If
nobody has synced in the last fifteen minutes, their browser does it for
everyone. If somebody has, it doesn't call Wrike at all. One person's browser
doing the work for the whole team is what keeps us inside Wrike's rate limits.

A sync asks Wrike for every task changed since the last sync (two months back
on a full refresh), keeps only the ones relevant to the Motion team, works out
what film, client and market each one belongs to (see "Making sense of a task"
below), and writes the results into a Supabase table called
`wrike_tasks_cache`. Every browser reads from that table, and also keeps a copy
in its own local storage so the page loads quickly next time. To keep that copy
current it asks only for what changed since it last looked: the database stamps
each row with `cached_at` when its content changes, and records every task
removed from the cache in `wrike_tasks_cache_removed`, so removals reach every
browser too (code in `src/lib/sharedTaskSync.js`). Once a day the
sync also refreshes the folder tree, the list of people and the list of
workflow statuses, and stores those in `wrike_sync_meta` under a single row
named `shared`. The day is counted from the last refresh of those lists
(`dictionaries_refreshed_at`), not the last sync. A refresh only replaces a
list it downloaded in full. If Wrike fails partway, the previous copy stays and
the next sync tries again.

A task counts as relevant to the Motion team if its title matches certain
keywords, if it sits in a digital folder, if someone on the Motion team is
assigned to it, or if it has a subtask that meets one of those. When a task
stops being relevant, for example because it's reassigned to another team, it
is removed from the cache so a stale copy doesn't linger.

**Webhooks, for anything that changes in between.** Fifteen minutes is too slow
to watch a task move, so Wrike is also set up to notify us the moment a task
changes. Wrike calls the Worker at `/api/wrike/webhook`. The Worker checks the
message is genuinely from Wrike (it's signed with a shared secret) and writes a
small record into two tables. `wrike_webhook_events` holds just "task X
changed", is kept for 24 hours, and is broadcast live to every open browser.
`wrike_task_activity` holds the detail
(who changed the status, to what, who got assigned) for six weeks. It exists
because Wrike's API has no status history, and "What did I work on?" needs to
know when work on a task actually started.

Every open tab hears every change, but only one of them acts on it for the
shared cache. Each tab "claims" the events it heard (`claim_wrike_webhook_events`,
which lets exactly one claimant win each event). The winner fetches the task
from Wrike, updates the shared cache, and removes the task from the cache if
Wrike reported it deleted. The other tabs pick up the result from the cache a
few seconds later instead of calling Wrike themselves. Separately, the
Legacy, Profile and Motion Board pages fetch a changed task only if it's
already on their list, or the change could add it (a new task, a new
assignment, and for the Motion Board a new date or status).

One rule matters a lot here: the Worker always answers Wrike with "OK", even
when something on our side has gone wrong. If Wrike gets errors back, it
suspends the webhook for the whole account, and the suspension outlasts
whatever caused it. Losing a few live updates is harmless, because the
fifteen-minute sync catches them anyway. Losing the webhook isn't. The webhook
is registered (or re-registered) by an admin from the Admin screen.

**Direct reads, when a screen needs something specific.** Some things aren't
cached because they're personal, or because they need to be exact at that
moment: your own time logs, the task you've just opened, your live timers, the
latest comment on a job, the full folder tree when someone runs a Studio Scan.
Those go straight through the Worker to Wrike when they're needed.

Every Wrike call made from the browser goes through a small helper
(`src/lib/fetchPool.js`) that waits and retries up to three times if Wrike says
we're sending too many requests, and that limits how many requests run at
once. Wrike's rate limit applies to the whole account, not per person, so one
heavy screen can slow down everyone else's.


## Making sense of a task

A raw Wrike task doesn't tell you which film it's for, which studio is paying,
which country it's for, or which job number to bill it to. TimeHub works that
out, mostly by looking at where the task sits in Wrike's folder tree. This is
the part most likely to go wrong when the studio changes how it organises
folders, so it's worth understanding.

Wrike will tell you which folders a folder *contains*, but not which folder
contains *it*. So we download the whole folder list once, flip it around, and
then "climb" upward from a task to see what it's filed under. A folder can sit
in more than one place in Wrike, so the climb follows every route, not just
one.

The **film** is normally the folder directly above a `DIGITAL` or `PRINT`
folder. For the Job Book, the film is the folder just below the studio folder,
skipping anything that isn't a film. "Isn't a film" means a year folder like
`2025`, a medium folder like `Digital` or `Print`, or any folder whose name
starts with an underscore. The underscore is the studio's own convention for
organisational folders (`_Old`, `_Masters`, `_Market`, `_House_Keeping` and so
on). We learned this the hard way: before the rule existed, 47 jobs for many
different films were all recorded under a film called "Old", because they sat
inside `Universal - New Media › _Old › 2025 › <the real film>` and the climb
stopped at `_Old`. House-job folders are the one kind of underscore folder we
do keep as the answer, because house jobs have no film.

The **studio and client** come from the first folder on the way up that names
a studio. The list of studios and the words that identify them is in
`src/lib/studios.js`, and both the board and the Job Book read from that one
list. Underscores in folder names are treated as spaces when matching, so
`Universal_UK_Archive` counts as Universal but `Portfolio Mgmt` doesn't count
as MGM.

The **market or country** is read, in order, from a country code at the end of
the task's name, the parent task's name, a market folder above it, and finally
the Country custom field. We read it rather than guess it. If none of those say
anything, the country is left blank on purpose, because a wrong country is
worse than an empty one.

The **job number** comes from the "Job Number" custom field if it's set,
otherwise from an XY code (`XY` followed by five or six digits) found in the
task's title, path or description. Once a job number is known, the Job Book
(the `jobs` table in Supabase) has the final say. Whatever film and client the
PMs have recorded there beats anything we worked out from folders.

The **category** (the billing line, such as "Digital - Proofreading") comes
from the person's own default, with the Print/Digital half switched to match
the folder the job sits in, or from keyword rules if they haven't set a
default.

All of this lives in `src/lib/wrikeEnrich.js` for the board and timesheets,
and in `src/lib/wrikeCampaign.js` for the Job Book scan.


## Timesheets (Legacy)

Legacy is the timesheet screen people actually use. Its job is to turn what
someone did in Wrike into rows the company's timesheet site will accept, with
as little typing as possible. The code is `src/components/LegacyTimesheets.js`.

There are two buttons that bring in data, and they do different things.

**"Sync my jobs"** fetches the tasks you're working on: everything active where
you're an assignee, plus anything you completed in the last seven days. For
subtasks it also fetches the parent task, because a subtask has no folders of
its own and inherits its film and market from the parent. This gives the
screen its list of jobs to choose from. It doesn't create timesheet rows by
itself.

**"Pull times"** is the one that fills the timesheet. It fetches the time you
logged in Wrike, for today and yesterday by default (yesterday so that anything
logged after you last pulled still arrives). People who have been given
"Debug Pull" on their profile can also pull a single chosen date. For each time log it works out the job number, film, client,
country and category as described above, and then:

- skips any time log that has already been pulled, by Legacy or anywhere else,
  so pulling twice never duplicates
- adds up time per task per day *before* rounding, so two two-minute logs
  become four minutes rather than two separately rounded entries
- if you've chosen to merge markets, folds several countries for the same job
  into one row
- skips any day you've marked as frozen

The rows are saved to the `tasks` table in Supabase with `source = legacy`.
They are only saved there and shown to you. Nothing is sent anywhere yet.

**Getting the rows onto the company timesheet site.** TimeHub has no access to
that site. Instead, Export copies your week to the clipboard as a block of
JSON, and you paste it in on the timesheet site using a bookmarklet, a small
script saved as a browser bookmark. The bookmarklet's source is
`bookmarklet.src.js` in the root of this repository, and the bookmark itself is
`bookmarklet.txt`, which is generated from it. The command to regenerate it is
at the top of the source file. The bookmarklet fills in the site's own form
row by row, matching each job against the site's own job dropdown by its XY
code, and it does the final rounding to whatever step that job uses on the site
(a quarter of an hour for UK jobs, half an hour for international ones).
TimeHub deliberately sends exact seconds and leaves the rounding to the
bookmarklet, because only the site knows the step.

This is the most fragile part of the whole chain. The bookmarklet relies on
functions that exist on the timesheet site's page (`RowAdd`,
`populateJobInfo`, `timesheetRowUpdateCheck`, and jQuery). If that site is
ever updated or replaced, the bookmarklet will stop working and nothing in
TimeHub will tell you.

Two smaller things worth knowing. Frozen days are remembered in the browser's
local storage, so they don't follow someone to another computer. And the hours
on a row are in exact seconds until export, so what you see on screen and what
the site ends up with can differ by the rounding step.

**"What did I work on?"** is a helper inside Legacy for filling in a day you
didn't log properly. It rebuilds your day from the comments you left in Wrike
that day and from the status changes and assignments recorded by the webhook in
`wrike_task_activity`, so it can tell when work on a task really started, which
the comments alone often get wrong.


## PM and operations

The project managers use the Management area (`src/components/Management.jsx`),
and this is where TimeHub writes back to Wrike as well as reading it.

**The Job Book** is the `jobs` table in Supabase: one row per job, with its
job number, film, client, description, costs and status. It's the reference
everything else defers to. It fills up in two ways: automatically, a bare row
gets added the first time a job number is seen in someone's timesheet, and in
bulk through the Studio Scan.

**The Studio Scan** ("Scan Wrike for job numbers") reads the entire folder tree,
finds every folder whose name starts with an XY code, and works out each job's
film, client, region and description from where it sits. It then compares that
with the Job Book and shows you two lists: jobs that are in Wrike but not in
the book yet, and jobs that are in the book but disagree with Wrike (filed under
the wrong film, with the wrong description, or with folder junk stuck in the
job number). Nothing is written until you confirm, and it only ever writes to
the Job Book, never to Wrike. If the same job number turns up on more than one
folder, the scan prefers a live folder over an archived copy and shows you the
clash rather than silently picking one.

**Jobs setup and "Push to Wrike"** go the other way, setting up a new film's
jobs in Wrike. Each studio that's set up for this has a master template folder
in Wrike with a slot for every kind of job. A PM picks the film and activates the slots they need, and
the push then:

1. copies the studio's template into the film's Wrike project
2. renames each activated slot's folder to its job code (it refuses outright
   to write anything inside the template itself)
3. sets the "Job Number" custom field on that folder and on every task and
   subtask inside it, so time logged there is tagged with the right job

There's also a "re-tag" mode that skips the copy and just re-applies job
numbers to a film's existing folders, picking up anything added since. Both
check everything against live Wrike first (is the template there, is the film's
project there, does the Job Number field exist) and refuse to run unless it all
holds. You see a preview of exactly what will change before anything is
written. The template's "Item Price" custom field is read to fill in job costs
where the PM is allowed to see it.

**Film sync** adds films to TimeHub's own film list (the `films` table) from
the film projects that exist in Wrike's studio folders. It only ever adds and
never deletes.

**The Jobs feed** is a team-wide view of everyone's timesheet rows for
operations, served by the Worker at `/api/jobs-feed`. It also accepts a CSV
import of historical time. The import goes through the Worker too, with a dry
run you review first, because the browser isn't allowed to write other
people's rows.

**The XYi Toolbox panel** is an Adobe extension designers use inside their
apps. It asks the Worker (`/api/panel/jobs` and `/api/panel/comment`) for the
jobs assigned to whoever the machine belongs to, and for a job's latest Wrike
comment, which is where amends get written. It authenticates with a shared key
(`PANEL_KEY`) rather than a Wrike login. The job list is read from
`wrike_tasks_cache`, not from Wrike, so it costs nothing against the rate
limit. Only the latest comment is fetched live.


## Everything that writes to Wrike

It's worth having this in one place, because writes are the only thing that
can actually damage data in Wrike:

- logging time against a task (from the task panel)
- setting the Job Number custom field on tasks and folders, and triggering
  Wrike's cascade of that field down a folder (Push to Wrike and re-tag)
- copying a template folder, creating folders and renaming folders (Push to
  Wrike)
- registering the webhook (Admin)

Everything else only reads. All of the Push to Wrike writes follow the same
rule, set out at the top of `src/lib/wrikeCampaign.js`: a "plan" step that only
reads and shows you what would change, then an "apply" step that writes, and
only after someone clicks to confirm.


## Where it tends to break

Most of these have happened at least once. The comments in the code usually
say when and how.

- **The studio reorganises folders in Wrike.** The film, studio and market
  detection all depend on folder names and nesting. A new kind of organisational
  folder without a leading underscore, or a studio folder named in a new way,
  will produce wrong films or clients. The Studio Scan is the best early
  warning, because its "disagrees with Wrike" list will suddenly grow.
- **Rate limits.** The whole account shares one budget. A burst of heavy use,
  such as several people opening big screens at once or a full scan, can make
  other requests slow down or fail and retry.
- **Someone's connection drops.** Usually a token that couldn't be refreshed.
  They reconnect from their profile. If the Toolbox panel stops working, check
  that at least one person is still connected.
- **The webhook gets suspended.** If Wrike suspends it, live updates stop, but
  the fifteen-minute sync keeps things roughly current, so it can go unnoticed
  for a while. Re-register it from Admin.
- **The company timesheet site changes.** The bookmarklet stops working. Its
  source is in this repo, but fixing it means looking at the new page.
- **Supabase is slow.** Everything goes through it, including every Wrike call
  (to look up the token). The Worker gives up on a slow read after five seconds
  and retries, rather than hanging.


## Where to look in the code

- `worker/index.js`: the Worker. Login, token storage and refresh, the proxy to
  Wrike, the webhook receiver, the jobs feed and the Toolbox panel endpoints.
- `src/hooks/useWrikeCache.js`: the shared fifteen-minute sync and the live
  webhook updates.
- `src/lib/sharedTaskSync.js`: catching a browser up with the shared cache
  (changes and removals since it last looked), and claiming webhook events so
  only one tab acts on each.
- `src/lib/wrikeEnrich.js`: working out film, studio, market and description
  for a task, for the board and timesheets.
- `src/lib/studios.js`: the list of studios and how folder names are matched to
  them.
- `src/lib/wrikeCampaign.js`: the Studio Scan, and everything that writes to
  Wrike for Push to Wrike.
- `src/utils/wrikeHelpers.js`: turning a task into a job number, film, client
  and country.
- `src/hooks/useJobLookup.js`: the Job Book lookup the timesheets defer to.
- `src/components/LegacyTimesheets.js`: the Legacy timesheet, Sync my jobs, Pull
  times and Export.
- `bookmarklet.src.js`: the script that fills in the company timesheet site.
- `src/components/Management.jsx`: Job Book, Studio Scan, Jobs setup, Push to
  Wrike, Film sync and the Jobs feed.
- `src/lib/fetchPool.js`: retries and concurrency limits for Wrike calls.
