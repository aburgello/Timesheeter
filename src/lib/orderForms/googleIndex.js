// Reading the PMs' index workbook: one tab per film, one row per market, with a
// Drive link to where that market's order sheets land. Pure helpers; the
// network calls are in googleApi.js.
//
// The index also holds each market's contact emails. Nothing here reads them:
// indexColumns finds the Market and Link columns so only those are fetched.

const norm = (v) => String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase();

// The file or folder id out of any Drive or Docs link.
export function driveIdFromLink(link) {
  const text = String(link ?? "").trim();
  const found =
    /[?&]id=([\w-]{10,})/.exec(text) ||
    /\/folders\/([\w-]{10,})/.exec(text) ||
    /\/d\/([\w-]{10,})/.exec(text);
  return found ? found[1] : "";
}

// Positions of the Market and Link columns in a tab's header row, or null when
// the tab isn't a market list (the index also holds email-template tabs).
export function indexColumns(headerRow) {
  const headers = (headerRow || []).map(norm);
  const market = headers.indexOf("market");
  const link = headers.indexOf("link");
  return market === -1 || link === -1 ? null : { market, link };
}

// 0 → "A", 25 → "Z", 26 → "AA".
export function columnLetter(index) {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// "Street Fighter (DOOH)" → { film: "Street Fighter", medium: "DOOH" }.
export function filmFromTab(tabName) {
  const found = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(String(tabName).trim());
  return found ? { film: found[1].trim(), medium: found[2].trim() } : { film: String(tabName).trim(), medium: "" };
}

// The words a sheet for this medium carries in its name.
const MEDIUM_WORDS = { dooh: ["motion", "dooh"], ooh: ["print"] };

// Which spreadsheet in a market's folder is this film's order form.
//
// The name must contain `contains` (the film's name, unless the PM typed
// something else). Among several, one naming the medium wins, then the most
// recently changed. Returns null when nothing matches: guessing would show one
// film's orders under another's name.
export function pickFilmSheet(files, contains, medium) {
  const want = norm(contains);
  if (!want) return null;
  const words = MEDIUM_WORDS[norm(medium)] || [];
  const score = (f) => (words.some((w) => norm(f.name).includes(w)) ? 1 : 0);
  const matches = (files || []).filter((f) => norm(f.name).includes(want));
  matches.sort((a, b) => score(b) - score(a) || String(b.modifiedTime || "").localeCompare(String(a.modifiedTime || "")));
  return matches[0] || null;
}
