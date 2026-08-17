import { categoryFamilyFromText, categoryForFamily, defaultCategoryForTask, categoryFamilyForTask, familyFromFolderName } from "../src/utils/categoryFamily.js";
import { getFolderFamily, buildChildToParents } from "../src/lib/wrikeEnrich.js";

// Real paths from the studio's own rows.
const PRINT_PATH = "TAD_Masters_Chile Studio/Paramount/Tad/Print/INTL/XY025832_INTL_PRINT_Outdoor_Campaign_Markets";
const DIGITAL_PATH = "COBAB_Digital_Character_Poster_MX Studio/Paramount/XY025900_INTL_DIGITAL_Character_Posters";

check("a print folder says Print", categoryFamilyFromText(PRINT_PATH), "Print");
check("a digital folder says Digital", categoryFamilyFromText(DIGITAL_PATH), "Digital");

// Neither word, or both, is no answer — never a coin flip. A digital task whose
// brief mentions print-ready files says both things, and choosing between them
// would be worse than leaving the member's own default alone.
check("neither word is no answer", categoryFamilyFromText("FID - FR - METROBUS DOOH - Batch 1"), "");
check("both words is no answer", categoryFamilyFromText("DIGITAL asset, print-ready"), "");
check("empty text", categoryFamilyFromText(""), "");
check("null", categoryFamilyFromText(null), "");

// The point of the whole thing: one stored default covers both halves of a pair.
check("print default on a digital job", categoryForFamily("Print - Proofreading", "Digital"), "Digital - Proofreading");
check("digital default on a print job", categoryForFamily("Digital - Proofreading", "Print"), "Print - Proofreading");
check("already the right family", categoryForFamily("Print - Proofreading", "Print"), "Print - Proofreading");

// It only ever moves ACROSS a pair — it must never change the discipline.
check("retouching stays retouching", categoryForFamily("Print - Retouching", "Digital"), "Digital - Retouching");
check(
  "production/localisation pairs too",
  categoryForFamily("Digital - Production/Localisation", "Print"),
  "Print - Production/Localisation"
);

// No counterpart: inventing one would put a category on the row that the
// company timesheet has no checkbox for.
check(
  "a print-only category is left alone",
  categoryForFamily("Print - RGB - CMYK Conversion", "Digital"),
  "Print - RGB - CMYK Conversion"
);
check("an unpaired category is left alone", categoryForFamily("Watermarking", "Print"), "Watermarking");
check("a digital-only category is left alone", categoryForFamily("Digital - Instagram", "Print"), "Digital - Instagram");

// No evidence means the member's own choice stands, untouched.
check("no family, no change", categoryForFamily("Print - Proofreading", ""), "Print - Proofreading");
check("no default set", categoryForFamily(null, "Print"), null);

// End to end, as the pull calls it.
check(
  "Daisy's default on a print job",
  defaultCategoryForTask("Print - Proofreading", PRINT_PATH),
  "Print - Proofreading"
);
check(
  "Daisy's default on a digital job",
  defaultCategoryForTask("Print - Proofreading", DIGITAL_PATH),
  "Digital - Proofreading"
);
check(
  "Daisy's default where the job says neither",
  defaultCategoryForTask("Print - Proofreading", "FID - FR - METROBUS DOOH - Batch 1"),
  "Print - Proofreading"
);

// ---------------------------------------------------------------------------
// Whole tokens, not substrings
// ---------------------------------------------------------------------------
// The reported row: "PP3 - AUS - DOOH - Batch 1 TMRW" under
// Paw_Patrol_The_Dino_Movie > Digital > INTL > XY026036_AUS_DOOH_Campaign came
// through as Print. The task carries no /Volumes path, so the text said
// nothing, Daisy's stored "Print - Proofreading" passed through untouched, and
// the folder named Digital two levels up was never consulted.
//
// First half of the fix: the text read is anchored to whole tokens. Every one
// of these used to answer, and every answer was wrong.
check("a sprint is not a print job", categoryFamilyFromText("Sprint 4"), "");
check("nor is a blueprint", categoryFamilyFromText("Sample Blueprints"), "");
check("Printworks is a venue", categoryFamilyFromText("XY025979_Manchester_Printworks_IMAX"), "");
check("printed is not Print", categoryFamilyFromText("XY024919_Showcase_ICEE_Printed"), "");
check("EventDigitalScreens is not Digital", categoryFamilyFromText("XY025286_EventDigitalScreens"), "");

