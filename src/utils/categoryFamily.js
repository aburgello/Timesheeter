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
 * Which family a task's own text claims, or "" when it doesn't claim one.
 *
 * Both words present is treated as NO answer rather than as a tie broken by
 * position. A digital task whose brief mentions print-ready files says both
 * things, and guessing between them would be worse than leaving the member's
 * own choice alone.
 */
export function categoryFamilyFromText(text) {
  const t = String(text || "").toUpperCase();
  const print = t.includes("PRINT");
  const digital = t.includes("DIGITAL");
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

/** The two combined: a member's default, resolved against one task's text. */
export function defaultCategoryForTask(defaultCategory, taskText) {
  return categoryForFamily(defaultCategory, categoryFamilyFromText(taskText));
}
