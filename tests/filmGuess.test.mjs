import { resolveFilmName, filmFromTask, buildChildToParents } from "../src/lib/wrikeEnrich.js";
import { bookFilmTitle, guessFieldsFromTask } from "../src/utils/wrikeHelpers.js";

// Timesheet rows were saving task-name prefixes as films: "GMF_Quotes_Quad"
// logged against George Michael The Faith Tour came out as "Gmf", and FIL, EBZR
// and MRI the same (Sep 2026). A fake name that looks filled in is never
// corrected, so the name-prefix fallback must be reported as a blank.

const F = (id, title, childIds = []) => ({ id, title, childIds });
const dict = (...folders) => Object.fromEntries(folders.map((f) => [f.id, f]));

// ── the Wrike tree from the screenshot: Universal Australia › film › Print › job
{
  const d = dict(
    F("studio", "Universal Australia", ["film"]),
    F("film", "George Michael The Faith Tour", ["print"]),
    F("print", "Print", ["job"]),
    F("job", "XY026245_Quotes_Quad", []),
  );
  const task = { title: "GMF_Quotes_Quad_v1", parentIds: ["job"] };
  check("the folder climb names the film",
    resolveFilmName(task, d, "", {}, buildChildToParents(d)),
    { name: "George Michael The Faith Tour", source: "folder" });
}

{
  const task = { title: "GMF_Quotes_Quad_v1", parentIds: ["unknown"] };
  check("with no folder, the prefix fallback is labelled as such",
    resolveFilmName(task, {}, "", {}, {}), { name: "Gmf", source: "prefix" });
  check("a known code is not the prefix fallback",
    resolveFilmName({ title: "ODY_Teaser", parentIds: [] }, {}, "", {}, {}).source, "code");
}

// ── filmFromTask: blank for the guess, the name for everything else ──────────
check("prefix-sourced projectName is no film",
  filmFromTask({ title: "GMF_x", projectName: "Gmf", projectNameSource: "prefix" }), "");
check("folder-sourced projectName is kept",
  filmFromTask({ title: "GMF_x", projectName: "George Michael The Faith Tour", projectNameSource: "folder" }),
  "George Michael The Faith Tour");
check("a cached task from before the source existed is judged by shape",
  filmFromTask({ title: "EBZR_AUS_Outdoor", projectName: "Ebzr" }), "");
check("…and a real film on an old cached task survives",
  filmFromTask({ title: "EBZR_AUS_Outdoor", projectName: "Ebenezer" }), "Ebenezer");
check("Unknown Project is no film", filmFromTask({ title: "x", projectName: "Unknown Project" }), "");

// ── guessFieldsFromTask: a real job with no film is not "XYi Unbilled" ───────
{
  const g = guessFieldsFromTask({
    title: "MRI_INTL_Print_Payoff",
    projectName: "Mri",
    projectNameSource: "prefix",
    customFields: [{ id: "x", value: "XY026265" }],
  });
  check("an unresolved film on a job code stays blank", g.filmTitle, "");
  check("…and the job code is kept", g.jobNumber, "XY026265");
}
{
  const g = guessFieldsFromTask({ title: "Showreel edit", projectName: "", projectNameSource: "prefix" });
  check("no job and no film is still internal", g.filmTitle, "XYi Unbilled");
}
{
  const g = guessFieldsFromTask(
    { title: "GMF_Quotes", projectName: "Gmf", projectNameSource: "prefix", customFields: [{ id: "x", value: "XY026245" }] },
    [], "",
    () => ({ job_number: "George Michael The Faith Tour : XY026245, AUS - Quotes Quad", film_title: "George Michael The Faith Tour" }),
  );
  check("the Job Book fills the blank", g.filmTitle, "George Michael The Faith Tour");
}

// ── bookFilmTitle refuses what the book holds by mistake ─────────────────────
check("a book film is used", bookFilmTitle({ film_title: "Mr Irrelevant" }), "Mr Irrelevant");
check("'Old' (an archive folder) is refused", bookFilmTitle({ film_title: "Old" }), "");
check("a bare code is refused", bookFilmTitle({ film_title: "ZAL" }), "");
check("mixed-case short titles are kept", bookFilmTitle({ film_title: "EPiC" }), "EPiC");
check("no job, no film", bookFilmTitle(null), "");
