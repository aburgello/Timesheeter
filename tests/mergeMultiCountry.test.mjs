import { mergeMultiCountryRows } from "../src/utils/mergeMultiCountry.js";

// A pulled row, as handlePullTimes builds it before merging.
const row = (extra) => ({
  jobNumber: "Forgotten Island : XY026040, FID INTL DIGITAL Outdoor Campaign Markets",
  dayOfWeek: "Tuesday",
  category: "Digital - Production/Localisation",
  territory: "Denmark",
  client: "Universal Pictures International",
  filmTitle: "Forgotten Island",
  projectDescription: "FID INTL DIGITAL Outdoor Campaign Markets",
  notes: "",
  clientAmends: false,
  is3D: false,
  wrikeTimelogId: "1",
  _rawHours: 0.25,
  ...extra,
});

// The case from the Slack thread: 10 min Brazil + 15 min Denmark on one job.
const denmark = row({ territory: "Denmark", wrikeTimelogId: "1", _rawHours: 0.25 });
const brazil = row({ territory: "Brazil", wrikeTimelogId: "2", _rawHours: 10 / 60, taskId: "t2" });

const merged = mergeMultiCountryRows([denmark, brazil]);

check("two market rows become one", merged.length, 1);
check("both markets on the entry", merged[0].territory, "Denmark, Brazil");
check("time is the sum, not either half", merged[0].timeSpent, "0:25");
check("every timelog is kept", merged[0].wrikeTimelogId, "1,2");

// Rounding must happen once, on the total. Rounding each row first and adding
// the results is the bug this ordering exists to avoid: 2 min + 2 min is 4 min,
// not two rounded-up half hours.
const twoMinutes = mergeMultiCountryRows([
  row({ territory: "Spain", wrikeTimelogId: "3", _rawHours: 2 / 60 }),
  row({ territory: "Italy", wrikeTimelogId: "4", _rawHours: 2 / 60 }),
]);
check("summed before rounding", twoMinutes[0].timeSpent, "0:04");

// Rows that genuinely differ are not touched.
const differentCategory = mergeMultiCountryRows([
  denmark,
  row({ territory: "Brazil", category: "Print - Retouching", wrikeTimelogId: "5" }),
]);
check("a different category stays its own row", differentCategory.length, 2);

const differentDay = mergeMultiCountryRows([
  denmark,
  row({ territory: "Brazil", dayOfWeek: "Wednesday", wrikeTimelogId: "6" }),
]);
check("a different day stays its own row", differentDay.length, 2);

const differentJob = mergeMultiCountryRows([
  denmark,
  row({ territory: "Brazil", jobNumber: "Other : XY026041, Something", wrikeTimelogId: "7" }),
]);
check("a different job stays its own row", differentJob.length, 2);

// A flag on either constituent has to survive, or the merged entry under-bills.
const flagged = mergeMultiCountryRows([
  row({ territory: "Denmark", wrikeTimelogId: "8", clientAmends: false, is3D: false }),
  row({ territory: "Brazil", wrikeTimelogId: "9", clientAmends: true, is3D: true }),
]);
check("client amends survives from either row", flagged[0].clientAmends, true);
check("3D survives from either row", flagged[0].is3D, true);

// The same market twice (two logs, one territory) must not list it twice.
const sameMarket = mergeMultiCountryRows([
  row({ territory: "Denmark", wrikeTimelogId: "10", _rawHours: 0.5 }),
  row({ territory: "Denmark", wrikeTimelogId: "11", _rawHours: 0.5 }),
]);
check("a repeated market appears once", sameMarket[0].territory, "Denmark");
check("but its time still adds up", sameMarket[0].timeSpent, "1:00");

// Already-merged rows arrive carrying comma-joined ids from the per-task
// grouping upstream; the id list must stay flat so duplicate detection works.
const preJoined = mergeMultiCountryRows([
  row({ territory: "Denmark", wrikeTimelogId: "12,13" }),
  row({ territory: "Brazil", wrikeTimelogId: "14,15" }),
]);
check("comma-joined ids stay flat", preJoined[0].wrikeTimelogId, "12,13,14,15");

// The transient hours field must never reach the row that gets persisted.
check("_rawHours is stripped", "_rawHours" in merged[0], false);

