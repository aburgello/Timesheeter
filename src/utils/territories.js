import {
  TERRITORY_FLAGS,
  TERRITORY_CODES,
  TIMESHEET_TERRITORY_SUBSTITUTIONS,
  LEGACY_TERRITORY_NAMES,
} from "../constants";

// A row's `territory` field holds one *or more* countries as a comma-separated
// list ("Belgium, France"). One row stays one piece of work worth one block of
// time however many markets it covers — the company timesheet site takes
// several countries per row (its own countriesSelectedCsv field), so a
// multi-country row maps across 1:1 without duplicating hours or rows.
// No entry in TERRITORIES contains a comma, so "," is a safe joiner.

// A renamed territory is read as its current name, so a row saved under the
// old one still matches the picker, the flags and the export.
const currentName = (t) => LEGACY_TERRITORY_NAMES[t] || t;

export const splitTerritories = (value) => {
  if (Array.isArray(value))
    return value.map((t) => currentName(String(t).trim())).filter(Boolean);
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((t) => currentName(t.trim()))
    .filter(Boolean);
};

// A stored territory value with any renamed entry brought up to date, and
// otherwise exactly as it was stored. For the places that show the string
// itself rather than splitting it.
export const withCurrentNames = (value) =>
  typeof value === "string" && Object.keys(LEGACY_TERRITORY_NAMES).some((old) => value.includes(old))
    ? joinTerritories(value)
    : value;

// Canonical stored form. De-duplicates but keeps the order they were picked in.
export const joinTerritories = (value) => [
  ...new Set(splitTerritories(value)),
].join(", ");

export const hasTerritory = (value, territory) =>
  splitTerritories(value).includes(territory);

export const toggleTerritory = (value, territory) => {
  const list = splitTerritories(value);
  return joinTerritories(
    list.includes(territory)
      ? list.filter((t) => t !== territory)
      : [...list, territory]
  );
};

export const territoryFlag = (territory) =>
  TERRITORY_FLAGS[territory] || "🌐";

// The market code shown beside a country in the picker, or "" where we don't
// have one yet. Callers must render the empty case as no parenthetical at all
// rather than "Malta ()".
export const territoryCode = (territory) => TERRITORY_CODES[territory] || "";

// Flags only — for prefixes and tight cells. Uncapped by default; pass a max
// where the caller can't let the run wrap (a single-line label, say).
export const territoryFlags = (value, max = Infinity) => {
  const list = splitTerritories(value);
  if (!list.length) return "";
  return list.slice(0, max).map(territoryFlag).join("");
};

// What goes out in the JSON the bookmarklet pastes into the company
// timesheet. Our list and the site's are nearly identical, so this is a no-op
// for almost every row — the exception is a value we carry that the site has
// no checkbox for, which is substituted for the nearest one it does have
// (see TIMESHEET_TERRITORY_SUBSTITUTIONS). Stored rows keep our name; only the
// export is translated, so nothing is lost when the site catches up.
// De-duplicates after substituting, since two of ours can collapse into one of
// theirs and a repeated checkbox value would be ticked twice.
export const toTimesheetTerritories = (value) => [
  ...new Set(
    splitTerritories(value).map(
      (t) => TIMESHEET_TERRITORY_SUBSTITUTIONS[t] || t
    )
  ),
];

// Order- and case-insensitive identity, for grouping and duplicate detection:
// "Belgium, France" and "france, belgium" are the same set of markets.
export const territoryKey = (value) =>
  splitTerritories(value)
    .map((t) => t.toLowerCase())
    .sort()
    .join("|");
