// One film's orders, read live from Google: the index tab lists the markets,
// each market's Drive folder holds that film's order sheet, and each sheet is
// parsed the same way a dropped workbook is.

import { mapPool } from "../fetchPool";
import { readIndexColumns, listMarketSheets, downloadSheet, GoogleError } from "./googleApi";
import { driveIdFromLink, columnLetter, filmFromTab, pickFilmSheet } from "./googleIndex";
import { sheetsFromBuffer } from "./readXlsx";
import { marketFromSheets } from "./parseWorkbook";

// Enough to finish a 60-market film in well under a minute without tripping
// Drive's per-user rate limit.
const IN_FLIGHT = 4;

const REASONS = {
  "not-found": "The Drive link in the index doesn't open",
  "no-access": "Your Google account can't open this market's folder",
  failed: "Google couldn't be reached for this market",
};

const missing = (name, reason, extra = {}) => ({ name, code: "", kind: null, unreadable: reason, orders: [], undated: 0, ...extra });

async function loadMarket({ name, link }, contains, medium) {
  const driveId = driveIdFromLink(link);
  if (!driveId) return missing(name, "No Drive link in the index");
  try {
    const sheets = await listMarketSheets(driveId);
    const sheet = pickFilmSheet(sheets, contains, medium);
    if (!sheet) {
      return missing(name, sheets.length
        ? `No sheet named like "${contains}" among the ${sheets.length} in its folder`
        : "No spreadsheets in its folder");
    }
    const market = marketFromSheets(await sheetsFromBuffer(await downloadSheet(sheet)), name);
    return { ...market, sheetName: sheet.name, sheetUrl: sheet.webViewLink || "" };
  } catch (err) {
    // Signed out part-way: stop the whole load rather than mark 60 markets unreadable.
    if (err instanceof GoogleError && err.reason === "signed-out") throw err;
    return missing(name, REASONS[err.reason] || "This market's sheet couldn't be read");
  }
}

// `columns` is indexColumns() of the tab's header. Returns an OrderFile whose
// `source` is what Refresh needs to read it again.
export async function loadFilm({ indexId, tab, columns, contains, onProgress }, now = new Date()) {
  const [names, links] = await readIndexColumns(indexId, tab, [columnLetter(columns.market), columnLetter(columns.link)]);
  const rows = names
    .map((name, i) => ({ name: String(name || "").trim(), link: links[i] || "" }))
    .filter((r) => r.name);
  if (!rows.length) return null;

  const { film, medium } = filmFromTab(tab);
  const wanted = (contains || film).trim();
  let done = 0;
  onProgress?.(0, rows.length);
  const markets = await mapPool(rows, IN_FLIGHT, async (row) => {
    const market = await loadMarket(row, wanted, medium);
    onProgress?.(++done, rows.length);
    return market;
  });

  return {
    id: `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: tab,
    kind: markets.find((m) => m.kind)?.kind || (/dooh|motion/i.test(medium) ? "motion" : "print"),
    loadedAt: now.toISOString(),
    source: { indexId, tab, columns, contains: wanted },
    markets,
  };
}
