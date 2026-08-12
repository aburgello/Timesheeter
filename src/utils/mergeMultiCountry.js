import { joinTerritories, splitTerritories } from "./territories";
import { secondsToHM } from "./timeHelpers";

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
