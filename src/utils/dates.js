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
