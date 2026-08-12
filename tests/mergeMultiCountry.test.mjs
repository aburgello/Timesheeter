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
