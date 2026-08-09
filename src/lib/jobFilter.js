// =============================================================================
// src/lib/jobFilter.js
// -----------------------------------------------------------------------------
// The board's task-selection rules, in one place.
//
// These were inline in TodaysList.js. They are extracted here — unchanged —
// because the XYi Toolbox panel's "Active Jobs" card needs the SAME answer, and
// the alternative was a second copy in worker/index.js that would silently
// drift the first time the window or the stale threshold moved.
//
// Every function here is PURE and takes `now` as an argument rather than
// reading the clock, so both callers and tests get deterministic results.
// Behaviour is intentionally identical to what TodaysList.js did before the
// extraction; if you change a rule here, you change the board too — that is
// the point.
// =============================================================================

// Start of `now`'s day.
export function startOfDay(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

// The Today / Tomorrow / Next Week windows, exactly as handleAutoAssign built
// them.
//
// NOTE the "Today" case: minDate is the EPOCH, not this morning. "Today" means
// due today OR ALREADY OVERDUE — which is what makes the board show work that
// has slipped, and is the single most surprising rule in here.
export function timeframeRange(timeframe, now = new Date()) {
  const day = startOfDay(now);
  let minDate;
  let maxDate;
  if (timeframe === "Today") {
    minDate = new Date(0);
    maxDate = new Date(day);
    maxDate.setHours(23, 59, 59, 999);
  } else if (timeframe === "Tomorrow") {
    minDate = new Date(day);
    minDate.setDate(day.getDate() + 1);
    maxDate = new Date(minDate);
    maxDate.setHours(23, 59, 59, 999);
  } else {
    // Snap to the actual next Mon–Fri work week (matching the Timesheeter
    // tab's own Mon–Fri convention), not a rolling 7-day window — a fixed
    // +2..+8 offset drifts off the real calendar week depending on which
    // weekday "today" is, sometimes grabbing days still in *this* week
    // and cutting off days that are genuinely part of next week.
    const dayOfWeek = day.getDay(); // 0 = Sunday .. 6 = Saturday
    const daysUntilNextMonday = ((8 - dayOfWeek) % 7) || 7;
    minDate = new Date(day);
    minDate.setDate(day.getDate() + daysUntilNextMonday);
    maxDate = new Date(minDate);
    maxDate.setDate(minDate.getDate() + 4);
    maxDate.setHours(23, 59, 59, 999);
  }
  return { minDate, maxDate };
}

// A task earns a place on the board only if it is Active, carries a real due
// date, and that date falls inside the window. Mirrors the three guards at the
// top of handleAutoAssign's forEach.
export function isBoardTask(task, timeframe, now = new Date()) {
  if (!task) return false;
  if (task.status !== "Active") return false;
  if (!task.dueDate || task.dueDate === "No Due Date") return false;
  const taskDate = new Date(task.dueDate);
  if (isNaN(taskDate.getTime())) return false;
  const { minDate, maxDate } = timeframeRange(timeframe, now);
  if (taskDate < minDate || taskDate > maxDate) return false;
  return true;
}

// Overdue: due before the start of today.
export function isOverdue(dueDate, now = new Date()) {
  return !!dueDate && dueDate !== "No Due Date" && new Date(dueDate) < startOfDay(now);
}

// "Stale" tasks — overdue by more than a week — clutter the board long after
// they're actionable; hideStale lets a lane hide them without touching the
// underlying data or the Today/Tomorrow/Next Week window.
export function isStale(dueDate, now = new Date()) {
  const oneWeekAgo = startOfDay(now);
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  return !!dueDate && dueDate !== "No Due Date" && new Date(dueDate) < oneWeekAgo;
}
