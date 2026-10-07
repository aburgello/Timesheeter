// An .xlsx file → { sheetName: rows[][] }, the shape parseWorkbook.js takes.
// The only module that imports the spreadsheet library, so a live Google
// source can replace it by producing the same shape.

export async function readXlsx(file) {
  if (!/\.xlsx$/i.test(file.name)) throw new Error("not-xlsx");
  // Loaded on first drop, not with the page: it's the largest thing here.
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(await file.arrayBuffer());
  const sheets = {};
  for (const name of workbook.SheetNames) {
    // raw keeps dates as day numbers, which parseWorkbook converts by column.
    // Formatted text would depend on each cell's display format.
    sheets[name] = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: "" });
  }
  return sheets;
}
