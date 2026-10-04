// The one studio list, shared by the Job Book scan and the enricher so they
// can't disagree about which folder belongs to which studio.
//
// `keywords` are folder-title tokens that identify a studio. `client` is the name
// the Job Book and the timesheet site expect (the scan appends a region:
// "Universal Pictures UK").
export const STUDIOS = [
  { studio: "Universal", client: "Universal Pictures", keywords: ["universal"] },
  { studio: "Paramount", client: "Paramount Pictures", keywords: ["paramount"] },
  { studio: "Sony",      client: "Sony Pictures",      keywords: ["sony", "columbia", "tristar"] },
  { studio: "Disney",    client: "Disney",             keywords: ["disney", "marvel", "pixar", "lucasfilm"] },
  // "warnerbros": this account writes "WarnerBros_Archive" as one token, which
  // \bwarner\b can't match inside.
  { studio: "Warner",    client: "Warner Bros",        keywords: ["warner", "warnerbros", "wbros", "wb"] },
  { studio: "Netflix",   client: "Netflix",            keywords: ["netflix"] },
  { studio: "Apple",     client: "Apple",              keywords: ["apple"] },
  { studio: "Amazon",    client: "Amazon",             keywords: ["amazon", "mgm"] },
  { studio: "Lionsgate", client: "Lionsgate",          keywords: ["lionsgate"] },
  { studio: "XYi",       client: "XYi Internal",       keywords: ["xyi"] },
];

// Every keyword, flat — for callers that only need to ask "is this a studio
// folder at all", such as the film-name exclusion in getFilmName.
export const STUDIO_KEYWORDS_FLAT = STUDIOS.flatMap((s) => s.keywords);

// keyword -> client, for the scanner, which reports the keyword it matched.
export const STUDIO_CLIENT = Object.fromEntries(
  STUDIOS.flatMap((s) => s.keywords.map((k) => [k, s.client]))
);

// Underscores are separators. Wrike titles join words with `_`, which regex
// treats as a word character, so /\buniversal\b/ misses "Universal_UK_Archive".
// Plain substring matching is wrong the other way ("Portfolio Mgmt" contains
// "mgm"). Replacing `_` with spaces, then matching on word boundaries, gets both.
const separated = (title) => String(title || "").replace(/[_]+/g, " ");

export const studioKeywordOf = (title) => {
  const t = separated(title);
  return STUDIO_KEYWORDS_FLAT.find((k) => new RegExp(`\\b${k}\\b`, "i").test(t));
};

// The studio label ("Warner") rather than the matched keyword ("wbros").
export const studioNameOf = (title) => {
  const t = separated(title);
  const hit = STUDIOS.find((s) =>
    s.keywords.some((k) => new RegExp(`\\b${k}\\b`, "i").test(t))
  );
  return hit ? hit.studio : null;
};
