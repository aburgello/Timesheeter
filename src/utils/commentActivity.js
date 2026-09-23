import { splitTerritories, toTimesheetTerritories } from "./territories";
import { resolveCountryCode } from "./countryCodes";

// ── Estimating what you worked on, from your Wrike activity ──────────────────
// People often don't comment on a task until they have something to send for
// review, so a comment marks the END of a stretch of work, not the start. The
// start is the hand-off: being assigned, or someone moving your task into a
// new status (into Motion, say, which is a motion designer's cue). Status
// changes come from wrike_task_activity, recorded by the webhook; see
// migration 20260923181757.
//
// Each task's day is read as stretches:
//   start — you're assigned, or someone else moves it into an active status.
//   mine  — you comment on it or change its status yourself. Closes the
//           stretch. With no start before it that day, the stretch runs back
//           to where you last left the task, or to the start of the day.
//   stop  — someone else moves it to a closed status (Completed, Deferred,
//           Cancelled). Closes an open stretch without it being yours.
// A stretch still open at the end of the day runs to the end of the day, with
// one exception: a status change by someone else AFTER you've already acted on
// the task that day is most likely the review step ("Client Review"), not a
// new start, so it's dropped rather than handed the rest of the day.
//
// The working day (09:30–18:00) bounds the stretches nobody closed: a hand-off
// you never acted on, or one someone else closed. A stretch YOU close proves
// you were working, so it isn't cut at 18:00: a comment at 20:15 counts to
// 20:15. Its start is still held to 09:30 (an overnight automated status
// change isn't a night's work), unless your action came before 09:30 too, in
// which case the early start is real, floored at 07:00.
//
// Time after 18:00 is overtime and is reported separately, so it can go in
// the timesheet's Add. Time column.
//
// When stretches overlap, each minute is split evenly between the tasks open
// in it, so a day never adds up to more hours than it had.
//
// Everything here is in minutes since local midnight; the caller converts.

export const DAY_START_MIN = 9 * 60 + 30;
export const DAY_END_MIN = 18 * 60; // also where overtime begins
export const EARLIEST_MIN = 7 * 60;

/**
 * events: [{ taskId, minute, kind: "start"|"mine"|"stop", cue?: "assigned"|"status" }]
 * dayEnd: where unclosed stretches stop — 18:00, or now if that's earlier today.
 * Returns {
 *   byTask:         { [taskId]: minutes }, all of it
 *   overtimeByTask: { [taskId]: minutes }, the part after 18:00
 *   intervals:      [{ taskId, from, to }], each stretch before splitting, for drawing
 * }
 */
export function estimateFromActivity(events, { dayStart = DAY_START_MIN, dayEnd = DAY_END_MIN, overtimeFrom = DAY_END_MIN } = {}) {
  const perTask = new Map();
  for (const e of events) {
    if (!e.taskId || !Number.isFinite(e.minute)) continue;
    if (!perTask.has(e.taskId)) perTask.set(e.taskId, []);
    perTask.get(e.taskId).push(e);
  }

  const intervals = [];
  const add = (taskId, f, t) => {
    if (t > f) intervals.push({ taskId, from: f, to: t });
  };
  // Nobody closed it: hold it to the working day.
  const unclosed = (taskId, from, to) => add(taskId, Math.max(from, dayStart), Math.min(to, dayEnd));
  // You closed it: runs to your action, however late.
  const closedByYou = (taskId, from, to) =>
    add(taskId, to <= dayStart ? Math.max(from, EARLIEST_MIN) : Math.max(from, dayStart), to);

  for (const [taskId, list] of perTask) {
    list.sort((a, b) => a.minute - b.minute);
    let open = null; // { minute, cue } of the start that opened the stretch
    let lastMine = null;
    for (const e of list) {
      if (e.kind === "start") {
        if (!open) open = { minute: e.minute, cue: e.cue };
      } else if (e.kind === "mine") {
        closedByYou(taskId, open ? open.minute : lastMine ?? dayStart, e.minute);
        lastMine = e.minute;
        open = null;
      } else if (e.kind === "stop" && open) {
        unclosed(taskId, open.minute, e.minute);
        open = null;
      }
    }
    if (open && !(open.cue === "status" && lastMine !== null)) unclosed(taskId, open.minute, dayEnd);
  }

  // Split each stretch of the day between the tasks open in it. 18:00 is a cut
  // too, so no piece straddles it and each is wholly overtime or not.
  const byTask = {};
  const overtimeByTask = {};
  for (const taskId of perTask.keys()) byTask[taskId] = overtimeByTask[taskId] = 0;
  const cuts = [...new Set([...intervals.flatMap((i) => [i.from, i.to]), overtimeFrom])].sort((a, b) => a - b);
  for (let k = 0; k < cuts.length - 1; k++) {
    const [a, b] = [cuts[k], cuts[k + 1]];
    const open = [...new Set(intervals.filter((i) => i.from <= a && i.to >= b).map((i) => i.taskId))];
    for (const taskId of open) {
      byTask[taskId] += (b - a) / open.length;
      if (a >= overtimeFrom) overtimeByTask[taskId] += (b - a) / open.length;
    }
  }
  return { byTask, overtimeByTask, intervals };
}

