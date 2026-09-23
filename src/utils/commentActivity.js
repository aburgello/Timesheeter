// ── Estimating time from the comments you posted in Wrike ────────────────────
// Wrike's Inbox "Sent" view is just your own comments, and each carries a
// timestamp and the task it was left on. That is a decent trail of what you
// worked on even on a day you forgot to run a timer: nobody writes "v7
// attached, flagging the reflection" about a job they weren't touching.
//
// Two ways to turn that trail into time, because people comment differently:
//
//   "lead" — each comment claims the time since your previous comment on ANY
//            task, capped. Fits people who comment when a piece of work is
//            done ("render uploaded"): the work happened before the comment.
//   "span" — per task, first comment to last, plus a lead-in for the work
//            before the first. A long silence splits it into separate
//            stretches. Fits people who comment when they start and finish.
//
// Everything here is in minutes since local midnight, so it is independent of
// time zones and dates; the caller converts timestamps before calling in.

export const DAY_START_MIN = 9 * 60 + 30; // the first comment counts back to here
export const LEAD_CAP_MIN = 90; // no single comment claims more than this
export const SPAN_LEAD_IN_MIN = 20; // work before a task's first comment
export const SPAN_BREAK_MIN = 75; // a silence this long starts a new stretch

export const ESTIMATE_METHODS = ["lead", "span"];

/**
 * comments: [{ taskId, minute }] — minute = minutes since local midnight.
 * Returns { byTask: { [taskId]: minutes }, blocks: [{ taskId, from, to }] },
 * blocks being the stretches of the day each estimate covers, for drawing.
 */
export function estimateCommentTime(comments, method = "lead", { dayStart = DAY_START_MIN } = {}) {
  const sorted = [...comments]
    .filter((c) => c.taskId && Number.isFinite(c.minute))
    .sort((a, b) => a.minute - b.minute);
  const byTask = {};
  const blocks = [];
  const add = (taskId, from, to) => {
    if (to <= from) return;
    byTask[taskId] = (byTask[taskId] || 0) + (to - from);
    blocks.push({ taskId, from, to });
  };

  if (method === "span") {
    const perTask = {};
    for (const c of sorted) (perTask[c.taskId] ||= []).push(c.minute);
    for (const [taskId, mins] of Object.entries(perTask)) {
      let start = mins[0];
      let end = mins[0];
      for (let i = 1; i < mins.length; i++) {
        if (mins[i] - end > SPAN_BREAK_MIN) {
          add(taskId, start - SPAN_LEAD_IN_MIN, end);
          start = mins[i];
        }
        end = mins[i];
      }
      add(taskId, start - SPAN_LEAD_IN_MIN, end);
    }
    return { byTask, blocks };
  }

  // "lead". No floor on the gap: three comments fired off in the same minute
  // are one piece of work, not three. A task that only gets a moment still
  // shows up, because roundToQuarterHours never returns less than 0:15.
  let prev = dayStart;
  for (const c of sorted) {
    const claim = Math.min(LEAD_CAP_MIN, Math.max(0, c.minute - prev));
    // Zero-length claims still need to register the task, so it's listed.
    if (claim > 0) add(c.taskId, c.minute - claim, c.minute);
    else byTask[c.taskId] ||= 0;
    prev = Math.max(prev, c.minute);
  }
  return { byTask, blocks };
}

// Minutes → hours on the timesheet's 0.25 grid, never below one step: a task
// you commented on was worked on, however briefly. The bookmarklet still snaps
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
