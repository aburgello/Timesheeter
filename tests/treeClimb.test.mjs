import {
  buildChildToParents,
  getFilmName,
  getStudioName,
  getFolderCountries,
  jobFolderDescription,
  hydrateMissingFolders,
} from "../src/lib/wrikeEnrich.js";

// The enrich-path climbers walk UPWARD through a map inverted from Wrike's
// childIds. That map used to keep one parent per folder — the last one
// iterated — so a folder shared into several places had every climb follow a
// single arbitrary branch, arbitrary because the iteration order is just the
// order Wrike's /folders endpoint happened to page the rows in.
//
// These trees are the shape that actually went wrong in production: a job
// folder whose OWN name says nothing about the film ("XY025042_NM_Packshots"),
// shared into both a live campaign and somewhere else. Thirteen Job Book rows
// carrying XY0249xx–XY0251xx codes are filed under the film "Old", whose
// campaign ran three years before those codes were issued.

const F = (id, title, childIds = []) => ({ id, title, childIds });
const dict = (...folders) => Object.fromEntries(folders.map((f) => [f.id, f]));

// ── the map keeps every parent, not the last one written ────────────────────
{
  const d = dict(
    F("p_alpha", "Alpha", ["job"]),
    F("p_omega", "Omega", ["job"]),
  );
  const map = buildChildToParents(d);
  // [].concat() so a regression to the old scalar shape reports a clean FAIL
  // rather than throwing — a test that throws takes the whole suite with it.
  check("buildChildToParents keeps both parents of a shared folder",
    [].concat(map.job).sort(), ["p_alpha", "p_omega"]);
}

{
  // Same folder listed twice as a child — Wrike does this — must not duplicate.
  const d = dict(F("p", "P", ["job", "job"]));
  check("buildChildToParents does not duplicate a repeated childId",
    [].concat(buildChildToParents(d).job), ["p"]);
}

// ── the film is found when it sits on the branch the old map discarded ───────
//
// The job folder is shared into two DIGITAL folders: one under _Archive, one
// under the real film. Keeping a single parent could land on the archive
// branch, where the film name is excluded — so getFilmName found nothing and
// fell through to the task-title prefix. That fallback is visible in the data
// as timesheet rows reading "Pp3", "HOTB", "Sf" and "Tj4" instead of a film.
{
  // The ARCHIVE branch is listed LAST on purpose. Under the old last-writer-wins
  // map that made it the single parent kept for the job folder, so the climb
  // went up into _Archive, found a film name it is required to exclude, and
  // returned nothing.
  const d = dict(
    F("root", "UNIVERSAL", ["hamnet", "arch"]),
    F("hamnet", "Hamnet", ["d_ham"]),
    F("d_ham", "DIGITAL", ["job"]),
    F("arch", "_Archive", ["d_arch"]),
    F("d_arch", "DIGITAL", ["job"]),
    F("job", "XY025042_NM_Packshots_FinalWindow"),
  );
  const map = buildChildToParents(d);
  const task = { title: "HAM_NM_Packshots", parentIds: ["job"] };
  check("getFilmName reaches the film through the non-archive branch",
    getFilmName(task, d, "", {}, map), "Hamnet");
}

{
  // Determinism: the same tree built in the opposite insertion order must give
  // the same answer. Under a last-writer-wins map it did not, which is why the
  // same task could enrich differently on two runs against an unchanged tree.
  const forward = dict(
    F("root", "UNIVERSAL", ["old", "hamnet"]),
    F("old", "Old", ["d_old"]),
    F("d_old", "DIGITAL", ["job"]),
    F("hamnet", "Hamnet", ["d_ham"]),
    F("d_ham", "DIGITAL", ["job"]),
    F("job", "XY025042_NM_Packshots"),
  );
  const reversed = dict(...Object.values(forward).reverse());
  const task = { title: "X", parentIds: ["job"] };
  const a = getFilmName(task, forward, "", {}, buildChildToParents(forward));
  const b = getFilmName(task, reversed, "", {}, buildChildToParents(reversed));
  check("getFilmName is insertion-order independent", a === b, true);
}

// ── studio, market and description all reachable through any parent ──────────
{
  // The studio-less branch is listed LAST, so it is the one the old map kept.
  const d = dict(
    F("wb", "Warner Bros", ["campaign"]),
    F("campaign", "Campaign", ["job"]),
    F("nowhere", "Misc", ["job"]),          // a branch with no studio above it
    F("job", "XY025042_Packshots"),
  );
  const map = buildChildToParents(d);
  check("getStudioName finds a studio reachable only via the second parent",
    getStudioName({ parentIds: ["job"] }, d, map), "Warner");
}

{
  // The market-less branch is listed LAST, so it is the one the old map kept.
  const d = dict(
    F("mkt", "Germany", ["job"]),
    F("misc", "Assets", ["job"]),
    F("job", "XY025042_Packshots"),
  );
  const map = buildChildToParents(d);
  check("getFolderCountries finds the market folder on either branch",
    getFolderCountries({ parentIds: ["job"] }, d, map), ["Germany"]);
}

{
  // The job's own description lives in a folder named for its code, which may
  // sit on a different branch from the one a single-parent map picked.
  // The branch without the code folder is listed LAST, so the old map kept it.
  const d = dict(
    F("jobfolder", "XY025042_French_Canada_Assets", ["sub"]),
    F("misc", "Assets", ["sub"]),
    F("sub", "Working Files"),
  );
  const map = buildChildToParents(d);
  check("jobFolderDescription finds the code folder on either branch",
    jobFolderDescription({ parentIds: ["sub"] }, "XY025042", d, map),
    "French Canada Assets");
}

// ── a climb that finds nothing still finds nothing ──────────────────────────
{
  const d = dict(F("a", "Nothing", ["job"]), F("job", "XY025042_x"));
  const map = buildChildToParents(d);
  check("no studio in the tree still returns null",
    getStudioName({ parentIds: ["job"] }, d, map), null);
  check("no market in the tree still returns []",
    getFolderCountries({ parentIds: ["job"] }, d, map), []);
  check("a task with no parentIds is unchanged",
    getStudioName({ parentIds: [] }, d, map), null);
}

// ── an old-shape map (a bare parent id) is still understood ─────────────────
{
  // Defensive: a caller holding a cached single-parent map from before this
  // change must not crash the climb.
  const d = dict(F("wb", "Warner Bros", ["job"]), F("job", "XY0_x"));
  check("a scalar parent value is tolerated",
    getStudioName({ parentIds: ["job"] }, d, { job: "wb" }), "Warner");
}

// ── hydration reports whether the tree it built is actually whole ───────────
{
  // Wrike answers OK but without the folder asked for (deleted, or not shared
  // with this account). The dictionary is silently short one branch — which is
  // the case every climber used to read as if it were complete.
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [] }) });
  const fd = {};
  const r = await hydrateMissingFolders([{ parentIds: ["missing_1"] }], fd);
  check("hydration reports incomplete when a folder never arrives", r.complete, false);
  check("hydration names what is missing", r.unresolved, ["missing_1"]);
}

{
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ id: "present_1", title: "Found", parentIds: [] }] }),
  });
  const fd = {};
  const r = await hydrateMissingFolders([{ parentIds: ["present_1"] }], fd);
  check("hydration reports complete when everything arrives", r.complete, true);
  check("hydration still fills the dictionary in place", fd.present_1?.title, "Found");
}
