import { tokenMatch } from "../src/utils/search.js";

// A real row, as Job Book stores it.
const JOB = ["Ebenezer : XY026043, INT - Teaser Titles", "Paramount Pictures International",
             "Ebenezer", "INT - Teaser Titles"];
const OTHER = ["Ebenezer : XY026047, INT - French Canada Assets", "Paramount Pictures International",
               "Ebenezer", "INT - French Canada Assets"];

// The case this exists for: words the user remembers, not adjacent in the text.
check("partial film + word from the description", tokenMatch("Eben Titles", ...JOB), true);
check("the old contiguous rule would have missed it",
  "Ebenezer : XY026043, INT - Teaser Titles".toLowerCase().includes("eben titles"), false);

// Order is irrelevant — you type what you recall first.
check("order does not matter", tokenMatch("Titles Eben", ...JOB), true);

// Still precise: every token has to be there.
check("a token that is absent fails", tokenMatch("Eben Billboards", ...JOB), false);
check("does not match the neighbouring job", tokenMatch("Eben Titles", ...OTHER), false);

// Spanning two different fields at once.
check("film from one field, client from another", tokenMatch("ebenezer paramount", ...JOB), true);

// Codes still work, whole or partial.
check("full code",    tokenMatch("XY026043", ...JOB), true);
check("partial code", tokenMatch("026043", ...JOB), true);
check("code + word",  tokenMatch("026043 teaser", ...JOB), true);

// Input hygiene
check("case insensitive",   tokenMatch("eBeN tItLeS", ...JOB), true);
check("collapses spacing",  tokenMatch("  Eben   Titles  ", ...JOB), true);
check("empty matches all",  tokenMatch("", ...JOB), true);
check("whitespace only",    tokenMatch("   ", ...JOB), true);
check("null query",         tokenMatch(null, ...JOB), true);
check("skips empty fields", tokenMatch("eben", "Ebenezer", null, undefined, ""), true);
