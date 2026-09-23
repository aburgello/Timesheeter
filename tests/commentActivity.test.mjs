import {
  estimateCommentTime,
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
const c = (time, taskId) => ({ taskId, minute: at(time) });

// A morning on two tasks, one comment when each piece of work is done.
const morning = [c("10:00", "a"), c("10:45", "a"), c("11:30", "b"), c("13:30", "b")];

const lead = estimateCommentTime(morning, "lead");
check("lead: first comment counts back to 09:30", lead.blocks[0], { taskId: "a", from: at("09:30"), to: at("10:00") });
check("lead: each comment claims the time since the one before", lead.byTask.a, 30 + 45);
check("lead: a long gap is capped at 90 min", lead.byTask.b, 45 + 90);

// Out of order in, same answer out: Wrike doesn't promise an order.
check("lead: input order doesn't matter", estimateCommentTime([...morning].reverse(), "lead").byTask, lead.byTask);

// Three comments in the same minute are one piece of work, not three.
const burst = estimateCommentTime([c("10:00", "a"), c("10:00", "a"), c("10:00", "a")], "lead");
check("lead: a burst isn't counted three times", burst.byTask.a, 30);

// A comment posted straight after another task's still lists its task.
const instant = estimateCommentTime([c("10:00", "a"), c("10:00", "b")], "lead");
check("lead: a zero-length task is still listed", Object.keys(instant.byTask).sort(), ["a", "b"]);
check("lead: and still gets one timesheet step", roundToQuarterHours(instant.byTask.b), 0.25);

// A comment before the working day doesn't claim negative time.
check("lead: early comment claims nothing", estimateCommentTime([c("08:40", "a")], "lead").byTask.a, 0);

const span = estimateCommentTime(morning, "span");
check("span: first to last plus a 20 min lead-in", span.byTask.a, 45 + 20);
check("span: a silence over 75 min splits the stretch", span.byTask.b, 20 + 20);
check("span: one block per stretch", span.blocks.filter((b) => b.taskId === "b").length, 2);

// Comments without a task (left on a folder) are skipped, not crashed on.
check("folder comments are ignored", estimateCommentTime([{ taskId: undefined, minute: 600 }], "lead").byTask, {});

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
