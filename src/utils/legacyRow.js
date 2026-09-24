import { parseTimeToSeconds, secondsToHM } from "./timeHelpers";

// Its own module (from hooks/useLegacyRows.js) so tests can reach it without
// loading the Supabase client.
// Normalise a legacy row on add/read — useTasks.fromDb already handles seconds↔hours.
// No rounding here, and none at export either: Supabase and the exported JSON both
// carry the exact pulled/entered time. The timesheet website's step size varies by
// job (UK-folder jobs take 0.25, INT jobs 0.5), so the bookmarklet snaps each row
// against that row's own dropdown — the only place the real grid is knowable.
export const normaliseLegacyRow = (row) => ({
  ...row,
  territory: row.territory || "",
  // Always H:MM ("none" for nothing), whatever shape it was stored or picked
  // in: a row picked as "0.5" before the dropdown went H:MM reads 0:30 too.
  timeSpent: secondsToHM(parseTimeToSeconds(row.timeSpent)),
  additionalTime: secondsToHM(parseTimeToSeconds(row.additionalTime)),
  // The seconds are what the group header and Copy Me! add up; the text is
  // what's shown, saved and totalled per day. They must always agree, so the
  // seconds are ALWAYS derived from the text, never taken from the row: a
  // Duplicate copies its source's seconds and then blanks the time, and
  // keeping those made a copy that showed "none" add its source's time to the
  // header and to the timesheet. Rows added by a pull, What did I work on? or
  // Merge had no add. time seconds at all, and counted none until a reload.
  rawSeconds: parseTimeToSeconds(row.timeSpent),
  additionalSeconds: parseTimeToSeconds(row.additionalTime),
  // Auto-derive project description from job number
  projectDescription: row.projectDescription ||
    (row.jobNumber?.includes(",") ? row.jobNumber.substring(row.jobNumber.indexOf(",") + 1).trim() : ""),
});
