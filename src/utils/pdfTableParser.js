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
  // "ARTWORK" and "SELECTION" sit on two lines, and depending on how the PDF
  // interleaves header rows they don't always end up in one cluster — so match
  // the distinctive lower word on its own too. "SELECTION" appears in no other
  // column header in these templates.
  { key: "campaignSelection", match: /(artwork.{0,20}selection|\bselection\b)/i },
  { key: "mediaSiteName", match: /media.{0,20}site/i },
  // Newer delivery templates label these plainly as "WIDTH" / "HEIGHT" (with a
  // separate "UNIT OF MEASUREMENT" column) rather than "PIXEL WIDTH". Match the
  // bare word so both templates work — \bwidth\b still catches "PIXEL WIDTH".
  { key: "pixelWidth", match: /\bwidth\b/i },
  { key: "pixelHeight", match: /\bheight\b/i },
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
    // cx (horizontal centre) is what cells are matched on, not the left edge.
    // A PDF text item's x is where its glyphs START, so in a centred or
    // right-aligned column the left edge moves with the value's length —
    // "6720" and "256" in one column begin at different x. Matching on the
    // centre is alignment-agnostic and stays put regardless of digit count.
    const x = item.transform[4];
    const w = item.width || 0;
    map.get(key).push({ str: item.str.trim(), x, w, cx: x + w / 2 });
  });
  return [...map.entries()]
    .sort(([a], [b]) => b - a)
    .map(([, cells]) => cells.filter((c) => c.str).sort((a, b) => a.x - b.x));
}

// Group header labels into one cluster per column, then carve the page into
// bands at the midpoint between adjacent label CENTRES.
//
// Clustering on the centre, not the left edge, is what makes multi-line
// headers work. A column's label is often several centred lines of differing
// width — "XYi to share a wiredrive link for visual" (366.3), "ARTWORK
// SELECTION" (371.3), "references." (377.1) — whose left edges are far apart
// but whose centres all coincide at 381.8. Clustering left-edges split that
// one column into three and squeezed its band to ~6pt, so "Helmet" (centred
// at 381.8) fell outside and was dropped entirely.
//
// Midpoint bands also mean a column's width is inferred from its NEIGHBOURS
// rather than from how long its own label happens to be, so a short label
// ("DURATION") no longer implies a narrow column.
function buildHeaderClusters(cells, tol = 6) {
  const clusters = [];
  cells.forEach((cell) => {
    const ex = clusters.find((c) => Math.abs(c.cx - cell.cx) <= tol);
    if (ex) ex.items.push(cell);
    else clusters.push({ cx: cell.cx, items: [cell] });
  });
  clusters.forEach((c) => {
    // Re-centre on the mean so band midpoints aren't skewed by whichever
    // line of the label happened to be encountered first.
    c.cx = c.items.reduce((s, i) => s + i.cx, 0) / c.items.length;
    c.text = [...new Set(c.items.map((i) => i.str))].join(" ");
  });
  clusters.sort((a, b) => a.cx - b.cx);
  clusters.forEach((c, i) => {
    c.x = i === 0 ? -Infinity : (clusters[i - 1].cx + c.cx) / 2;
    c.xEnd = i === clusters.length - 1 ? Infinity : (c.cx + clusters[i + 1].cx) / 2;
  });
  return clusters;
}

// ─── column detection ─────────────────────────────────────────────────────────

const HEADER_ROWS = 20;

