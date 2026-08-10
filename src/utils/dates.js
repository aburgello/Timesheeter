// The one place that understands what a stored task date looks like.
//
// `tasks.date` is TEXT holding two shapes at once: "2026-01-05" from the CSV
// importer and "09/08/2026" from everything written in the app. Six separate
// parsers used to convert it back, each free to drift from the others. This
// replaces all of them.
//
// DAY FIRST, always. "09/08/2026" is 9 August. Checked against production:
// 234 of 497 slash rows carry a first component above 12, and not one row
// would be valid-but-different read month-first.
//
// Pure functions only — no React, no Supabase — so the Worker can import this
// and Node can test it without a browser.

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const UK_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/** Any stored shape → "YYYY-MM-DD". null when there is nothing usable. */
export function toIsoDate(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (ISO_RE.test(s)) return s;
  const uk = UK_RE.exec(s);
  if (!uk) return null;
  const [, d, m, y] = uk;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

/**
 * A Date → "YYYY-MM-DD" in LOCAL time.
 *
 * Not toISOString(): that is UTC, so an evening entry west of Greenwich lands
 * on tomorrow. The same bug was fixed in wrikeApi.logTimeToWrike.
 */
export function isoToday(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" → "DD/MM/YYYY" for display and for the legacy text column. */
export function isoToUk(iso) {
  const m = ISO_RE.exec(String(iso ?? "").trim());
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

/**
 * The value for the work_date column, given whatever shape a caller set on
 * `date`. Null rather than a guess: a row whose date we cannot read should be
 * visibly undated, not silently dated today.
 */
export const toDbDate = (value) => toIsoDate(value);

/**
 * "YYYY-MM-DD" (or an ISO datetime) → a Date at LOCAL midnight of that day.
 *
 * `new Date("2026-08-09")` is parsed as UTC midnight per the spec, so west of
 * Greenwich getDay() returns the previous weekday — a Saturday timelog lands in
 * Friday's column. Appending an explicit time forces local parsing. The Legacy
 * pull already did this inline; the Tracker pull did not.
 *
 * Returns null when there is no readable date, so callers can decide rather
 * than silently getting an Invalid Date.
 */
export function localDateFromIso(value) {
  const iso = toIsoDate(String(value ?? "").split(/[T\s]/)[0]);
  return iso ? new Date(`${iso}T00:00:00`) : null;
}

// Weekday name → JS getDay() index. Both day vocabularies in the app spell them
// out in full and start the week on Monday (constants.DAYS_OF_WEEK is Mon–Fri,
// legacyConstants.DAYS is Mon–Sun), so one map serves both.
const WEEKDAY_INDEX = {
  Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4,
  Friday: 5, Saturday: 6, Sunday: 0,
};

/**
 * The date of `dayName` within the Mon–Sun week containing `now`, as
 * "DD/MM/YYYY" — the shape the `date` column stores.
 *
 * Both timesheet surfaces let you pick which weekday you are logging against,
 * then stamped the row with TODAY regardless. A row could therefore say
 * dayOfWeek "Monday" and date Sunday, and since work_date is derived from
 * date, the grid grouped it under Monday while the week filter judged it by
 * Sunday — so backfilling Monday's hours on a Wednesday wrote Wednesday's date
 * onto a Monday row, and an entry made on Sunday for Monday dropped out of the
 * grid the moment the week rolled over.
 *
 * Monday-based to match getCurrentWeekStart, which is what the week filter
 * compares against. An unrecognised name falls back to today rather than
 * guessing a weekday.
 */
export function ukDateForWeekday(dayName, now = new Date()) {
  const target = WEEKDAY_INDEX[dayName];
  if (target === undefined) return isoToUk(isoToday(now));

  const monday = new Date(now);
  // Sunday (0) belongs to the week that started six days earlier, not the one
  // about to start — the same rule getCurrentWeekStart uses.
  monday.setDate(now.getDate() - (now.getDay() === 0 ? 6 : now.getDay() - 1));

  const d = new Date(monday);
  d.setDate(monday.getDate() + (target === 0 ? 6 : target - 1));
  return isoToUk(isoToday(d));
}
