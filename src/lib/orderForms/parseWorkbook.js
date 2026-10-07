// Paramount order-form workbooks → the Order Forms page's data. Pure: takes the
// sheets as arrays of rows (see readXlsx.js) and never touches the network.
//
// Columns are found by header text, not position, so the Motion and Print
// layouts share one parser and an inserted column doesn't shift anything.

const norm = (v) => String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase();

// What an untouched template cell says. They read as empty everywhere.
const PLACEHOLDERS = new Set([
  "please update",
  "double click to update",
  "please confirm unit",
  "confirm orientation",
  "please confirm orientation",
  "confirm if rgb or cmyk",
]);

// #VALUE!, #REF!, #DIV/0!, #NAME?, #N/A: a formula with nothing to work on yet.
const ERROR_VALUE = /^#[A-Z0-9/]+[!?]$|^#N\/A$/;

export function cleanCell(value) {
  if (value == null) return "";
  if (value instanceof Date) return toDeadline(value);
  const text = String(value).trim();
  if (PLACEHOLDERS.has(norm(text)) || ERROR_VALUE.test(text)) return "";
  return text;
}

const pad = (n) => String(n).padStart(2, "0");
const utcIso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

// Spreadsheet day numbers count from 30 Dec 1899. The range keeps a duration or
// a pixel width in a date column from being read as a date.
const SERIAL_MIN = 20000; // 1954
const SERIAL_MAX = 80000; // 2119
const SERIAL_EPOCH = Date.UTC(1899, 11, 30);

export function toDeadline(value) {
  if (value == null || value === "") return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : utcIso(value);
  if (typeof value === "number") {
    if (value < SERIAL_MIN || value > SERIAL_MAX) return "";
    return utcIso(new Date(SERIAL_EPOCH + Math.floor(value) * 86400000));
  }
  const text = cleanCell(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const uk = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  return uk ? `${uk[3]}-${pad(uk[2])}-${pad(uk[1])}` : "";
}

export function orderStatus(confirmedCell) {
  const v = norm(cleanCell(confirmedCell));
  if (v.startsWith("confirmed") || v === "y" || v === "yes") return "confirmed";
  if (v.startsWith("pending") || v === "n" || v === "no") return "pending";
  return "unanswered";
}

export const isMarketTab = (name) => !name.startsWith("_") && name !== "AA_Test_Market";

// field → the header it sits under. A string matches the start of the header;
// { is } matches the whole header, for words that also start other headers.
const COLUMNS = [
  ["marketCode", [{ is: "market" }]],
  ["confirmed", ["are your orders confirmed"]],
  ["deliveryDeadline", ["delivery deadline"]],
  ["liveDate", ["live date"]],
  ["mediaApproved", ["media approved"]],
  ["placement", ["inth / foh / ooh", "dinth / dfoh / dooh"]],
  ["artwork", ["artwork selection"]],
  ["translations", ["translations"]],
  ["siteName", ["media site name", "media / location site name"]],
  ["width", [{ is: "width" }]],
  ["height", [{ is: "height" }]],
  ["unit", ["unit of measurement"]],
  ["orientation", ["orientation"]],
  ["notes", [{ is: "notes" }]],
  ["deliveryName", ["enterprise delivery name"]],
  // Motion
  ["format", ["format / animation"]],
  ["duration", ["duration"]],
  ["fileSize", ["file size"]],
  ["bitRate", ["bit rate"]],
  ["videoFormat", ["video format"]],
  ["sound", ["sound required"]],
  ["rotation", ["canvas rotation"]],
  ["specSheet", ["spec sheet"]],
  // Print
  ["type", [{ is: "type" }]],
  ["colourMode", ["rgb"]],
  ["specs", ["written detailed specifications"]],
];

// The XYi block's headers sit one row above the header row; in the header row
// those columns hold default values.
const XYI_COLUMNS = [
  ["title", "title"],
  ["workflow", "workflow"],
  ["customStatus", "custom status"],
  ["endDate", "end date"],
  ["marketDeadline", "market deadline"],
  ["pm", "pm"],
  ["department", "department"],
  ["aspectRatio", "aspect ratio"],
  ["art", "art"],
  ["xyiFormat", "format"],
  ["quote", "quote"],
];

const REQUIRED = [["confirmed", "Confirmed"], ["width", "Width"], ["height", "Height"]];
const DATE_FIELDS = new Set(["deliveryDeadline", "liveDate"]);
const XYI_DATE_FIELDS = new Set(["endDate", "marketDeadline"]);

const matches = (header, want) => (typeof want === "string" ? header.startsWith(want) : header === want.is);

function mapColumns(headerRow) {
  const headers = headerRow.map(norm);
  const cols = {};
  for (const [field, wants] of COLUMNS) {
    const at = headers.findIndex((h) => h && wants.some((w) => matches(h, w)));
    if (at !== -1) cols[field] = at;
  }
  return cols;
}

function mapXyiColumns(xyiRow, from) {
  const headers = (xyiRow || []).map(norm);
  const cols = {};
  for (const [field, want] of XYI_COLUMNS) {
    const at = headers.findIndex((h, i) => i > from && h === want);
    if (at !== -1) cols[field] = at;
  }
  return cols;
}

function kindOf(rows, headerAt, cols) {
  for (const row of rows.slice(0, headerAt)) {
    for (const cell of row || []) {
      const text = norm(cell);
      if (text.includes("[motion]")) return "motion";
      if (text.includes("[print]")) return "print";
    }
  }
  return "duration" in cols ? "motion" : "print";
}

const codeFromTab = (name) => /\(([^)]+)\)\s*$/.exec(name)?.[1] || "";