// The header is the row that mentions the most target columns. Finding it
// explicitly matters: column detection must never see a DATA row, because a
// value can contain a header's own words. A spec cell reading "File size
// below 20mb" (sat in the Written-Specs column, x≈172) matches /file.*size/
// and sorts left of the real FILE SIZE header at x≈510 — so the fileSize
// column got pinned to the wrong side of the page, swallowed the spec blob,
// and dropped the actual "<20MB". Scoring rows by how many DISTINCT headers
// they contain separates the two cleanly: the real header row scored 10
// matches here, that data row only 2.
function findHeaderRow(rows) {
  let best = 0;
  let bestScore = -1;
  for (let r = 0; r < Math.min(rows.length, HEADER_ROWS); r++) {
    const text = rows[r].map((c) => c.str).join(" ");
    const score = TARGET_COLS.filter((tc) => tc.match.test(text)).length;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

// Every header cluster becomes a band [x, xEnd). Crucially this includes
// columns we DON'T extract (Aspect Ratio, Orientation, …): they still act as
// walls, so a column we do want can never bleed into the value next door.
// The previous version only bounded a column against the next *targeted*
// column, so an untargeted neighbour's number was free to be absorbed —
// that's why Pixel Height read "864 0.30" (0.30 is Aspect Ratio).
function detectColumns(rows, headerRow, headerEnd = headerRow + 1) {
  // All header lines up to (but not including) the first data row. Labels wrap
  // BOTH ways: some upward, but "ARTWORK" / "SELECTION" and "MEDIA APPROVED?"
  // wrap DOWNWARD — the second line sits below the best-scoring header row. If
  // we stopped at headerRow+1 the word "SELECTION" was excluded, the cluster
  // read only "ARTWORK", /artwork.*selection/ never matched, and the Campaign
  // column was dropped (blank → "UNKNOWN"). headerEnd is the data-start row, so
  // this stays clear of data while capturing every header line.
  const headerCells = rows.slice(0, headerEnd).flat();
  const clusters = buildHeaderClusters(headerCells);

  const colMap = [];
  TARGET_COLS.forEach((tc) => {
    const idx = clusters.findIndex((c) => tc.match.test(c.text));
    if (idx !== -1) {
      colMap.push({ key: tc.key, x: clusters[idx].x, xEnd: clusters[idx].xEnd });
      return;
    }
    // Fallback: a label whose lines are NOT centre-aligned, so its words landed
    // in adjacent clusters ("PIXEL" / "WIDTH"). Span both bands.
    for (let i = 0; i < clusters.length - 1; i++) {
      const t2 = clusters[i].text + " " + clusters[i + 1].text;
      if (tc.match.test(t2)) {
        colMap.push({ key: tc.key, x: clusters[i].x, xEnd: clusters[i + 1].xEnd });
        return;
      }
    }
  });

  return colMap;
}

// ─── data start detection ────────────────────────────────────────────────────

function findDataStart(rows, colMap, from = 0) {
  const numericKeys = ["pixelWidth", "pixelHeight", "duration"];
  const numCols = numericKeys
    .map((k) => colMap.find((c) => c.key === k))
    .filter(Boolean);

  for (let r = from; r < rows.length; r++) {
    const hits = numCols.filter((col) =>
      rows[r].some(
        (cell) =>
          /^\d+(\.\d+)?$/.test(cell.str) &&
          cell.cx >= col.x &&
          cell.cx < col.xEnd
      )
    ).length;
    if (hits >= 1) return r;
  }
  return from;
}

// ─── cell assignment ──────────────────────────────────────────────────────────

// A cell belongs to the band its CENTRE lands in — no ±tolerance cushions.
// Those cushions were the second bug: artworkType accepted 44.6..77.2 while
// mediaSiteName accepted 72.5..121.1, so they overlapped, and `find` handed
// every cell in 72.5..77.2 to whichever sorted first. A long centred name
// ("INOX_SouthCityMallKolKataArch" starts at 76.5) drifted left into the
// overlap and was silently absorbed by artworkType, blanking the media site.
// Bands are contiguous and mutually exclusive, so no cell can match twice.
function assignCells(row, colMap) {
  const record = {};
  row.forEach((cell) => {
    const col = colMap.find((c) => cell.cx >= c.x && cell.cx < c.xEnd);
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
  const headerRow = findHeaderRow(rows);

  // First pass: columns from the header row alone, enough to locate where the
  // data begins (findDataStart only needs the numeric columns).
  const prelimCols = detectColumns(rows, headerRow);
  if (!prelimCols.length) return null;

  // Data can only start below the header row — never scan back over it.
  const dataStart = findDataStart(rows, prelimCols, headerRow + 1);

  // Second pass: re-detect columns across ALL header lines above the data
  // (labels wrap downward too), so multi-line headers like "ARTWORK
  // SELECTION" are clustered whole instead of losing their lower line.
  const colMap = detectColumns(rows, headerRow, dataStart);
  if (!colMap.length) return null;

  // TEMP diagnostics — remove once campaign detection is confirmed. Shows which
  // columns were detected (and their bands) plus the header clusters we clustered
  // from, so a screenshot of the console pins down why Campaign came back blank.
  try {
    const headerClusters = buildHeaderClusters(rows.slice(0, dataStart).flat());
    console.log("[pdfParser] headerRow", headerRow, "dataStart", dataStart);
    console.log(
      "[pdfParser] clusters",
      headerClusters.map((c) => ({ text: c.text, cx: Math.round(c.cx) }))
    );
    console.log(
      "[pdfParser] detected columns",
      colMap.map((c) => c.key)
    );
    console.log("[pdfParser] first data row raw", rows[dataStart]);
  } catch (e) {
    console.warn("[pdfParser] diag failed", e);
  }

  const results = rows
    .slice(dataStart)
    .map((row) => assignCells(row, colMap))
    .filter((rec) => Object.values(rec).some((v) => v?.trim()));

  return results.length ? results : null;
}