/**
 * One person's day of Wrike activity, as estimateFromActivity's events.
 *   comments   your comments: [{ taskId, createdDate }]
 *   activity   wrike_task_activity rows for the day
 *   isMyTask   (taskId) => whether you're assigned to it; someone else's
 *              status change only cues work on a task that's yours
 *   statusGroup (customStatusId) => "Active" | "Completed" | "Deferred" |
 *              "Cancelled" | undefined (unknown counts as active)
 */
export function activityToEvents({ comments, activity, me, isMyTask, statusGroup }) {
  const events = comments
    .filter((c) => c.taskId)
    .map((c) => ({ taskId: c.taskId, minute: localMinuteOf(c.createdDate), kind: "mine" }));
  for (const a of activity) {
    const minute = localMinuteOf(a.occurred_at);
    const base = { taskId: a.task_id, minute };
    if (a.event_type === "TaskResponsiblesAdded" && a.user_ids?.includes(me)) {
      events.push({ ...base, kind: "start", cue: "assigned" });
    } else if (a.event_type === "TaskResponsiblesRemoved" && a.user_ids?.includes(me)) {
      events.push({ ...base, kind: "stop" });
    } else if (a.event_type === "TaskStatusChanged") {
      if (a.author_id === me) events.push({ ...base, kind: "mine" });
      else if (isMyTask(a.task_id)) {
        const group = statusGroup(a.custom_status_id);
        events.push(group && group !== "Active" ? { ...base, kind: "stop" } : { ...base, kind: "start", cue: "status" });
      }
    }
  }
  return events;
}

// Minutes → hours on the timesheet's 0.25 grid, never below one step: anything
// you worked on took some time. The bookmarklet still snaps
// each row to its own job's grid (INT jobs only take 0.5) when it's pasted.
export const roundToQuarterHours = (minutes) =>
  Math.max(0.25, Math.round((minutes || 0) / 15) / 4);

// The XY job code a job-number string carries, for matching a suggestion to
// rows typed in by hand (which have no taskId).
export const jobCode = (jobNumber) =>
  ((jobNumber || "").match(/XY\d{5,6}/i) || [""])[0].toUpperCase();

/**
 * Hours already on the timesheet for this task on this day, in total and per
 * column (Time Spent as regular, Add. Time as extra).
 *
 * Rows pulled from Wrike carry the taskId, and match exactly. Rows typed in by
 * hand only carry the job number, so they're matched on its XY code — only
 * when no row matches by task, and narrowed to the task's markets. A job
 * usually has one task per market ("SF Motion Outdoor ID" is Indonesia), so
 * without that every task on the job was credited with the whole job's time.
 * A row covering several markets counts in full for each of them: that time
 * was spent on all of them together. A task with no market falls back to the
 * whole job.
 *
 * Markets are compared through the app's own territory rules, in two steps:
 *   1. resolveCountryCode, the resolver Wrike Pull uses: codes, aliases and
 *      the ones curated in Administration → Translation Countries, so "CZ",
 *      "Czechia" and "Canada - French" each land on one territory name.
 *   2. The timesheet's own name for it (what Copy Me! exports), which is
 *      where two names we both carry become one: "Czech Republic" is the
 *      site's "Czech". The resolver leaves those apart, as both are valid.
 * Not by market code: India's language markets share IN and Spain - Catalan
 * shares ES, and those are separate timesheet choices.
 */
export function hoursLoggedFor(dayRows, { taskId, jobNumber, territory }, parseHours) {
  const sum = (list, match) => {
    const regular = list.reduce((s, r) => s + parseHours(r.timeSpent), 0);
    const extra = list.reduce((s, r) => s + parseHours(r.additionalTime), 0);
    return { hours: regular + extra, regular, extra, match };
  };
  const byTask = dayRows.filter((r) => taskId && r.taskId === taskId);
  if (byTask.length) return sum(byTask, "task");
  const code = jobCode(jobNumber);
  const byJob = code ? dayRows.filter((r) => !r.taskId && jobCode(r.jobNumber) === code) : [];
  const asTimesheet = (value) =>
    toTimesheetTerritories(splitTerritories(value).map((t) => resolveCountryCode(t) || t)).map((t) => t.toLowerCase());
  const markets = new Set(asTimesheet(territory));
  if (!markets.size) return byJob.length ? sum(byJob, "job") : { hours: 0, regular: 0, extra: 0, match: "" };
  const byMarket = byJob.filter((r) => asTimesheet(r.territory).some((t) => markets.has(t)));
  return byMarket.length ? sum(byMarket, "market") : { hours: 0, regular: 0, extra: 0, match: "" };
}

// A local calendar day as the UTC range Wrike's createdDate filter takes
// (second precision, no milliseconds: the yyyy-MM-ddTHH:mm:ssZ form Wrike documents).
export function dayRangeUtc(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const fmt = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  return { start: fmt(start), end: fmt(end) };
}

// Minutes since local midnight for an ISO timestamp.
export const localMinuteOf = (iso) => {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
};
