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
const mergeKey = (r) =>
  [r.jobNumber || "", r.dayOfWeek || "", r.category || ""].join("");

export function mergeMultiCountryRows(rows) {
  const byKey = new Map();

  for (const row of rows) {
    const key = mergeKey(row);
    const existing = byKey.get(key);

    if (!existing) {
      // Clone so the caller's array is never mutated, and so _rawHours can be
      // accumulated on our copy.
      //
      // The first row's taskId is the one the merged entry keeps. There is no
      // better answer — the markets ARE different Wrike tasks — and taskId is
      // only ever a convenience link back to Wrike, never a key anything
      // matches on. Duplicate detection on the next pull runs off
      // wrikeTimelogId, which keeps every constituent id below.
      byKey.set(key, { ...row });
      continue;
    }

    // Sum the RAW hours and format once at the end. Rounding each row first and
    // adding the results is what turns 2×2-minute logs into a full hour — the
    // same trap the per-task grouping upstream already avoids.
    existing._rawHours = (existing._rawHours || 0) + (row._rawHours || 0);

    existing.territory = joinTerritories(
      [...splitTerritories(existing.territory), ...splitTerritories(row.territory)].join(", ")
    );

    // Provenance: every timelog that fed the merged row, so nothing about where
    // the time came from is lost. Both sides may already be comma-joined lists
    // from the per-task grouping upstream, and fetchExistingTimelogIds splits on
    // the comma, so a merged row still de-duplicates correctly on the next pull.
    const ids = new Set(
      [existing.wrikeTimelogId, row.wrikeTimelogId]
        .filter(Boolean)
        .join(",")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
    existing.wrikeTimelogId = [...ids].join(",");

    // Prose fields: keep the first non-empty rather than concatenating. Merged
    // market rows carry near-identical descriptions ("FID INTL DIGITAL Outdoor
    // Campaign Markets" on every one), so joining them would produce a wall of
    // repeated text in a cell the member then has to clean up by hand.
    if (!existing.projectDescription) existing.projectDescription = row.projectDescription;
    if (!existing.notes) existing.notes = row.notes;
    if (!existing.client) existing.client = row.client;
    if (!existing.filmTitle) existing.filmTitle = row.filmTitle;

    // A flag set on ANY constituent row survives the merge — dropping a
    // client-amends or 3D marker because it was only on the second market would
    // under-bill the entry.
    existing.clientAmends = existing.clientAmends || row.clientAmends;
    existing.is3D = existing.is3D || row.is3D;
  }

  return [...byKey.values()].map(({ _rawHours, ...row }) => ({
    ...row,
    timeSpent: secondsToHM((_rawHours || 0) * 3600),
  }));
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
  const seconds = (key) => rows.reduce((s, r) => s + parseTimeToSeconds(r[key]), 0);
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
  const { id: _id, rawSeconds: _raw, additionalSeconds: _extra, ...base } = first;
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
