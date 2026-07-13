import React, { useState, useRef, useEffect, useMemo } from "react";
import { Calendar, ChevronLeft, ChevronRight, X } from "lucide-react";

// A quiet, self-contained date picker to replace the browser's native
// <input type="date"> (which renders differently per-OS and can't be themed).
// Value in/out is an ISO "YYYY-MM-DD" string (what the DB stores); the field
// displays en-GB DD/MM/YYYY to match the rest of the app.
//
// The popover is positioned in normal flow (absolute inside a relative wrapper),
// NOT portaled+fixed: the app runs at html { zoom: 1.1 }, and fixed positioning
// from getBoundingClientRect double-applies that zoom, so the panel drifted
// further from its field the more the page was scrolled. In-flow absolute has no
// coordinate math and is immune to the zoom. It flips above the field when the
// trigger sits low in the viewport so the calendar never opens off-screen.
const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

const toDMY = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}/${m}/${y}` : "";
};
const isoOf = (y, m, d) =>
  `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

export default function DateField({ value, onChange, placeholder = "Select date…", allowClear = true, className = "" }) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const wrapRef = useRef(null);
  const btnRef = useRef(null);

  const now = new Date();
  const [viewY, setViewY] = useState(value ? Number(value.slice(0, 4)) : now.getFullYear());
  const [viewM, setViewM] = useState(value ? Number(value.slice(5, 7)) - 1 : now.getMonth());

  // Jump the visible month to the selected date whenever the picker opens.
  const openPicker = () => {
    if (value) {
      setViewY(Number(value.slice(0, 4)));
      setViewM(Number(value.slice(5, 7)) - 1);
    }
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setDropUp(r.bottom > window.innerHeight * 0.6);
    }
    setOpen(true);
  };

  // Close on any click outside the field + popover.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const cells = useMemo(() => {
    const startDow = (new Date(viewY, viewM, 1).getDay() + 6) % 7; // Monday-first
    const daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
    const out = Array(startDow).fill(null);
    for (let d = 1; d <= daysInMonth; d++) out.push(d);
    return out;
  }, [viewY, viewM]);

  const todayIso = isoOf(now.getFullYear(), now.getMonth(), now.getDate());
  const stepMonth = (delta) => {
    let m = viewM + delta, y = viewY;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    setViewM(m); setViewY(y);
  };
  const commit = (iso) => { onChange(iso); setOpen(false); };

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <button ref={btnRef} type="button" onClick={() => (open ? setOpen(false) : openPicker())}
        className="w-full flex items-center justify-between gap-2 border border-[#dce4ec] rounded-2xl px-4 py-2.5 text-sm text-[#122027] bg-white outline-none focus:border-[#10b981] focus:ring-2 focus:ring-[#10b981]/15 hover:border-slate-300 transition-colors">
        <span className={value ? "" : "text-[#b0bec5]"}>{value ? toDMY(value) : placeholder}</span>
        <span className="flex items-center gap-1.5 shrink-0">
          {value && allowClear && (
            <span role="button" tabIndex={-1} aria-label="Clear date"
              onClick={(e) => { e.stopPropagation(); onChange(""); }}
              className="text-slate-300 hover:text-rose-500 transition-colors">
              <X className="w-3.5 h-3.5" />
            </span>
          )}
          <Calendar className="w-4 h-4 text-[#768994]" />
        </span>
      </button>

      {open && (
        <div className={`absolute z-[200] left-0 w-[264px] bg-white border border-[#dce4ec] rounded-2xl shadow-2xl p-3 ${dropUp ? "bottom-full mb-1.5" : "top-full mt-1.5"}`}>
          <div className="flex items-center justify-between mb-2 px-1">
            <button type="button" onClick={() => stepMonth(-1)} aria-label="Previous month"
              className="p-1 rounded-lg hover:bg-slate-100 text-[#768994]"><ChevronLeft className="w-4 h-4" /></button>
            <span className="text-sm font-bold text-[#122027]">{MONTHS[viewM]} {viewY}</span>
            <button type="button" onClick={() => stepMonth(1)} aria-label="Next month"
              className="p-1 rounded-lg hover:bg-slate-100 text-[#768994]"><ChevronRight className="w-4 h-4" /></button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 mb-1">
            {WEEKDAYS.map(w => <div key={w} className="text-[10px] font-black text-[#768994] text-center py-1">{w}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((d, i) => {
              if (d === null) return <div key={i} />;
              const iso = isoOf(viewY, viewM, d);
              const selected = iso === value;
              const today = iso === todayIso;
              return (
                <button key={i} type="button" onClick={() => commit(iso)}
                  className={`h-8 rounded-lg text-xs font-bold transition-colors ${
                    selected ? "bg-[#10b981] text-white"
                      : today ? "text-[#0d9488] bg-[#10b981]/10"
                        : "text-[#33454f] hover:bg-slate-100"
                  }`}>
                  {d}
                </button>
              );
            })}
          </div>
          <div className="flex items-center justify-between mt-2 pt-2 border-t border-[#f0f4f8]">
            <button type="button" onClick={() => commit(todayIso)}
              className="text-[11px] font-bold text-[#0d9488] hover:underline px-1">Today</button>
            {allowClear && value && (
              <button type="button" onClick={() => commit("")}
                className="text-[11px] font-bold text-[#768994] hover:text-rose-500 px-1">Clear</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
