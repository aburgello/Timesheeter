import { joinTerritories, splitTerritories } from "./territories";
import { secondsToHM, parseTimeToSeconds } from "./timeHelpers";

// Merge pulled rows that describe the same work in different markets into one
// entry covering every market.
//
// Wrike models a localisation campaign as one task per market, so half an hour
// spread over Denmark and Brazil arrives as two tasks, two timelogs, and — once
// the pull has grouped by task — two rows. For people who do a little work
// across many territories that is a page of near-identical rows to tidy by hand
// before submitting, which is what this exists to remove.
//
// WHAT COUNTS AS "THE SAME WORK": same job number, same day, same category.
// Territory is deliberately excluded (it is the thing being merged) and so is
// taskId (different markets ARE different tasks — that is the whole point).
// Everything else that varies between two otherwise-matching rows is a genuine
// difference and the rows are left alone.
//
// THIS IS LOSSY, WHICH IS WHY IT IS OPT-IN. 2h on Brazil and 30m on Denmark
// becomes 2.5h across "Brazil, Denmark" — the split is not recoverable from the
// merged row's own fields, and the company timesheet bills the whole block
// against both markets. The merged row does keep every constituent timelog id
// in wrikeTimelogId, so the merge can at least be traced back to the individual
// Wrike logs it came from.
// Pull-time merging now shares the manual Merge's rules (mergeCheck / mergeRows
// below), which it didn't: it keyed on the job number as TEXT, so one market
// resolved to the bare "XY026066" and another to "Street Fighter : XY026066,
// …" stayed apart though the grid shows both the same. And it only merged
// within a single pull, so pulling twice in a day, or turning the setting on
// after a pull, left one row per market. See mergeIntoSheet.
export function mergeMultiCountryRows(rows) {
  return mergeIntoSheet(rows, []).rows;
}

/**
 * Merge newly pulled rows with each other AND with rows already on the sheet
 * for the same day, job (by XY code) and category, as Merge in the selection
 * bar would. Returns { rows, replaces }: the rows to add, and the ids of sheet
 * rows they replace, to be deleted once the new rows have saved.
 */
export function mergeIntoSheet(newRows, sheetRows = []) {
  const groups = new Map();
  const keyOf = (r) => [r.dayOfWeek || "", rowJob(r), r.category || ""].join("\u0000");
  for (const r of newRows) {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, { sheet: [], pulled: [] });
    groups.get(k).pulled.push(r);
  }
  for (const r of sheetRows) groups.get(keyOf(r))?.sheet.push(r);

  const rows = [];
  const replaces = [];
  for (const { sheet, pulled } of groups.values()) {
    if (sheet.length + pulled.length === 1) {
      const { _rawHours, ...only } = pulled[0];
      rows.push(only);
      continue;
    }
    // What's on the sheet first, so the merged entry keeps its task link and
    // its notes lead.
    rows.push({ ...mergeRows([...sheet, ...pulled]), id: pulled[0].id });
    replaces.push(...sheet.map((r) => r.id));
  }
  return { rows, replaces };
}

// ── Merging rows by hand ─────────────────────────────────────────────────────
// Legacy's selection bar: tick rows already on the sheet, press Merge, get one
// entry. The same idea as the pull-time merge above, for rows that arrived
// separately (merge was off, or they were added by hand).
//
// What may merge is the same rule: one job, one day, one category. Anything
// else is two pieces of work, and merging them would bill one against the
// other's job or category.

// The job a row is on. By XY code where there is one, so a bare "XY026065" and
// the canonical "Street Fighter : XY026065, INTL PRINT…" are the same job.
const rowJob = (r) =>
  ((r.jobNumber || "").match(/XY\d{5,6}/i)?.[0] || (r.jobNumber || "").trim()).toUpperCase();

/** { ok: true } or { ok: false, reason } — the reason reads as a sentence. */
export function mergeCheck(rows) {
  if (!rows || rows.length < 2) return { ok: false, reason: "Select at least two rows to merge." };
  const differ = (key) => new Set(rows.map(key)).size > 1;
  if (differ((r) => r.dayOfWeek || "")) return { ok: false, reason: "These rows are on different days." };
  if (differ(rowJob)) return { ok: false, reason: "These rows are on different jobs." };
  if (differ((r) => r.category || "")) return { ok: false, reason: "These rows have different categories." };
  return { ok: true };
}

/**
 * The single entry `rows` become. Times are summed, per column, from the
 * stored "H:MM" values. Returns the row without an id; the caller adds one.
 *
 *   territory       every market, de-duplicated, in the order they appear
 *   wrikeTimelogId  every timelog behind any of them, so the next pull still
 *                   recognises all of it and adds nothing twice
 *   notes           the distinct notes, joined ("SF_Batch1_PT, SF_Batch1_NO")
 *   description,
 *   client, film    the first that has one
 *   clientAmends,
 *   is3D            kept if any row had it
 *   taskId          the first row's: the link back to Wrike can only be one
 */
export function mergeRows(rows) {
  const [first] = rows;
  const firstOf = (key) => rows.map((r) => r[key]).find((v) => v) || "";
  // A freshly pulled row carries its unrounded hours; summing those before
  // formatting keeps two 20-second logs from adding up to nothing.
  const seconds = (key) =>
    rows.reduce(
      (s, r) => s + (key === "timeSpent" && r._rawHours != null ? r._rawHours * 3600 : parseTimeToSeconds(r[key])),
      0
    );
  const ids = [
    ...new Set(
      rows
        .map((r) => r.wrikeTimelogId)
        .filter(Boolean)
        .join(",")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ];
  const notes = [...new Set(rows.map((r) => (r.notes || "").trim()).filter(Boolean))];
  // The first row's own time in seconds would ride along and be read back
  // as the merged row's time; dropped so it's derived from the new totals.
  const { id: _id, rawSeconds: _raw, additionalSeconds: _extra, _rawHours: _unrounded, ...base } = first;
  return {
    ...base,
    territory: joinTerritories(rows.flatMap((r) => splitTerritories(r.territory)).join(", ")),
    timeSpent: secondsToHM(seconds("timeSpent")),
    additionalTime: secondsToHM(seconds("additionalTime")),
    wrikeTimelogId: ids.length ? ids.join(",") : null,
    notes: notes.join(", "),
    projectDescription: firstOf("projectDescription"),
    client: firstOf("client"),
    filmTitle: firstOf("filmTitle"),
    clientAmends: rows.some((r) => r.clientAmends),
    is3D: rows.some((r) => r.is3D),
  };
}
