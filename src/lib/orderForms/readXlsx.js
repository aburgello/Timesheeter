// An .xlsx → { sheetName: rows[][] }, the shape parseWorkbook.js takes.
// The only module that imports the spreadsheet library.

import { fillMergedDown } from "./parseWorkbook";

export async function sheetsFromBuffer(buffer) {
  // Loaded on first use, not with the page: it's the largest thing here.
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(buffer);
  const sheets = {};
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    // raw keeps dates as day numbers, which parseWorkbook converts by column.
    // Formatted text would depend on each cell's display format.
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
    // Rows start at the sheet's first used cell, which isn't always A1; merges
    // are in sheet coordinates.
    const origin = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]).s : { r: 0, c: 0 };
    const merges = (sheet["!merges"] || []).map(({ s, e }) => ({
      s: { r: s.r - origin.r, c: s.c - origin.c },
      e: { r: e.r - origin.r, c: e.c - origin.c },
    }));
    sheets[name] = fillMergedDown(rows, merges);
  }
  return sheets;
}

export async function readXlsx(file) {
  if (!/\.xlsx$/i.test(file.name)) throw new Error("not-xlsx");
  return sheetsFromBuffer(await file.arrayBuffer());
}
