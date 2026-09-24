import {
  estimateFromActivity,
  activityToEvents,
  roundToQuarterHours,
  hoursLoggedFor,
  jobCode,
  dayRangeUtc,
} from "../src/utils/commentActivity.js";
import { parseTimeToHours } from "../src/utils/timeHelpers.js";

const at = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const start = (time, taskId, cue = "status") => ({ taskId, minute: at(time), kind: "start", cue });
const mine = (time, taskId) => ({ taskId, minute: at(time), kind: "mine" });
const stop = (time, taskId) => ({ taskId, minute: at(time), kind: "stop" });
const est = (events, opts) => estimateFromActivity(events, opts).byTask;

// The case this exists for: handed the task, no comment until it's sent.
check("assigned, then sent for review: the whole stretch counts", est([start("10:00", "a", "assigned"), mine("12:30", "a")]).a, 150);
check("a hand-off before the working day counts from 09:30", est([start("08:15", "a"), mine("11:30", "a")]).a, 120);

// Two tasks moved to Motion at once share the time they overlap.
const shared = est([start("10:00", "a"), start("10:00", "b"), mine("11:00", "a"), mine("12:00", "b")]);
check("overlap is split evenly", shared, { a: 30, b: 30 + 60 });

// With no hand-off that day, a comment reaches back to the last one, else 09:30.
check("comment with no cue counts back to 09:30", est([mine("10:30", "a")]).a, 60);
check("...and a second one back to the first", est([mine("10:00", "a"), mine("11:00", "a")]).a, 30 + 60);

// Someone moving it on after you've delivered is the review step, not a start.
check("a status change after your comment isn't a new start", est([start("09:30", "a"), mine("11:00", "a"), start("11:05", "a")]).a, 90);
// ...but being assigned again is.
check("being re-assigned after your comment is", est([mine("11:00", "a"), start("16:00", "a", "assigned")]).a, 90 + 120);

check("a hand-off with nothing after runs to 18:00", est([start("16:00", "a")]).a, 120);
check("...or to now, on today", est([start("13:00", "a", "assigned")], { dayEnd: at("14:00") }).a, 60);
check("closed by someone else ends the stretch", est([start("10:00", "a"), stop("11:00", "a")]).a, 60);
check("a close is an event too: your next action counts from it", est([stop("11:00", "a"), mine("12:00", "a")]).a, 60);

// Your action answers the LATEST thing that happened on the task, not the
// first: moved to Motion at 10:02, on to Prep at 10:30, you reply at 10:35.
const other = (time, taskId) => ({ taskId, minute: at(time), kind: "other" });
check("latest: a later status change starts the stretch", est([start("10:02", "a"), start("10:30", "a"), mine("10:35", "a")]).a, 5);
check("latest: so does someone else's comment", est([start("10:00", "a"), other("11:00", "a"), mine("11:40", "a")]).a, 40);
check("latest: and your own previous action", est([start("10:00", "a"), mine("10:30", "a"), mine("11:00", "a")]).a, 60);
check("latest: someone's change in the same minute as your comment is a reaction to it, not its start", est([start("10:35", "a"), mine("10:35", "a")]).a, 65);
check("latest: someone else's comment alone isn't a hand-off", est([other("16:00", "a")]).a, 0);

const busy = est([start("09:30", "a", "assigned"), start("09:30", "b", "assigned"), start("09:30", "c", "assigned")]);
check("the day never adds up to more than it had", Object.values(busy).reduce((s, m) => s + m, 0), at("18:00") - at("09:30"));

check("a task whose only event is before 09:30 is still listed", est([mine("08:40", "a")]), { a: 0 });

// Past 18:00. Your own action proves you were working, so it isn't cut off,
// and whatever falls after 18:00 is reported as overtime.
const ot = (events, opts) => estimateFromActivity(events, opts).overtimeByTask;
const late = [start("17:00", "a"), mine("20:15", "a")];
check("late: a stretch you close runs to your action", est(late).a, 195);
check("late: the part after 18:00 is overtime", ot(late).a, 135);
check("late: comment-only day runs from 09:30 to it", [est([mine("19:30", "a")]).a, ot([mine("19:30", "a")]).a], [600, 90]);
check("late: overtime is split like the rest", ot([start("17:00", "a"), start("17:00", "b"), mine("19:00", "a"), mine("19:00", "b")]), { a: 30, b: 30 });
check("late: nothing before 18:00 is overtime", ot([start("10:00", "a"), mine("12:00", "a")]).a, 0);

