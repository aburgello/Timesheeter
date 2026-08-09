import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Calendar, ChevronLeft, ChevronRight, X } from "lucide-react";
import { layoutRect } from "../../utils/zoom";

// A month picker that looks like the rest of the app.
//
// Replaces <input type="month">, whose dropdown is browser chrome — not DOM —
// so no stylesheet can reach it: it renders as the OS's own widget, wildly out
// of place next to everything else here.
//
// Same value contract as the native input: "YYYY-MM", or "" for no filter.
//
// Portalled to <body> so it escapes any `overflow` or stacking context on the
// toolbar, and positioned with layoutRect() rather than getBoundingClientRect()
// — the app runs at `html { zoom: 1.1 }`, which puts rects and inline styles in
// different coordinate spaces. See src/utils/zoom.js.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FULL = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

// Local, not UTC — toISOString() would roll to the previous month for anyone
// west of Greenwich in the small hours of the 1st.
const localMonth = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

export default function MonthPicker({ value, onChange, className = "" }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const btnRef = useRef(null);

  const [vYear, vMonth] = /^\d{4}-\d{2}$/.test(value || "")
    ? [Number(value.slice(0, 4)), Number(value.slice(5, 7))]
    : [null, null];

  // The year the grid is showing — starts at the selected year, or this one.
  const [year, setYear] = useState(vYear ?? new Date().getFullYear());
  useEffect(() => { if (vYear) setYear(vYear); }, [vYear]);

  const thisMonth = localMonth();

  const toggle = () => {
    if (!open) setRect(layoutRect(btnRef.current));
    setOpen((o) => !o);
  };

  // Keep the panel pinned to its trigger while the page moves underneath it.
  useEffect(() => {
    if (!open) return;
    const reposition = () => setRect(layoutRect(btnRef.current));
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (m) => {
    onChange(`${year}-${String(m + 1).padStart(2, "0")}`);
    setOpen(false);
  };

  const label = vYear ? `${FULL[vMonth - 1]} ${vYear}` : "All months";

  return (
    <div className={`flex items-center gap-2 bg-white border rounded-xl px-3 py-2 transition-colors ${
      open ? "border-[#1cc1a5]" : "border-[#dce4ec]"} ${className}`}>
      <span className="text-[10px] font-black text-[#768994] uppercase tracking-widest shrink-0">Month</span>
      <button ref={btnRef} type="button" onClick={toggle}
        className="flex items-center gap-2 text-sm font-bold text-[#122027] outline-none">
        <Calendar className="w-3.5 h-3.5 text-[#1cc1a5] shrink-0" />
        <span className={vYear ? "" : "text-[#b0bec5] font-medium"}>{label}</span>
      </button>
      {value && (
        <button type="button" onClick={() => onChange("")}
          title="Clear the month filter"
          className="text-slate-400 hover:text-rose-500 transition-colors shrink-0">
          <X className="w-3 h-3" />
        </button>
      )}

      {open && rect && createPortal(
        <>
          <div className="fixed inset-0 z-[9998]" onClick={() => setOpen(false)} />
          <div
            className="fixed z-[9999] w-[268px] bg-white border border-[#dce4ec] rounded-2xl shadow-2xl overflow-hidden"
            style={{ top: rect.bottom + 6, left: rect.left }}
          >
            {/* Year stepper */}
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#dce4ec]/60 bg-slate-50/60">
              <button type="button" onClick={() => setYear((y) => y - 1)}
                title="Previous year"
                className="p-1.5 rounded-lg text-[#768994] hover:text-[#122027] hover:bg-white transition-colors">
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <span className="text-sm font-black text-[#122027] tabular-nums">{year}</span>
              <button type="button" onClick={() => setYear((y) => y + 1)}
                title="Next year"
                className="p-1.5 rounded-lg text-[#768994] hover:text-[#122027] hover:bg-white transition-colors">
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Months */}
            <div className="grid grid-cols-3 gap-1.5 p-2.5">
              {MONTHS.map((m, i) => {
                const iso = `${year}-${String(i + 1).padStart(2, "0")}`;
                const selected = iso === value;
                const current = iso === thisMonth;
                return (
                  <button key={m} type="button" onClick={() => pick(i)}
                    title={`${FULL[i]} ${year}`}
                    className={`relative py-2 rounded-xl text-xs font-bold transition-[background-color,color] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                      selected
                        ? "bg-[#1cc1a5] text-white shadow-sm"
                        : current
                          ? "text-[#1cc1a5] bg-[#1cc1a5]/10 hover:bg-[#1cc1a5]/20"
                          : "text-[#122027] hover:bg-slate-100"
                    }`}>
                    {m}
                    {current && !selected && (
                      <span className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[#1cc1a5]" />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between px-2.5 py-2 border-t border-[#dce4ec]/60">
              <button type="button"
                onClick={() => { onChange(thisMonth); setYear(Number(thisMonth.slice(0, 4))); setOpen(false); }}
                className="px-2 py-1 text-[11px] font-bold text-[#1cc1a5] hover:text-[#17a892] rounded-lg transition-colors">
                This month
              </button>
              <button type="button"
                onClick={() => { onChange(""); setOpen(false); }}
                className="px-2 py-1 text-[11px] font-bold text-[#768994] hover:text-[#122027] rounded-lg transition-colors">
                Clear
              </button>
            </div>
          </div>
        </>,
        document.body
      )}
    </div>
  );
}
