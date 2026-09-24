import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { SlidersHorizontal, Search, Check } from "lucide-react";
import { CATEGORIES } from "../../constants.js";

// The two "how should my pulled rows arrive" preferences, as a popover hanging
// off the bottom-centre tongue next to Lock.
//
// It opens UPWARD because the tongue sits at the foot of the table, a few
// pixels above the action bar — a downward panel would open into the page
// footer and off the bottom of the viewport.
//
// The panel is portalled to <body> and fixed above the button. Inside the
// tongue it could never rise above the table: the tongue is its own stacking
// context at z-10, so the panel's z-index only counted within it, and the
// table's country and category cells drew straight over the panel.
//
// The category list is built here rather than reusing SearchableSelect: that
// component's menu is a 900px-wide, 20rem-tall panel anchored top-full, which
// is right for a full-width table cell and completely wrong nested inside a
// 320px popover that is itself already flipped upward.
export default function PullDefaultsPopover({
  defaultCategory,
  groupMultiCountry,
  setPrefs,
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const wrapRef = useRef(null);
  const panelRef = useRef(null);
  // Where the panel sits: centred on the button, its bottom edge just above it,
  // kept inside the window. Measured, since the panel lives outside the tongue.
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(320, window.innerWidth - 16);
      const left = Math.max(8, Math.min(window.innerWidth - width - 8, r.left + r.width / 2 - width / 2));
      setPos({ left, width, bottom: window.innerHeight - r.top + 8 });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  // Close on outside click and on Escape. Both listeners are only attached
  // while open, so a closed popover costs nothing.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current?.contains(e.target) || panelRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Reopening should always start from the full list rather than whatever was
  // typed last time, which is invisible until the panel is open again.
  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const filtered = search
    ? CATEGORIES.filter((c) => c.toLowerCase().includes(search.toLowerCase()))
    : CATEGORIES;

  // A set default is the thing worth surfacing on the closed button — it
  // silently changes what every future pull produces, so it should not be
  // discoverable only by opening the panel.
  const label = defaultCategory
    ? defaultCategory.replace(" - ", " · ")
    : "Pull defaults";

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Choose the category your pulled rows default to, and whether markets are merged into one entry"
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold transition-colors max-w-[220px] ${
          open || defaultCategory || groupMultiCountry
            ? "text-[#12a0e1]"
            : "text-[#768994] hover:text-[#122027]"
        }`}
      >
        <SlidersHorizontal className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </button>

      {open && pos && createPortal(
        // Two elements on purpose. tailwindcss-animate's `enter` keyframe sets
        // `transform: translate3d(var(--tw-enter-translate-x, 0), …)`, and its
        // end state is the element's own computed transform. Put `animate-in`
        // and `-translate-x-1/2` on the SAME element and the animation runs
        // from translateX(0) to translateX(-50%) — the panel starts half its
        // width to the right of centre and slides left into place, which reads
        // as "why is it coming in from the right".
        //
        // So the outer element owns the position and never animates; the inner
        // one owns the animation and has no transform of its own.
        <div
          ref={panelRef}
          className="fixed z-[99999]"
          style={{ left: pos.left, bottom: pos.bottom, width: pos.width }}
        >
          <div className="w-full bg-white border border-[#dce4ec] rounded-2xl shadow-xl overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-200">
            {/* Merge markets */}
            <div className="p-4 border-b border-[#dce4ec] flex items-center gap-3">
              {/* Label only. What the merge costs you is spelled out in
                Profile → Settings, which is where there is room for it. */}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-black text-[#122027]">
                  Merge markets into one entry
                </p>
              </div>
              <button
                onClick={() =>
                  setPrefs({ groupMultiCountry: !groupMultiCountry })
                }
                role="switch"
                aria-checked={groupMultiCountry}
                aria-label="Merge markets into one entry"
                className={`relative w-10 h-6 rounded-full shrink-0 transition-colors ${
                  groupMultiCountry ? "bg-[#12a0e1]" : "bg-slate-200"
                }`}
              >
                <span
                  className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                    groupMultiCountry ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </button>
            </div>

            {/* Default category */}
            <div className="p-3 pb-2">
              <p className="text-xs font-black text-[#122027] px-1 mb-2">
                Default category
              </p>
              <div className="flex items-center gap-2 bg-slate-50 border border-[#dce4ec] rounded-xl px-2.5 py-1.5">
                <Search className="w-3.5 h-3.5 text-[#768994] shrink-0" />
                <input
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search categories…"
                  className="w-full bg-transparent text-xs text-[#122027] outline-none placeholder:text-[#768994]"
                />
              </div>
            </div>

            <div className="max-h-56 overflow-y-auto overscroll-contain px-2 pb-2">
              {/* Clearing the default is a real choice, not an absence of one: it
                hands the category back to the PRINT/REVISION keyword guess, so
                it needs to be as reachable as picking a category. */}
              <button
                onClick={() => {
                  setPrefs({ defaultCategory: null });
                  setOpen(false);
                }}
                className={`w-full text-left px-2.5 py-1.5 rounded-lg text-[11px] flex items-center gap-2 transition-colors ${
                  defaultCategory
                    ? "text-[#768994] hover:bg-slate-50"
                    : "text-[#12a0e1] font-bold bg-[#12a0e1]/5"
                }`}
              >
                <Check
                  className={`w-3 h-3 shrink-0 ${defaultCategory ? "opacity-0" : ""}`}
                />
                No default
              </button>

              {filtered.map((c) => (
                <button
                  key={c}
                  onClick={() => {
                    setPrefs({ defaultCategory: c });
                    setOpen(false);
                  }}
                  className={`w-full text-left px-2.5 py-1.5 rounded-lg text-[11px] flex items-center gap-2 transition-colors ${
                    c === defaultCategory
                      ? "text-[#12a0e1] font-bold bg-[#12a0e1]/5"
                      : "text-[#122027] hover:bg-slate-50"
                  }`}
                >
                  <Check
                    className={`w-3 h-3 shrink-0 ${c === defaultCategory ? "" : "opacity-0"}`}
                  />
                  <span className="truncate">{c}</span>
                </button>
              ))}

              {filtered.length === 0 && (
                <p className="px-2.5 py-3 text-[11px] text-[#768994] text-center">
                  No category matches “{search}”.
                </p>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
