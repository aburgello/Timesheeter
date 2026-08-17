// Why a pulled row says what it says.
//
// The resolvers have always known. resolveCountriesWithSource has reported which
// of its four rules fired since it was written, and nothing ever read it — the
// source was computed on every pull and thrown away one line later, inside
// resolveCountries. So when a row came back with the wrong market or the wrong
// discipline, the only way to find out which rule had been consulted was to
// re-run the resolvers by hand against the real folder tree. That happened twice
// in one day (17 Aug 2026), for a country and then for a category.
//
// This turns that into a hover. The row carries the source it was pulled with
// and the cell puts it in a title attribute.
//
// IN MEMORY ONLY. There is deliberately no column for this in public.tasks:
// provenance describes the PULL, not the row. The moment somebody corrects the
// country by hand a stored "folder" becomes a lie, and there is no edit path
// that could be relied on to clear it. useTasks' toDb is an explicit whitelist,
// so an unlisted field is dropped rather than persisted — the same way
// _rawHours already works. A reloaded row therefore has no source at all, which
// the builders below render as no tooltip rather than as a wrong one.

// The four rules of resolveCountriesWithSource, in its own order of authority.
const COUNTRY_SOURCES = {
  "task-name": "the country code ending the task's own name",
  "parent-task-name": "the country code ending its parent task's name",
  folder: "the folder the task sits in",
  "country-field": "the Country field on the task",
  // The unpinned reader — /customfields was unreachable, so the field was
  // matched by the shape of its value rather than by id. Worth saying out loud:
  // this is the mode the 5 Aug Norway incident came from.
  "custom-field-sweep": "a custom field matched by its value, not by id",
};

const FAMILY_SOURCES = {
  folder: "the Print/Digital folder in Wrike",
  "task-text": "the words in the task's own text",
  default: "your default category — nothing said Print or Digital",
  fallback: "the keyword fallback — nothing said Print or Digital",
  "wrike-status": "the task's Wrike status, which matched a category exactly",
};

/**
 * Tooltip for a country cell, or "" when there is nothing to say — a row that
 * came back from Supabase carrying no source, or a value we don't recognise.
 *
 * The pull records "none" rather than "" when the resolvers ran and found
 * nothing, so an empty country can be told apart from an unpulled row. That
 * case gets a tooltip of its own: "no country" is an answer the resolvers give
 * deliberately, and the member reading the red Country chip is owed the reason.
 */
export function countryPullSource(source) {
  if (source === "none")
    return "No country: nothing in the task name, its parent task, the folders above it, or the Country field named one.";
  const why = COUNTRY_SOURCES[source];
  return why ? `Country read from ${why}.` : "";
}

/** Tooltip for a category cell, on the same terms. */
export function categoryPullSource(source) {
  const why = FAMILY_SOURCES[source];
  if (!why) return "";
  if (source === "wrike-status") return `Category taken from ${why}.`;
  return `Print/Digital decided by ${why}.`;
}