// A stretch nobody closed still stops at 18:00, so a late hand-off isn't
// read as a night's work.
check("unclosed: a hand-off after 18:00 claims nothing", est([start("18:30", "a", "assigned")]).a, 0);
check("unclosed: closed by someone else after 18:00 stops at 18:00", est([start("17:00", "a"), stop("19:00", "a")]).a, 60);

// Before 09:30: only when your action is early too, and never before 07:00.
check("early: hand-off and comment both before 09:30 count as they happened", est([start("08:00", "a", "assigned"), mine("08:50", "a")]).a, 50);
check("early: an overnight hand-off is floored at 07:00", est([start("05:00", "a"), mine("08:00", "a")]).a, 60);
check("early: a hand-off before 09:30 closed later still counts from 09:30", est([start("07:00", "a"), mine("10:00", "a")]).a, 30);

// Raw activity → events.
const iso = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(2026, 8, 23, h, m).toISOString();
};
const row = (time, taskId, event_type, extra = {}) => ({ task_id: taskId, event_type, occurred_at: iso(time), ...extra });
const events = activityToEvents({
  me: "ME",
  comments: [{ taskId: "t1", createdDate: iso("12:00") }, { taskId: null, createdDate: iso("12:05") }],
  others: [{ taskId: "t1", createdDate: iso("11:30") }],
  activity: [
    row("09:00", "t1", "TaskResponsiblesAdded", { user_ids: ["ME", "OTHER"], author_id: "PROD" }),
    row("09:05", "t2", "TaskResponsiblesAdded", { user_ids: ["OTHER"], author_id: "PROD" }),
    row("10:00", "t3", "TaskStatusChanged", { author_id: "PROD", custom_status_id: "MOTION" }),
    row("10:10", "t4", "TaskStatusChanged", { author_id: "PROD", custom_status_id: "MOTION" }),
    row("16:00", "t3", "TaskStatusChanged", { author_id: "PROD", custom_status_id: "DONE" }),
    row("16:30", "t3", "TaskStatusChanged", { author_id: "PROD", custom_status_id: "NOT_LOADED" }),
    row("15:00", "t1", "TaskStatusChanged", { author_id: "ME", custom_status_id: "REVIEW" }),
    row("17:00", "t5", "TaskResponsiblesRemoved", { user_ids: ["ME"], author_id: "PROD" }),
  ],
  isMyTask: (id) => ["t1", "t3"].includes(id),
  statusGroup: (id) => ({ MOTION: "Active", REVIEW: "Active", DONE: "Completed" })[id],
});
const brief = events.map((e) => `${e.taskId} ${e.kind}${e.cue ? `/${e.cue}` : ""}`).sort();
check("activity becomes events", brief, [
  "t1 mine", // comment
  "t1 mine", // status change made by me
  "t1 other", // someone else's comment
  "t1 start/assigned",
  "t3 other", // a status whose group isn't known: an event, never a hand-off
  "t3 start/status", // moved to Motion by someone else, my task
  "t3 stop", // moved to a Completed status by someone else
  "t5 stop", // I was taken off it
]);

check("rounds to the nearest quarter hour", roundToQuarterHours(80), 1.25);
check("never below one step", roundToQuarterHours(3), 0.25);

check("job code from a canonical job string", jobCode("Forgotten Island : XY026040, FID INTL"), "XY026040");
check("no job code", jobCode("Internal admin"), "");