// An empty description on the first row is filled from a later one rather than
// left blank.
const firstBlank = mergeMultiCountryRows([
  row({ territory: "Denmark", projectDescription: "", wrikeTimelogId: "16" }),
  row({ territory: "Brazil", projectDescription: "Outdoor Campaign", wrikeTimelogId: "17" }),
]);
check("a blank description is filled from the other row", firstBlank[0].projectDescription, "Outdoor Campaign");

// Nothing to merge is a no-op, not a crash.
check("empty input", mergeMultiCountryRows([]), []);
check("single row passes through", mergeMultiCountryRows([denmark]).length, 1);

// ── Merging rows by hand (the selection bar's Merge) ────────────────────────
import { mergeCheck, mergeRows } from "../src/utils/mergeMultiCountry.js";

// The case from the screenshot: XY026065, one row per market, 0:30 each,
// Philippines twice, notes naming each batch.
const sheet = (territory, notes, extra) => ({
  id: Math.random(),
  jobNumber: "Street Fighter : XY026065, INTL PRINT Outdoor Campaign Markets",
  dayOfWeek: "Wednesday",
  category: "Print - Project Management",
  territory,
  notes,
  client: "Paramount Pictures",
  filmTitle: "Street Fighter",
  projectDescription: "INTL PRINT Outdoor Campaign Markets",
  timeSpent: "0:30",
  additionalTime: "none",
  rawSeconds: 1800,
  clientAmends: false,
  is3D: false,
  ...extra,
});
const picked = [
  sheet("Portugal", "SF_Batch1_PT", { wrikeTimelogId: "L1", taskId: "T1" }),
  sheet("Belgium", "SF_Batch1_BE_FR", { wrikeTimelogId: "L2,L3", taskId: "T2" }),
  sheet("Peru", "SF_OOH_Peru - Batch 1", { wrikeTimelogId: "L4" }),
  sheet("Philippines", "SF_FOH_PH - Batch 3"),
  sheet("Norway", "SF_Batch1_NO"),
  sheet("Philippines", "SF_FOH_PH - Batch 2", { additionalTime: "0:15" }),
  sheet("Norway", "SF_Batch1_NO", { clientAmends: true }),
  sheet("Poland", "", { jobNumber: "XY026065" }),
];
const one = mergeRows(picked);

check("merge: rows on one job, day and category can merge", mergeCheck(picked), { ok: true });
check("merge: the bare code and the full job string are the same job", mergeCheck([picked[0], picked[7]]).ok, true);
check("merge: time is summed", one.timeSpent, "4:00");
check("merge: add. time is summed separately", one.additionalTime, "0:15");
check("merge: every market, once each", one.territory, "Portugal, Belgium, Peru, Philippines, Norway, Poland");
check("merge: every timelog is kept, so a pull won't re-add any", one.wrikeTimelogId, "L1,L2,L3,L4");
check("merge: distinct notes are joined", one.notes, "SF_Batch1_PT, SF_Batch1_BE_FR, SF_OOH_Peru - Batch 1, SF_FOH_PH - Batch 3, SF_Batch1_NO, SF_FOH_PH - Batch 2");
check("merge: a flag on any row survives", one.clientAmends, true);
check("merge: the first row's task link is kept", one.taskId, "T1");
check("merge: no id, and no stale seconds from the first row", ["id" in one, "rawSeconds" in one], [false, false]);
check("merge: no timelogs means none, not an empty string", mergeRows([picked[3], picked[4]]).wrikeTimelogId, null);
check("merge: no add. time reads none", mergeRows([picked[3], picked[4]]).additionalTime, "none");

check("merge: one row isn't a merge", mergeCheck([picked[0]]).ok, false);
check("merge: different jobs don't", mergeCheck([picked[0], sheet("Spain", "", { jobNumber: "XY026040" })]).reason, "These rows are on different jobs.");
check("merge: different categories don't", mergeCheck([picked[0], sheet("Spain", "", { category: "Print - Artwork" })]).reason, "These rows have different categories.");
check("merge: different days don't", mergeCheck([picked[0], sheet("Spain", "", { dayOfWeek: "Tuesday" })]).reason, "These rows are on different days.");