const unreadable = (name, reason) => ({ name, code: codeFromTab(name), kind: null, unreadable: reason, orders: [] });

function readOrder(row, rowNumber, cols, xyiCols) {
  const order = { row: rowNumber };
  for (const [field] of COLUMNS) {
    const raw = field in cols ? row[cols[field]] : "";
    order[field] = DATE_FIELDS.has(field) ? toDeadline(raw) : cleanCell(raw);
  }
  if (!((order.width && order.height) || order.siteName)) return null;
  order.status = orderStatus(order.confirmed);

  order.xyi = {};
  for (const [field] of XYI_COLUMNS) {
    const raw = field in xyiCols ? row[xyiCols[field]] : "";
    order.xyi[field] = XYI_DATE_FIELDS.has(field) ? toDeadline(raw) : cleanCell(raw);
  }
  const ratio = Number(order.xyi.aspectRatio);
  if (order.xyi.aspectRatio && Number.isFinite(ratio)) order.xyi.aspectRatio = ratio.toFixed(2);
  return order;
}

export function parseMarket(name, rows) {
  const headerAt = rows.findIndex((row) => (row || []).some((cell) => norm(cell) === "market"));
  if (headerAt === -1) return unreadable(name, "No header row found");

  const cols = mapColumns(rows[headerAt]);
  const missing = REQUIRED.find(([field]) => !(field in cols));
  if (missing) return unreadable(name, `Missing column: ${missing[1]}`);

  // Only look for XYi headers to the right of the market's own columns: "Format"
  // and "Art" would otherwise be ambiguous with anything a market adds.
  const marketEnd = cols.deliveryName ?? Math.max(...Object.values(cols));
  const xyiCols = mapXyiColumns(rows[headerAt - 1], marketEnd);

  const orders = [];
  for (let i = headerAt + 1; i < rows.length; i++) {
    const order = readOrder(rows[i] || [], i + 1, cols, xyiCols);
    if (order) orders.push(order);
  }
  return { name, code: codeFromTab(name), kind: kindOf(rows, headerAt, cols), unreadable: null, orders };
}

// One market from that market's own workbook (the per-film sheet in its Drive
// folder), named as the index names it. Usually one order tab beside the
// helper tabs; if a market has split its orders over several, they are read
// together and each order says which tab it came from.
export function marketFromSheets(sheets, marketName) {
  const tabs = Object.keys(sheets).filter(isMarketTab).map((name) => parseMarket(name, sheets[name] || []));
  if (!tabs.length) return { ...unreadable(marketName, "No order form tab in this sheet"), code: "" };
  const readable = tabs.filter((t) => !t.unreadable);
  if (!readable.length) return { ...unreadable(marketName, tabs[0].unreadable), code: "" };
  return {
    name: marketName,
    code: readable[0].code,
    kind: readable[0].kind,
    unreadable: null,
    orders: readable.flatMap((t) => t.orders.map((o) => ({ ...o, tab: t.name }))),
  };
}

// null when the workbook holds no readable market tab: it isn't an order form.
export function parseWorkbook(sheets, fileName, now = new Date()) {
  const markets = Object.keys(sheets)
    .filter(isMarketTab)
    .map((name) => parseMarket(name, sheets[name] || []));
  const readable = markets.find((m) => !m.unreadable);
  if (!readable) return null;
  return {
    id: `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: fileName,
    kind: readable.kind,
    loadedAt: now.toISOString(),
    markets,
  };
}
