// ── The one place time is parsed and formatted ───────────────────────────────
// Tracker and Legacy both keep time in two shapes: seconds in memory
// (`rawSeconds`/`additionalSeconds`) and an "H:MM" string in Supabase
// (`time_spent`/`additional_time`). Everything that converts between the two
// goes through the two functions below, so the two surfaces can't drift.
//
// They did drift, three ways, and each cost real logged hours:
//   • A bare integer ("2", which the 0.25-step dropdown writes for whole
//     hours) was read as MINUTES on the DB path and as HOURS on the day-total
//     path — the same row showed 2:00 in one place and 0:02 in another, and
//     the bookmarklet got 120 seconds.
//   • Tracker fell back to parseFloat(timeSpent), which truncates "2:30" at
//     the colon and silently loses the minutes.
//   • Two different functions were both called getTimesheetValue — one took
//     seconds and returned "2.5", the other took hours and returned "2:30".

// Parse any stored/entered time into seconds. Accepts "H:MM" ("2:30"), decimal
// hours ("0.25", "1.5"), whole hours ("2" — the dropdown never writes "2.0"),
// and the empty forms ("none", "", null). A bare number is always HOURS: no
// caller in this app has ever meant minutes by it, and every stored bare
// integer is 1–8, a working day.
export const parseTimeToSeconds = (value) => {
  if (value === null || value === undefined) return 0;
  const s = String(value).trim();
  if (!s || s === "none") return 0;

  const hm = s.match(/^(\d+):(\d{1,2})$/);
  if (hm) return (Number(hm[1]) * 60 + Number(hm[2])) * 60;

  const n = parseFloat(s);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 3600);
};

// Same parse, expressed in hours — for the day/week totals that add up in hours.
export const parseTimeToHours = (value) => parseTimeToSeconds(value) / 3600;

// Seconds → the "H:MM" string both Supabase and the grid use. `zero` is what an
// empty duration looks like to the caller: Supabase wants null (so the column
// is empty), the grid wants "none" (its dropdown's empty option), a running
// total wants "0:00".
export const secondsToHM = (totalSeconds, zero = "none") => {
  if (!(totalSeconds > 0)) return zero;
  const mins = Math.round(totalSeconds / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
};

export const formatTimerDisplay = (totalSeconds) => {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (num) => num.toString().padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
};

export const formatDurationText = (totalSeconds) => {
  if (totalSeconds === 0) return "0s";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  let parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
};

// Decimal hours for the "this is what goes on the timesheet" readouts in
// Tracker's History/Analytics tabs — display only, exact to 2dp. Nothing is
// rounded to a grid here: the site decides granularity per job (UK-folder jobs
// take 0.25 steps, INT jobs 0.5), so the bookmarklet snaps each row to its own
// dropdown. "none" mirrors the site's own empty option.
export const getTimesheetValue = (totalSeconds) => {
  if (!totalSeconds || totalSeconds <= 0) return "none";
  return String(Math.round((totalSeconds / 3600) * 100) / 100);
};
