// Typing-how-you-remember-it search.
//
// A job is identified by several fields at once — "Ebenezer : XY026043, INT -
// Teaser Titles" is a film, a code and a description strung together — so
// people search the way they remember: a bit of the film, a bit of the job.
// "Eben Titles" should find that row.
//
// A plain `includes(query)` can't: the words aren't adjacent, and checking each
// field separately means a query spanning two of them never matches at all.
//
// So: split the query into words and require every one to appear somewhere in
// the combined text. Order doesn't matter, and each word still matches as a
// substring, so partial words ("Eben") work without any fuzzy guessing — which
// would only add false positives to what is really an identifier lookup.

/**
 * True when every whitespace-separated token in `query` appears somewhere in
 * `fields` (joined, case-insensitive). An empty query matches everything.
 */
export function tokenMatch(query, ...fields) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return true;
  const hay = fields.filter(Boolean).join(" ").toLowerCase();
  return q.split(/\s+/).every((t) => hay.includes(t));
}
