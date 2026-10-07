import {
  cleanCell,
  toDeadline,
  orderStatus,
  isMarketTab,
  parseMarket,
  parseWorkbook,
} from "../src/lib/orderForms/parseWorkbook.js";

// Made-up sheets in the shape of the Paramount order forms: a title row, a row
// carrying the XYi block's headers, the header row, then orders.
const MOTION_HEAD = [
  "MARKET", "Are your orders confirmed? Y/N\n\nCONFIRMED - mark as confirmed", "DELIVERY DEADLINE\n(DD/MM/YYYY)",
  "LIVE DATE\n(DD/MM/YYYY)", "MEDIA APPROVED?", "DINTH / DFOH / DOOH", "FORMAT / ANIMATION ", "ARTWORK SELECTION",
  "TRANSLATIONS \nINCLUDING CTAs", "MEDIA / LOCATION SITE NAME\nThis will be added", "WIDTH", "HEIGHT",
  "UNIT OF MEASUREMENT (cm, m, in, mm, px)", "ORIENTATION\n(Portrait or Landscape)", "DURATION\n(seconds)",
  "FILE SIZE\n(KB, MB, PRO RES)", "BIT RATE", "VIDEO FORMAT", "SOUND REQUIRED", "CANVAS ROTATION REQUIRED?",
  "NOTES", "SPEC SHEET", "", "Suitable formats", "Format available for this artwork", "XYi Received ",
  "ENTERPRISE DELIVERY NAME\nSee below", "", "",
  "FilmCode_TYPE_MARKET", "Studio", "Backlog", "", "", "", "", "Digital", "", "", "No", "", "", "",
];
const XYI_HEAD = [
  ...Array(26).fill(""), "FilmCode", "", "Legend Description",
  "Title", "Workflow", "Custom Status", "End Date", "Description", "Market Deadline", "PM", "Department",
  "Media approval", "Aspect ratio", "Reporting", "Art", "Format", "Quote",
];
const motionRow = (o = {}) => [
  o.market ?? "DE", o.confirmed ?? "Please Update", o.deadline ?? "Double Click to Update",
  o.live ?? "Double Click to Update", o.media ?? "Please Update", o.placement ?? "DINTH", o.format ?? "Please update",
  o.artwork ?? "", "", o.site ?? "", o.width ?? "", o.height ?? "", o.unit ?? "px", o.orientation ?? "Landscape",
  o.duration ?? 15, "25fps", "MP.4", "", "No", "No", o.notes ?? "", "", "", "1920x1080", "No", false,
  o.title ?? "ABCD_INTL__DINTH__1920x1080px_15s_DE", "", "DINTH ",
  o.title ?? "ABCD_INTL__DINTH__1920x1080px_15s_DE", "Studio", "Backlog", o.endDate ?? "#VALUE!", "",
  "Double Click to Update", o.pm ?? "", "Digital", "", o.ratio ?? 1.7777777, "Yes", "", "Motion", "To Quote",
];
const motionSheet = (rows) => [
  ["GERMANY - [MOTION] - PARAMOUNT ORDER FORM "],
  XYI_HEAD,
  MOTION_HEAD,
  ...rows,
];

// ── Cells ─────────────────────────────────────────────────────────────────────
check("placeholder: please update", cleanCell("Please Update"), "");
check("placeholder: double click", cleanCell(" Double Click to Update "), "");
check("placeholder: confirm unit", cleanCell("Please confirm unit"), "");
check("placeholder: rgb or cmyk", cleanCell("Confirm if RGB or CMYK"), "");
check("error value #VALUE!", cleanCell("#VALUE!"), "");
check("error value #DIV/0!", cleanCell("#DIV/0!"), "");
check("error value #NAME?", cleanCell("#NAME?"), "");
check("a hashtag is not an error value", cleanCell("#launch"), "#launch");
check("numbers become text", cleanCell(1920), "1920");
check("text is trimmed", cleanCell("  Station totem "), "Station totem");
check("null is empty", cleanCell(null), "");

