// One studio list, used by both the scanner and the enricher.
//
// There were two, and they disagreed in both directions. The enricher knew
// marvel, pixar, lucasfilm, columbia, tristar, mgm, wbros and wb; the scanner
// knew none of them. The scanner knew Lionsgate and XYi; the enricher knew
// neither. So a Marvel folder was Disney to one and studio-less to the other,
// and the scan proposed corrections the enricher would never agree with.
//
// `keywords` are the folder-title tokens that identify a studio. `client` is
// the name the Job Book and the timesheet site expect; the scanner appends a
// region to it ("Universal Pictures UK").
export const STUDIOS = [
  { studio: "Universal", client: "Universal Pictures", keywords: ["universal"] },
  { studio: "Paramount", client: "Paramount Pictures", keywords: ["paramount"] },
  { studio: "Sony",      client: "Sony Pictures",      keywords: ["sony", "columbia", "tristar"] },
  { studio: "Disney",    client: "Disney",             keywords: ["disney", "marvel", "pixar", "lucasfilm"] },
  // "warnerbros" earns its place: this account writes the folder as
  // "WarnerBros_Archive", one joined token, and \bwarner\b cannot match inside
  // it — "Warner" and "Bros" are both word characters, so there is no boundary
  // between them. Substring matching found it; boundary matching needs the
  // joined form spelled out.
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

// Underscores are separators, not letters.
//
// This matters more than it looks. Wrike titles join words with underscores
// ("Universal_UK_Archive", "_Paramount_MASTER_TEMPLATES"), and in a regex `_`
// is a WORD character — so /\buniversal\b/ does not match "Universal_UK_Archive"
// at all. A plain word-boundary test therefore fails to recognise a dozen real
// studio folders in this account.
//
// Substring matching recognised them, but paid for it elsewhere: "Portfolio
// Mgmt" contains "mgm" and resolved to Amazon, and "MWB_INTL__Digital_1Sheets_UK"
// contains "wb" and resolved to Warner.
//
// Replacing separators first, then matching on word boundaries, is the only
// version that gets both right — "Universal UK Archive" matches `universal`,
// while "Portfolio Mgmt" and "MWB INTL Digital 1Sheets UK" match nothing.
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
