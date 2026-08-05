// Minimal RFC-4180 CSV reader. Hand-rolled rather than pulled in as a
// dependency: the app needs to read one known shape (the Project/Time export,
// or a spreadsheet saved as CSV), and the whole grammar that matters here is
// quoted fields, doubled quotes inside them, and newlines inside quotes.

// Splits raw text into a grid of strings. Handles CRLF, a UTF-8 BOM (Excel
// writes one, and the app's own export deliberately emits one), and quoted
// fields containing commas or line breaks.
export function parseCsv(text) {
  const src = String(text || "").replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let i = 0;

  const endField = () => { row.push(field); field = ""; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; } // escaped quote
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ",") { endField(); i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { endRow(); i++; continue; }
    field += c; i++;
  }
  // Trailing field/row unless the file ended on a clean newline.
  if (field !== "" || row.length) endRow();

  // Drop rows that are entirely empty — a trailing blank line is normal and
  // shouldn't read as a row with no job number.
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ""));
}

// Maps a parsed grid onto objects keyed by our own field names, using a
// header -> key lookup. Header matching ignores case, punctuation and spacing
// so "Job #", "job_number" and "Job Number" all land on the same key.
export function mapCsvRows(grid, headerAliases) {
  if (!grid.length) return { rows: [], headers: [], unmatched: [] };
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const lookup = {};
  for (const [key, aliases] of Object.entries(headerAliases)) {
    for (const a of aliases) lookup[norm(a)] = key;
  }

  const headers = grid[0].map((h) => String(h).trim());
  const keyByIndex = headers.map((h) => lookup[norm(h)] || null);
  const unmatched = headers.filter((h, i) => h && !keyByIndex[i]);

  const rows = grid.slice(1).map((cells) => {
    const out = {};
    keyByIndex.forEach((key, i) => { if (key) out[key] = cells[i] ?? ""; });
    return out;
  });

  return { rows, headers, unmatched };
}
