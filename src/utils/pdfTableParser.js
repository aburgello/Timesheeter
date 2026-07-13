// pdfjs is ~170 kB gzipped — a static import here rode along with every page
// chunk that can open the task detail modal. Load it on first actual parse
// instead (opening a PDF spec is rare; the await below covers the fetch).
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url
      ).toString();
      return lib;
    });
  }
  return pdfjsPromise;
}

const TARGET_COLS = [
  { key: "artworkType", match: /(dinth|foh|dooh)/i },
  { key: "campaignSelection", match: /artwork.{0,20}selection/i },
  { key: "mediaSiteName", match: /media.{0,10}site/i },
  { key: "pixelWidth", match: /(pixel.{0,30}width|width.{0,10}pixel)/i },
  { key: "pixelHeight", match: /(pixel.{0,30}height|height.{0,10}pixel)/i },
  { key: "duration", match: /\bduration\b/i },
  { key: "soundReq", match: /\bsound\b/i },
  { key: "fileSize", match: /file.{0,20}size/i },
  { key: "bitRate", match: /bit.{0,10}rate/i },
  { key: "specificVideo", match: /specific.{0,30}video/i },
];

// ─── helpers ─────────────────────────────────────────────────────────────────

function groupIntoRows(items, yTol = 4) {
  const map = new Map();
  items.forEach((item) => {
    const y = item.transform[5];
    let key = null;
    for (const [ky] of map) {
      if (Math.abs(ky - y) <= yTol) {
        key = ky;
        break;
      }
    }
    if (key === null) key = y;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ str: item.str.trim(), x: item.transform[4] });
  });
  return [...map.entries()]
    .sort(([a], [b]) => b - a)
    .map(([, cells]) => cells.filter((c) => c.str).sort((a, b) => a.x - b.x));
}

function buildXClusters(cells, xTol = 8) {
  const clusters = [];
  cells.forEach((cell) => {
    const ex = clusters.find((c) => Math.abs(c.x - cell.x) < xTol);
    if (ex) ex.strs.push(cell.str);
    else clusters.push({ x: cell.x, strs: [cell.str] });
  });
  clusters.sort((a, b) => a.x - b.x);
  clusters.forEach((c, i) => {
    c.xEnd = i < clusters.length - 1 ? clusters[i + 1].x : Infinity;
    c.text = [...new Set(c.strs)].join(" ");
  });
  return clusters;
}

// ─── column detection ─────────────────────────────────────────────────────────

const HEADER_ROWS = 20;

function detectColumns(rows) {
  const headerCells = rows.slice(0, HEADER_ROWS).flat();
  const clusters = buildXClusters(headerCells, 5);

  const colMap = [];
  TARGET_COLS.forEach((tc) => {
    let hit = clusters.find((c) => tc.match.test(c.text));

    // FIXED SLIDING WINDOW: Ensures the boundary includes ALL matched words
    if (!hit) {
      for (let i = 0; i < clusters.length - 1; i++) {
        const t2 = clusters[i].text + " " + clusters[i + 1].text;
        if (tc.match.test(t2)) {
          hit = { x: clusters[i].x, xEnd: clusters[i + 1].xEnd, text: t2 };
          break;
        }
        if (i + 2 < clusters.length) {
          const t3 = t2 + " " + clusters[i + 2].text;
          if (tc.match.test(t3)) {
            hit = { x: clusters[i].x, xEnd: clusters[i + 2].xEnd, text: t3 };
            break;
          }
        }
      }
    }

    if (hit) {
      let xEnd = hit.xEnd;
      if (xEnd - hit.x <= 8) {
        const next = clusters.find((c) => c.x > xEnd);
        if (next) xEnd = next.x;
      }
      colMap.push({ key: tc.key, x: hit.x, xEnd });
    }
  });

  const targetXSet = new Set(colMap.map((c) => c.x));
  colMap.forEach((col) => {
    if (targetXSet.has(col.xEnd)) col.xEnd -= 1;
  });

  return colMap;
}

// ─── data start detection ────────────────────────────────────────────────────

function findDataStart(rows, colMap) {
  const numericKeys = ["pixelWidth", "pixelHeight", "duration"];
  const numCols = numericKeys
    .map((k) => colMap.find((c) => c.key === k))
    .filter(Boolean);

  for (let r = 0; r < rows.length; r++) {
    const hits = numCols.filter((col) =>
      rows[r].some(
        (cell) =>
          /^\d+(\.\d+)?$/.test(cell.str) &&
          cell.x >= col.x - 10 &&
          cell.x < col.xEnd
      )
    ).length;
    if (hits >= 1) return r;
  }
  return HEADER_ROWS;
}

// ─── cell assignment ──────────────────────────────────────────────────────────

function assignCells(row, colMap, tol = 8) {
  const sorted = [...colMap].sort((a, b) => a.x - b.x);

  // ORIGINAL LOGIC WITH SAFE CUSHION: Prevents left-bleeds and right-bleeds while catching centered text
  sorted.forEach((col, i) => {
    col.xLeft = i > 0 ? Math.max(col.x - tol, sorted[i - 1].xEnd) : col.x - tol;

    col.xRight =
      i < sorted.length - 1
        ? Math.min(col.xEnd + tol, sorted[i + 1].x - 1)
        : col.xEnd + tol;
  });

  const record = {};
  row.forEach((cell) => {
    const col = sorted.find((c) => cell.x >= c.xLeft && cell.x <= c.xRight);
    if (col) {
      record[col.key] = record[col.key]
        ? record[col.key] + " " + cell.str
        : cell.str;
    }
  });

  return record;
}

// ─── public API ───────────────────────────────────────────────────────────────

export async function parsePdfDeliverySpecs(blob) {
  const pdfjsLib = await loadPdfjs();
  const arrayBuffer = await blob.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const allItems = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    content.items.forEach((item) => {
      if (item.str?.trim()) allItems.push(item);
    });
  }

  if (!allItems.length) return null;

  const rows = groupIntoRows(allItems);
  const colMap = detectColumns(rows);
  if (!colMap.length) return null;

  const dataStart = findDataStart(rows, colMap);

  const results = rows
    .slice(dataStart)
    .map((row) => assignCells(row, colMap))
    .filter((rec) => Object.values(rec).some((v) => v?.trim()));

  return results.length ? results : null;
}
