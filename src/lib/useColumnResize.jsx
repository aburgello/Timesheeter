import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Drag-to-resize column widths for a table, persisted to localStorage.
//
// Usage:
//   const cols = [{ key: "name", px: 200 }, ...];
//   const { widths, resizeHandle } = useColumnResize("my-table", cols);
//   ...
//   <colgroup>{cols.map(c => <col key={c.key} style={{ width: widths[c.key] }} />)}</colgroup>
//   <th style={{ position: "relative" }}>Label {resizeHandle(c.key)}</th>
//
// The table itself should use `tableLayout: "fixed"` so <colgroup> widths win
// regardless of cell content. Double-clicking a handle resets that one column.
//
// Pass `fitTo` (a ref to the scrolling container) to make the table shrink to
// the space it actually has instead of overflowing it. Widths are stored in
// pixels, which is right for dragging but wrong for a laptop narrower than the
// machine the widths were set on — the far columns simply fell off the right
// edge. When the stored widths don't fit, the middle columns are scaled down
// proportionally to close the gap; `keepFirst`/`keepLast` hold the outer
// columns at their set width so the row stays identifiable (job number) and
// its totals stay reachable no matter how tight it gets.
//
// A column marked `fixed: true` is also held. Some columns aren't holding
// text at all — a checkbox, a "none" dropdown — so they're already at their
// natural size and scaling them only truncates the control inside. Taking
// them out of the squeeze leaves more room for the columns that do hold
// content, and their width stops depending on the window.
//
// What's persisted is always what the user dragged, never the squeezed result,
// so widening the window restores the widths they chose.
export function useColumnResize(
  storageKey,
  columns,
  { min = 32, fitTo = null, keepFirst = false, keepLast = false, fitMin = 56 } = {}
) {
  const defaults = {};
  for (const c of columns) defaults[c.key] = c.px;

  const [widths, setWidths] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      if (saved && typeof saved === "object") {
        const merged = {};
        for (const c of columns) merged[c.key] = typeof saved[c.key] === "number" ? saved[c.key] : c.px;
        return merged;
      }
    } catch { /* ignore corrupt storage */ }
    return { ...defaults };
  });

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(widths)); } catch { /* ignore */ }
  }, [storageKey, widths]);

  // Width of the scroll container, watched so the squeeze re-runs on resize
  // and on the sidebar opening/closing, not just at mount.
  const [avail, setAvail] = useState(0);
  useEffect(() => {
    const el = fitTo?.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setAvail(entry.contentRect.width));
    ro.observe(el);
    setAvail(el.clientWidth);
    return () => ro.disconnect();
  }, [fitTo]);

  // `widths` is what the user set; `fitted` is what the table should render.
  // The two differ whenever the set widths don't exactly fill the container.
  const fitted = useMemo(() => {
    if (!avail || !columns.length) return widths;
    const width = (c) => widths[c.key] ?? c.px;
    const total = columns.reduce((s, c) => s + width(c), 0);
    if (total === avail) return widths;

    const held = new Set(columns.filter((c) => c.fixed).map((c) => c.key));
    if (keepFirst) held.add(columns[0].key);
    if (keepLast) held.add(columns[columns.length - 1].key);
    const flexible = columns.filter((c) => !held.has(c.key));
    if (!flexible.length) return widths;

    const heldTotal = columns
      .filter((c) => held.has(c.key))
      .reduce((s, c) => s + width(c), 0);
    const room = avail - heldTotal;
    const flexTotal = flexible.reduce((s, c) => s + width(c), 0);
    if (room <= 0 || flexTotal <= 0) return widths;

    // Room to spare: hand it to the text columns so the row ends flush with
    // the right edge instead of trailing off into blank space. The remainder
    // goes to the last flexible column rather than being rounded away, so the
    // widths add up to the container exactly — a pixel out either way is a
    // hairline gap or a stray scrollbar.
    if (total < avail) {
      const out = { ...widths };
      let given = 0;
      flexible.forEach((c, i) => {
        const share =
          i === flexible.length - 1
            ? room - flexTotal - given
            : Math.floor((avail - total) * (width(c) / flexTotal));
        out[c.key] = width(c) + share;
        given += share;
      });
      return out;
    }

    // Scale, then give back to the columns still above the floor whatever the
    // ones that hit it couldn't surrender — otherwise a single narrow column
    // bottoming out would leave the table overflowing anyway.
    const out = { ...widths };
    let owed = 0;
    let spare = 0;
    for (const c of flexible) {
      const want = Math.floor(width(c) * (room / flexTotal));
      if (want < fitMin) {
        out[c.key] = fitMin;
        owed += fitMin - want;
      } else {
        out[c.key] = want;
        spare += want - fitMin;
      }
    }
    if (owed > 0 && spare > 0) {
      const give = Math.min(1, owed / spare);
      for (const c of flexible) {
        if (out[c.key] > fitMin) {
          out[c.key] = Math.max(fitMin, Math.round(out[c.key] - (out[c.key] - fitMin) * give));
        }
      }
    }

    // All that flooring leaves a few pixels unaccounted for. Settle them on
    // the widest flexible column so the row still ends flush — the rounding
    // dust is exactly the sliver of blank space this is meant to remove.
    const settled = columns.reduce((s, c) => s + out[c.key], 0);
    const drift = avail - settled;
    if (drift !== 0) {
      const widest = flexible.reduce((a, b) => (out[a.key] >= out[b.key] ? a : b));
      if (out[widest.key] + drift >= fitMin) out[widest.key] += drift;
    }
    return out;
  }, [widths, columns, avail, keepFirst, keepLast, fitMin]);

  const drag = useRef(null);

  const onMove = useCallback((e) => {
    const d = drag.current;
    if (!d) return;
    const next = Math.max(min, d.startW + (e.clientX - d.startX));
    setWidths((w) => (w[d.key] === next ? w : { ...w, [d.key]: next }));
  }, [min]);

  const onUp = useCallback(() => {
    drag.current = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, [onMove]);

  const startResize = useCallback((key) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Start from the width on screen, not the stored one — dragging a squeezed
    // column should follow the pointer rather than jump to its unsqueezed size.
    drag.current = { key, startX: e.clientX, startW: fitted[key] ?? widths[key] };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [widths, fitted, onMove, onUp]);

  const resetOne = useCallback((key) => {
    setWidths((w) => ({ ...w, [key]: defaults[key] }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetAll = useCallback(() => setWidths({ ...defaults }), [storageKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Render helper: a thin grip on the right edge of a <th>. The <th> must be
  // position: relative for this to anchor correctly.
  const resizeHandle = useCallback((key) => (
    <span
      onPointerDown={startResize(key)}
      onDoubleClick={(e) => { e.stopPropagation(); resetOne(key); }}
      onClick={(e) => e.stopPropagation()}
      title="Drag to resize · double-click to reset"
      className="group absolute top-0 right-0 z-10 flex h-full w-2 cursor-col-resize items-stretch justify-end"
      style={{ touchAction: "none" }}
    >
      {/* currentColor, not a hardcoded black/white pair. The consolidated
          timesheet passes dark:true against a LIGHT header, so the grip was
          drawn white-on-white and invisible in light mode — and the flag never
          consulted the actual theme, so it couldn't have been right in both.
          Inheriting the header's own colour works either way. */}
      <span className="w-px bg-current opacity-20 transition-colors group-hover:bg-[#12a0e1] group-hover:opacity-100" />
    </span>
  ), [startResize, resetOne]);

  // `widths` is the fitted set — what every caller wants to render. `setWidths`
  // is what the user chose, for anyone that needs the raw value.
  return { widths: fitted, storedWidths: widths, startResize, resizeHandle, resetAll };
}
