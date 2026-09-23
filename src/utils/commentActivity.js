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
// When stretches overlap, each minute is split evenly between the tasks open
// in it, so a day never adds up to more hours than it had.
//
// Everything here is in minutes since local midnight; the caller converts.

export const DAY_START_MIN = 9 * 60 + 30;
export const DAY_END_MIN = 18 * 60;

/**
 * events: [{ taskId, minute, kind: "start"|"mine"|"stop", cue?: "assigned"|"status" }]
 * Returns { byTask: { [taskId]: minutes }, intervals: [{ taskId, from, to }] },
 * where intervals are each task's stretches (before splitting), for drawing.
 */
export function estimateFromActivity(events, { dayStart = DAY_START_MIN, dayEnd = DAY_END_MIN } = {}) {
  const perTask = new Map();
  for (const e of events) {
    if (!e.taskId || !Number.isFinite(e.minute)) continue;
    if (!perTask.has(e.taskId)) perTask.set(e.taskId, []);
    perTask.get(e.taskId).push(e);
  }

  const intervals = [];
  const push = (taskId, from, to) => {
    const f = Math.max(from, dayStart);
    const t = Math.min(to, dayEnd);
    if (t > f) intervals.push({ taskId, from: f, to: t });
  };

  for (const [taskId, list] of perTask) {
    list.sort((a, b) => a.minute - b.minute);
    let open = null; // { minute, cue } of the start that opened the stretch
    let lastMine = null;
    for (const e of list) {
      if (e.kind === "start") {
        if (!open) open = { minute: e.minute, cue: e.cue };
      } else if (e.kind === "mine") {
        push(taskId, open ? open.minute : lastMine ?? dayStart, e.minute);
        lastMine = e.minute;
        open = null;
      } else if (e.kind === "stop" && open) {
        push(taskId, open.minute, e.minute);
        open = null;
      }
    }
    if (open && !(open.cue === "status" && lastMine !== null)) push(taskId, open.minute, dayEnd);
  }

  // Split each stretch of the day between the tasks open in it.
  const byTask = {};
  for (const taskId of perTask.keys()) byTask[taskId] = 0;
  const cuts = [...new Set(intervals.flatMap((i) => [i.from, i.to]))].sort((a, b) => a - b);
  for (let k = 0; k < cuts.length - 1; k++) {
    const [a, b] = [cuts[k], cuts[k + 1]];
    const open = [...new Set(intervals.filter((i) => i.from <= a && i.to >= b).map((i) => i.taskId))];
    for (const taskId of open) byTask[taskId] += (b - a) / open.length;
  }
  return { byTask, intervals };
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
 * Hours already on Legacy for this task on this day. Rows pulled from Wrike
 * carry the taskId; rows typed in by hand only carry the job number, so those
 * are matched on its XY code — but only when no row matches by task, or two
 * tasks on one job would each be credited with the other's time.
 */
export function hoursLoggedFor(dayRows, { taskId, jobNumber }, parseHours) {
  const sum = (list) =>
    list.reduce((s, r) => s + parseHours(r.timeSpent) + parseHours(r.additionalTime), 0);
  const byTask = dayRows.filter((r) => taskId && r.taskId === taskId);
  if (byTask.length) return { hours: sum(byTask), match: "task" };
  const code = jobCode(jobNumber);
  if (!code) return { hours: 0, match: "" };
  const byJob = dayRows.filter((r) => !r.taskId && jobCode(r.jobNumber) === code);
  return byJob.length ? { hours: sum(byJob), match: "job" } : { hours: 0, match: "" };
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
