import { driveIdFromLink, indexColumns, columnLetter, filmFromTab, pickFilmSheet } from "../src/lib/orderForms/googleIndex.js";
import { marketFromSheets } from "../src/lib/orderForms/parseWorkbook.js";

// ── Links ─────────────────────────────────────────────────────────────────────
check("open?id= link", driveIdFromLink("https://drive.google.com/open?id=1AbC_dEf-123456"), "1AbC_dEf-123456");
check("folder link", driveIdFromLink("https://drive.google.com/drive/folders/1AbC_dEf-123456?usp=sharing"), "1AbC_dEf-123456");
check("folder link with a user segment", driveIdFromLink("https://drive.google.com/drive/u/0/folders/1AbC_dEf-123456"), "1AbC_dEf-123456");
check("spreadsheet link", driveIdFromLink("https://docs.google.com/spreadsheets/d/1AbC_dEf-123456/edit?gid=5#gid=5"), "1AbC_dEf-123456");
check("not a link", driveIdFromLink("see email"), "");
check("empty", driveIdFromLink(""), "");

// ── The index ─────────────────────────────────────────────────────────────────
check("index columns", indexColumns(["Email", "First Name", "CC", "Market", "Link", "Merge status"]), { market: 3, link: 4 });
check("index columns move with the sheet", indexColumns(["Market ", "Email", " LINK"]), { market: 0, link: 2 });
check("an email-template tab is not a market list", indexColumns(["Subject", "Body"]), null);
check("empty tab", indexColumns(undefined), null);

check("column letters", [0, 3, 25, 26, 27].map(columnLetter), ["A", "D", "Z", "AA", "AB"]);

check("film and medium", filmFromTab("Street Fighter (DOOH)"), { film: "Street Fighter", medium: "DOOH" });
check("film with a number", filmFromTab("Paw Patrol 3 (OOH) "), { film: "Paw Patrol 3", medium: "OOH" });
check("tab with no medium", filmFromTab("Christmas Email"), { film: "Christmas Email", medium: "" });

// ── Choosing the film's sheet in a market folder ──────────────────────────────
const folder = [
  { id: "a", name: "Street Fighter - Print and Digital Outdoor", modifiedTime: "2026-09-01T10:00:00Z" },
  { id: "b", name: "Street Fighter - Motion Outdoor", modifiedTime: "2026-08-01T10:00:00Z" },
  { id: "c", name: "Ebenezer - Print and Digital Outdoor", modifiedTime: "2026-10-01T10:00:00Z" },
  { id: "d", name: "Copy of Ebenezer - Print and Digital Outdoor", modifiedTime: "2026-10-05T10:00:00Z" },
];
check("film and medium: print", pickFilmSheet(folder, "Street Fighter", "OOH")?.id, "a");
check("film and medium: motion", pickFilmSheet(folder, "Street Fighter", "DOOH")?.id, "b");
check("case and spacing don't matter", pickFilmSheet(folder, "  street   FIGHTER ", "DOOH")?.id, "b");
check("several matches: most recently changed", pickFilmSheet(folder, "Ebenezer", "OOH")?.id, "d");
check("unknown medium: still the film", pickFilmSheet(folder, "Street Fighter", "Pubity")?.id, "a");
check("no sheet for the film: nothing, not a guess", pickFilmSheet(folder, "Fockers", "OOH"), null);
check("nothing to match on", pickFilmSheet(folder, "", "OOH"), null);
check("empty folder", pickFilmSheet([], "Ebenezer", "OOH"), null);

// ── A market's own workbook ───────────────────────────────────────────────────
const HEAD = ["MARKET", "Are your orders confirmed?", "MEDIA SITE NAME", "WIDTH", "HEIGHT", "DURATION"];
const sheet = (title, rows) => [[title], [], HEAD, ...rows];

const croatia = marketFromSheets({
  _StandardSizes: [["Name", "Width"]],
  AA_Test_Market: sheet("MARKET - [MOTION] - ORDER FORM", [["OV", "Y", "ignore", 1, 1, 5]]),
  "Croatia (HRV)": sheet("CROATIA - [MOTION] - ORDER FORM", [["HR", "CONFIRMED", "Foyer", 1920, 1080, 15]]),
}, "Croatia");
check("named as the index names it", croatia.name, "Croatia");
check("code from the sheet's tab", croatia.code, "HRV");
check("orders from the market tab only", croatia.orders.map((o) => o.siteName), ["Foyer"]);
check("kind", croatia.kind, "motion");
check("readable", croatia.unreadable, null);

const twoTabs = marketFromSheets({
  "Batch 1": sheet("X - [PRINT] - ORDER FORM", [["HR", "Y", "One", 10, 20, ""]]),
  "Batch 2": sheet("X - [PRINT] - ORDER FORM", [["HR", "N", "Two", 30, 40, ""]]),
}, "Croatia");
check("several order tabs are read together", twoTabs.orders.map((o) => [o.siteName, o.tab]), [["One", "Batch 1"], ["Two", "Batch 2"]]);

check("a workbook with no order form", marketFromSheets({ Notes: [["hello"]] }, "Croatia").unreadable, "No header row found");
check("a workbook with only helper tabs", marketFromSheets({ _Control: [["x"]] }, "Croatia").unreadable, "No order form tab in this sheet");
