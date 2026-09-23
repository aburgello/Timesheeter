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
check("a stop with nothing open is ignored", est([stop("11:00", "a"), mine("12:00", "a")]).a, 150);

const busy = est([start("09:30", "a", "assigned"), start("09:30", "b", "assigned"), start("09:30", "c", "assigned")]);
check("the day never adds up to more than it had", Object.values(busy).reduce((s, m) => s + m, 0), at("18:00") - at("09:30"));

check("a task whose only event is before 09:30 is still listed", est([mine("08:40", "a")]), { a: 0 });

// Raw activity → events.
const iso = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(2026, 8, 23, h, m).toISOString();
};
const row = (time, taskId, event_type, extra = {}) => ({ task_id: taskId, event_type, occurred_at: iso(time), ...extra });
const events = activityToEvents({
  me: "ME",
  comments: [{ taskId: "t1", createdDate: iso("12:00") }, { taskId: null, createdDate: iso("12:05") }],
  activity: [
    row("09:00", "t1", "TaskResponsiblesAdded", { user_ids: ["ME", "OTHER"], author_id: "PROD" }),
    row("09:05", "t2", "TaskResponsiblesAdded", { user_ids: ["OTHER"], author_id: "PROD" }),
    row("10:00", "t3", "TaskStatusChanged", { author_id: "PROD", custom_status_id: "MOTION" }),
    row("10:10", "t4", "TaskStatusChanged", { author_id: "PROD", custom_status_id: "MOTION" }),
    row("16:00", "t3", "TaskStatusChanged", { author_id: "PROD", custom_status_id: "DONE" }),
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
  "t1 start/assigned",
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
check("logged: matched by task first", hoursLoggedFor(dayRows, { taskId: "a", jobNumber: "XY026041" }, parseTimeToHours), { hours: 1, match: "task" });
check("logged: hand-typed rows match on the job code", hoursLoggedFor(dayRows, { taskId: "b", jobNumber: "Other : XY026041, x" }, parseTimeToHours), { hours: 0.75, match: "job" });
check("logged: nothing on Legacy", hoursLoggedFor(dayRows, { taskId: "q", jobNumber: "XY099999" }, parseTimeToHours), { hours: 0, match: "" });

const range = dayRangeUtc(new Date(2026, 8, 23, 15, 12));
check("day range has no milliseconds", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(range.start), true);
check("day range is 24 hours", (new Date(range.end) - new Date(range.start)) / 3600000, 24);
