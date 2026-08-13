import { categoryFamilyFromText, categoryForFamily, defaultCategoryForTask } from "../src/utils/categoryFamily.js";

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
