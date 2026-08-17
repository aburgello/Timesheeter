import { CATEGORIES } from "../constants.js";

// Most of the timesheet's categories come in matched pairs — "Print -
// Proofreading" and "Digital - Proofreading", "Print - Retouching" and
// "Digital - Retouching". A person's DISCIPLINE is stable (Daisy proofreads);
// which half of the pair applies is a property of the JOB, and the job says so
// itself: print and digital work live in their own Wrike folders, so the path
// carries "PRINT" or "DIGITAL".
//
// That lets a single stored default do the work of two. The member picks
// "Print - Proofreading" once, and a task sitting in a DIGITAL folder is pulled
// as "Digital - Proofreading" instead of being corrected by hand every time.
//
// Deliberately only ever moves ACROSS a pair. It never changes the discipline
// the member chose — the swap is print↔digital and nothing else.

const PRINT = "Print - ";
const DIGITAL = "Digital - ";

/**
 * The discipline a FOLDER declares by being named after one.
 *
 * Print and Digital are sibling folders under each film — 304 and 301 of them
 * across the account — and a job folder filed under one is the studio saying
 * which discipline the job is, once, in the place the tree reserves for it.
 * Whole-title equality, not a keyword: "Print" the folder, never "Printworks".
 */
export function familyFromFolderName(title) {
  const t = String(title || "").trim().toUpperCase();
  if (t === "PRINT") return "Print";
  if (t === "DIGITAL") return "Digital";
  return "";
}

/**
 * Which family a task's own text claims, or "" when it doesn't claim one.
 *
 * Both words present is treated as NO answer rather than as a tie broken by
 * position. A digital task whose brief mentions print-ready files says both
 * things, and guessing between them would be worse than leaving the member's
 * own choice alone.
 *
 * WHOLE TOKENS, not substrings. `includes("PRINT")` is the same free-text scan
 * that countryCodes.js exists to abolish, and it fails the same way: "Sprint 1",
 * "Sample Blueprints", "Showcase_ICEE_Printed" and "Manchester_Printworks"
 * (a venue) all read as Print, and "EventDigitalScreens" as Digital. Across the
 * account's 14,335 folder names, tokenising changes 60 answers and every one of
 * them goes from a wrong answer to no answer.
 *
 * Split on anything that isn't alphanumeric, which is what makes this safe on
 * the one input that genuinely carries the word: a /Volumes path, where "PRINT"
 * is delimited by slashes.
 */
export function categoryFamilyFromText(text) {
  const tokens = String(text || "").toUpperCase().split(/[^A-Z0-9]+/);
  const print = tokens.includes("PRINT");
  const digital = tokens.includes("DIGITAL");
  if (print === digital) return "";
  return print ? "Print" : "Digital";
}

/**
 * `category` moved into `family`, when such a category exists.
 *
 * Returns the input untouched when there is no evidence, when it is already in
 * the right family, or when it has no counterpart — "Print - RGB - CMYK
 * Conversion" and "Watermarking" have no digital twin, and inventing one would
 * put a category on the row that the timesheet has no checkbox for.
 */
export function categoryForFamily(category, family) {
  if (!category || !family) return category;
  const want = family === "Print" ? PRINT : DIGITAL;
  const other = family === "Print" ? DIGITAL : PRINT;
  if (!category.startsWith(other)) return category;
  const swapped = want + category.slice(other.length);
  return CATEGORIES.includes(swapped) ? swapped : category;
}

/**
 * What discipline a task belongs to, most deliberate statement first.
 *
 * The FOLDER outranks the text, because it is the anchored statement and the
 * text is incidental. The account settles it: the tree answers 3,080 of 3,741
 * job folders, it answers 2,312 that the text leaves blank, and where the two
 * disagree the tree has been right every time —
 *
 *     XY025979_Manchester_Printworks_IMAX   text: Print    tree: Digital
 *     XY022497_Digital_Hand_Hold            text: Digital  tree: Print
 *
 * — because those are venues and asset names, not disciplines. Text remains the
 * fallback for the 661 job folders filed under neither.
 */
export function categoryFamilyForTask(folderFamily, taskText) {
  return categoryFamilyWithSource(folderFamily, taskText).family;
}

/**
 * The same answer, plus which of the two said it — "folder", "task-text", or ""
 * when neither did. Carried onto the pulled row so a member can hover a cell and
 * see why it says what it says, instead of it taking a measurement session to
 * find out. See utils/pullSource.js.
 */
export function categoryFamilyWithSource(folderFamily, taskText) {
  if (folderFamily) return { family: folderFamily, source: "folder" };
  const fromText = categoryFamilyFromText(taskText);
  return { family: fromText, source: fromText ? "task-text" : "" };
}

/**
 * Everything one task's category decision produces: the resolved category, the
 * family behind it, and which of the two evidences said so.
 *
 * This is what the pull calls, because it needs the source as well as the
 * answer and must not resolve the family twice to get both. `family` comes back
 * too so a caller with no stored default can still branch on it.
 */
export function categoryForTaskWithSource(defaultCategory, taskText, folderFamily = "") {
  const { family, source } = categoryFamilyWithSource(folderFamily, taskText);
  return { category: categoryForFamily(defaultCategory, family), family, source };
}

/** The category alone, for callers that don't care where it came from. */
export function defaultCategoryForTask(defaultCategory, taskText, folderFamily = "") {
  return categoryForTaskWithSource(defaultCategory, taskText, folderFamily).category;
}