check("deadline: DD/MM/YYYY", toDeadline("14/10/2026"), "2026-10-14");
check("deadline: ISO", toDeadline("2026-10-14"), "2026-10-14");
check("deadline: spreadsheet serial", toDeadline(46309), "2026-10-14");
check("deadline: Date", toDeadline(new Date(Date.UTC(2026, 9, 14))), "2026-10-14");
check("deadline: placeholder", toDeadline("Double Click to Update"), "");
check("deadline: nonsense", toDeadline("soon"), "");
check("deadline: a small number is not a date", toDeadline(15), "");

check("status: CONFIRMED", orderStatus("CONFIRMED"), "confirmed");
check("status: Y", orderStatus("y"), "confirmed");
check("status: Pending", orderStatus("Pending - awaiting media"), "pending");
check("status: No", orderStatus("No"), "pending");
check("status: placeholder", orderStatus("Please Update"), "unanswered");
check("status: empty", orderStatus(""), "unanswered");

check("tab: market", isMarketTab("Germany (GER)"), true);
check("tab: helper", isMarketTab("_StandardSizes"), false);
check("tab: test market", isMarketTab("AA_Test_Market"), false);

// ── A Motion market ───────────────────────────────────────────────────────────
const germany = parseMarket("Germany (GER)", motionSheet([
  motionRow({ confirmed: "CONFIRMED", deadline: 46309, site: "Cinema foyer", width: 1920, height: 1080, pm: "Sam" }),
  motionRow({ width: "", height: "", site: "" }),
  motionRow({ width: "", height: "", site: "Station totem", confirmed: "PENDING", deadline: "21/10/2026" }),
  [],
]));

check("market name", germany.name, "Germany (GER)");
check("market code from the tab name", germany.code, "GER");
check("market readable", germany.unreadable, null);
check("market kind", germany.kind, "motion");
check("blank template rows are ignored", germany.orders.length, 2);
check("order keeps its sheet row", germany.orders.map((o) => o.row), [4, 6]);
check("order status", germany.orders.map((o) => o.status), ["confirmed", "pending"]);
check("order fields", [germany.orders[0].siteName, germany.orders[0].width, germany.orders[0].height, germany.orders[0].unit, germany.orders[0].duration],
  ["Cinema foyer", "1920", "1080", "px", "15"]);
check("serial deadline", germany.orders[0].deliveryDeadline, "2026-10-14");
check("text deadline", germany.orders[1].deliveryDeadline, "2026-10-21");
check("placeholders cleaned", [germany.orders[0].liveDate, germany.orders[0].mediaApproved, germany.orders[0].format], ["", "", ""]);
check("a site name alone makes an order", germany.orders[1].siteName, "Station totem");
check("market code column", germany.orders[0].marketCode, "DE");
check("delivery name", germany.orders[0].deliveryName, "ABCD_INTL__DINTH__1920x1080px_15s_DE");
check("xyi block", [germany.orders[0].xyi.title, germany.orders[0].xyi.workflow, germany.orders[0].xyi.customStatus, germany.orders[0].xyi.pm, germany.orders[0].xyi.department, germany.orders[0].xyi.xyiFormat, germany.orders[0].xyi.quote],
  ["ABCD_INTL__DINTH__1920x1080px_15s_DE", "Studio", "Backlog", "Sam", "Digital", "Motion", "To Quote"]);
check("xyi error values cleaned", [germany.orders[0].xyi.endDate, germany.orders[0].xyi.marketDeadline], ["", ""]);
check("aspect ratio rounded", germany.orders[0].xyi.aspectRatio, "1.78");
check("xyi Format is not the market's FORMAT / ANIMATION", germany.orders[0].format, "");

// A column inserted at the front must not shift anything.
const shifted = parseMarket("France (FRA)", motionSheet([
  motionRow({ site: "Mall wall", width: 3840, height: 1080 }),
]).map((r) => ["extra", ...r]));
check("inserted column: header row no longer starts the sheet", shifted.unreadable, null);
check("inserted column: fields still found", [shifted.orders[0].siteName, shifted.orders[0].width, shifted.orders[0].xyi.workflow], ["Mall wall", "3840", "Studio"]);