// The input that genuinely carries the word still works: a /Volumes path
// delimits it with slashes, which is why the split is on non-alphanumerics.
check("a slash-delimited path still reads", categoryFamilyFromText(PRINT_PATH), "Print");
check("and the digital one", categoryFamilyFromText(DIGITAL_PATH), "Digital");

// ---------------------------------------------------------------------------
// The discipline folder
// ---------------------------------------------------------------------------
check("a Print folder", familyFromFolderName("Print"), "Print");
check("a Digital folder, oddly cased", familyFromFolderName("DIgital"), "Digital");
check("the folder must BE the discipline", familyFromFolderName("Printworks"), "");
check("a job folder is not a discipline", familyFromFolderName("XY026036_AUS_DOOH_Campaign"), "");

// The real tree from the reported task.
const dict = {
  root: { id: "root", title: "Studio", childIds: ["para"] },
  para: { id: "para", title: "Paramount", childIds: ["film"] },
  film: { id: "film", title: "Paw_Patrol_The_Dino_Movie", childIds: ["dig", "prt"] },
  dig:  { id: "dig",  title: "Digital", childIds: ["intl"] },
  prt:  { id: "prt",  title: "Print", childIds: [] },
  intl: { id: "intl", title: "INTL", childIds: ["job"] },
  job:  { id: "job",  title: "XY026036_AUS_DOOH_Campaign", childIds: [] },
};
const c2p = buildChildToParents(dict);

check(
  "the tree names the discipline two levels up",
  getFolderFamily({ parentIds: ["job"] }, dict, c2p),
  "Digital"
);
// A subtask carries no folder membership of its own. On its own it can say
// nothing; the pull substitutes the parent's folders, exactly as it does for
// the country climb, and then the tree answers.
const subtask = { parentIds: [], superTaskParentIds: ["job"] };
check("a subtask has no folders of its own", getFolderFamily(subtask, dict, c2p), "");
check(
  "so the pull reads it from the parent's",
  getFolderFamily({ ...subtask, parentIds: subtask.superTaskParentIds }, dict, c2p),
  "Digital"
);
check("no folders, no answer", getFolderFamily({ parentIds: [] }, dict, c2p), "");
check("no tree, no answer", getFolderFamily({ parentIds: ["job"] }, null, c2p), "");

// Filed under both at once — a real case (XY025018_Odeon_Selfie_Station). Same
// call the text read makes when a brief says both words: no answer.
const both = { ...dict, job: { id: "job", title: "XY025018_Odeon_Selfie_Station", childIds: [] } };
both.dig = { ...both.dig, childIds: ["job"] };
both.prt = { ...both.prt, childIds: ["job"] };
check(
  "filed under both disciplines is no answer",
  getFolderFamily({ parentIds: ["job"] }, both, buildChildToParents(both)),
  ""
);

// ---------------------------------------------------------------------------
// Precedence: the folder outranks the text
// ---------------------------------------------------------------------------
check("the tree wins over silence", categoryFamilyForTask("Digital", "PP3 - AUS - DOOH - Batch 1 TMRW"), "Digital");
check("the tree wins over the text", categoryFamilyForTask("Digital", "Manchester Printworks"), "Digital");
check("text is the fallback when the tree is silent", categoryFamilyForTask("", PRINT_PATH), "Print");
check("neither says anything", categoryFamilyForTask("", "PP3 - AUS - DOOH - Batch 1 TMRW"), "");

// End to end, as the pull now calls it: the reported row.
check(
  "Daisy's default on the reported task",
  defaultCategoryForTask("Print - Proofreading", "PP3 - AUS - DOOH - Batch 1 TMRW", "Digital"),
  "Digital - Proofreading"
);
check(
  "and it still leaves a genuine print job alone",
  defaultCategoryForTask("Print - Proofreading", "PP3 - AUS - DOOH - Batch 1", "Print"),
  "Print - Proofreading"
);