const dayRows = [
  { taskId: "a", jobNumber: "Film : XY026040, Print", timeSpent: "1:00", additionalTime: "none" },
  { taskId: null, jobNumber: "XY026041", timeSpent: "0.5", additionalTime: "0:15" },
  { taskId: "z", jobNumber: "XY026041", timeSpent: "2:00", additionalTime: "none" },
];
check("logged: matched by task first", hoursLoggedFor(dayRows, { taskId: "a", jobNumber: "XY026041" }, parseTimeToHours), { hours: 1, regular: 1, extra: 0, match: "task" });
check("logged: hand-typed rows match on the job code, per column", hoursLoggedFor(dayRows, { taskId: "b", jobNumber: "Other : XY026041, x" }, parseTimeToHours), { hours: 0.75, regular: 0.5, extra: 0.25, match: "job" });
// The case from the screenshot: four tasks on XY026205, one per market, and
// hand-typed rows per market. Each task gets its own market's time, not 3:00.
const sf = [
  { taskId: null, jobNumber: "XY026205", territory: "Czech", timeSpent: "0:30", additionalTime: "none" },
  { taskId: null, jobNumber: "XY026205", territory: "Austria", timeSpent: "1:00", additionalTime: "none" },
  { taskId: null, jobNumber: "XY026205", territory: "Indonesia", timeSpent: "1:00", additionalTime: "none" },
  { taskId: null, jobNumber: "XY026205", territory: "Cyprus, Croatia, Sweden, Czech", timeSpent: "0:30", additionalTime: "none" },
];
const forMarket = (territory) => hoursLoggedFor(sf, { taskId: "t", jobNumber: "Street Fighter : XY026205, INT", territory }, parseTimeToHours);
check("logged: only this task's market", forMarket("Indonesia"), { hours: 1, regular: 1, extra: 0, match: "market" });
check("logged: a multi-market row counts for each of its markets", forMarket("Sweden").hours, 0.5);
check("logged: a market in two rows gets both", forMarket("Czech").hours, 1);
check("logged: a market with nothing logged is nothing", forMarket("Brazil"), { hours: 0, regular: 0, extra: 0, match: "" });
check("logged: markets match regardless of case", forMarket("indonesia").hours, 1);
// The Czech task resolves to "Czech Republic"; the rows say "Czech". Same
// checkbox on the timesheet, so the same market.
check("logged: Czech Republic matches Czech", forMarket("Czech Republic").hours, 1);
check("logged: ...and the other way round", hoursLoggedFor(
  [{ taskId: null, jobNumber: "XY026205", territory: "Czech Republic", timeSpent: "0:45", additionalTime: "none" }],
  { taskId: "t", jobNumber: "XY026205", territory: "Czech" }, parseTimeToHours).hours, 0.75);
// Codes and aliases go through the same resolver Wrike Pull uses first.
const czRow = [{ taskId: null, jobNumber: "XY026205", territory: "Czech", timeSpent: "0:30", additionalTime: "none" }];
check("logged: an alias (Czechia) matches too", hoursLoggedFor(czRow, { taskId: "t", jobNumber: "XY026205", territory: "Czechia" }, parseTimeToHours).hours, 0.5);
check("logged: Canada - French matches Canadian-French", hoursLoggedFor(
  [{ taskId: null, jobNumber: "XY026205", territory: "Canadian-French", timeSpent: "0:30", additionalTime: "none" }],
  { taskId: "t", jobNumber: "XY026205", territory: "Canada - French" }, parseTimeToHours).hours, 0.5);
// Markets that share a code but are separate timesheet choices stay apart.
check("logged: India language markets aren't merged", hoursLoggedFor(
  [{ taskId: null, jobNumber: "XY026205", territory: "India - Tamil", timeSpent: "1:00", additionalTime: "none" }],
  { taskId: "t", jobNumber: "XY026205", territory: "India - Hindi" }, parseTimeToHours).hours, 0);
check("logged: a task with no market falls back to the whole job", forMarket("").hours, 3);
check("logged: nothing on the timesheets", hoursLoggedFor(dayRows, { taskId: "q", jobNumber: "XY099999" }, parseTimeToHours), { hours: 0, regular: 0, extra: 0, match: "" });

const range = dayRangeUtc(new Date(2026, 8, 23, 15, 12));
check("day range has no milliseconds", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(range.start), true);
check("day range is 24 hours", (new Date(range.end) - new Date(range.start)) / 3600000, 24);