// ── A Print market ────────────────────────────────────────────────────────────
const PRINT_HEAD = [
  "MARKET", "Are your orders confirmed? Y/N", "DELIVERY DEADLINE\n(DD/MM/YYYY)", "LIVE DATE\n(DD/MM/YYYY)", "MEDIA APPROVED?",
  "ARTWORK SELECTION", "INTH / FOH / OOH\nDINTH / DFOH / DOOH", "TYPE", "MEDIA SITE NAME / LOCATION / TYPE", "WIDTH", "HEIGHT",
  "UNIT OF MEASUREMENT (cm, m, in, mm, px)", "ORIENTATION\n(Portrait or Landscape)", "RGB (static digital)\nor\nCMYK (print)",
  "WRITTEN DETAILED SPECIFICATIONS\n(safe zones etc)", "TRANSLATIONS \nINCLUDING CTAs", "NOTES", "Suitable formats",
  "Format available for this artwork", "XYi Received ", "ENTERPRISE DELIVERY NAME", "", "", "X_TYPE_MARKET", "Studio", "Backlog",
];
const PRINT_XYI = [...Array(19).fill(""), "SCRY", "MKT", "", "Legend Description", "Title", "Workflow", "Custom Status"];
const spain = parseMarket("Spain (ESP)", [
  ["SPAIN - [PRINT] - PARAMOUNT ORDER FORM "],
  PRINT_XYI,
  PRINT_HEAD,
  ["ES", "Yes", "01/11/2026", "", "Yes", "Main one-sheet", "OOH", "Billboard", "Gran Via 48-sheet", 6096, 3048, "mm",
    "Landscape", "CMYK", "10mm bleed", "ES title", "Rush", "", "", false, "SCRY_INTL_ES", "", "OOH", "SCRY_INTL_ES", "Studio", "Backlog"],
]);
check("print kind", spain.kind, "print");
check("print columns", [spain.orders[0].type, spain.orders[0].colourMode, spain.orders[0].specs, spain.orders[0].placement, spain.orders[0].siteName, spain.orders[0].artwork, spain.orders[0].translations, spain.orders[0].notes],
  ["Billboard", "CMYK", "10mm bleed", "OOH", "Gran Via 48-sheet", "Main one-sheet", "ES title", "Rush"]);
check("print: motion-only fields are empty", [spain.orders[0].duration, spain.orders[0].videoFormat], ["", ""]);
check("print: Yes is confirmed", spain.orders[0].status, "confirmed");
check("print xyi", [spain.orders[0].xyi.title, spain.orders[0].xyi.customStatus], ["SCRY_INTL_ES", "Backlog"]);

// ── Unreadable tabs and whole workbooks ───────────────────────────────────────
const noHeader = parseMarket("Italy (ITA)", [["notes"], ["nothing here"]]);
check("no header row", [noHeader.unreadable, noHeader.orders.length], ["No header row found", 0]);

const noWidth = parseMarket("Japan (JPN)", [["MARKET", "Are your orders confirmed?", "HEIGHT"], ["JP", "Y", 10]]);
check("missing required column", noWidth.unreadable, "Missing column: Width");

const file = parseWorkbook({
  _Control: [["Film Code:", "ABCD"]],
  AA_Test_Market: motionSheet([motionRow({ site: "x", width: 1, height: 1 })]),
  "Germany (GER)": motionSheet([motionRow({ site: "Cinema foyer", width: 1920, height: 1080 })]),
  "Italy (ITA)": [["notes"]],
}, "ABCD Motion.xlsx", new Date("2026-10-07T10:00:00Z"));
check("workbook: helper and test tabs skipped", file.markets.map((m) => m.name), ["Germany (GER)", "Italy (ITA)"]);
check("workbook: an unreadable tab does not fail the file", file.markets[1].unreadable, "No header row found");
check("workbook: name, kind, loadedAt", [file.name, file.kind, file.loadedAt], ["ABCD Motion.xlsx", "motion", "2026-10-07T10:00:00.000Z"]);
check("workbook: has an id", typeof file.id === "string" && file.id.length > 0, true);

check("workbook with no market tab", parseWorkbook({ _Control: [["x"]] }, "x.xlsx"), null);
check("workbook where no market is readable", parseWorkbook({ "Italy (ITA)": [["notes"]] }, "x.xlsx"), null);
