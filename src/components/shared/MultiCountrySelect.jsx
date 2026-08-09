import React, { useState, useLayoutEffect, useRef } from "react";
import { ChevronDown, Check } from "lucide-react";
import { TERRITORIES } from "../../constants";
import { layoutRect, layoutViewport } from "../../utils/zoom";
import {
  splitTerritories,
  joinTerritories,
  toggleTerritory,
  territoryFlag,
  territoryCode,
} from "../../utils/territories";

// Country picker that takes several countries per row. `value` is the stored
// comma-separated string (see utils/territories.js) and onChange hands back the
// same shape, so it drops in wherever a single-country select used to sit.
//
// Positioning mirrors TableSearchableSelect: position:fixed off layoutRect so
// the panel escapes the table's scroll container and stays aligned under the
// app's html{zoom:1.1}.
export default function MultiCountrySelect({
  value,
  onChange,
  options = TERRITORIES,
  placeholder = "Country",
  variant = "table", // "table" (compact cell trigger) | "form" (taller input)
  dropdownId,
  activeDropdown,
  setActiveDropdown,
  disabled = false,
  isDarkModal = false,
  // Set where a country is required but couldn't be resolved from the task.
  // Since the guesser stopped inventing one (see countryCodes.js), an empty
  // country is now a real state a person has to clear rather than a rarity, so
  // it has to be visible in the row itself — the table variant is otherwise
  // borderless and an empty cell reads as "nothing to do here".
  needsAttention = false,
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapperRef = useRef(null);
  const searchRef = useRef(null);
  const [fixedStyle, setFixedStyle] = useState({});

  const isShared =
    dropdownId !== undefined &&
    activeDropdown !== undefined &&
    setActiveDropdown !== undefined;
  const isOpen = (isShared ? activeDropdown === dropdownId : localOpen) && !disabled;

  const open = () => {
    if (disabled) return;
    setQuery("");
    if (isShared) setActiveDropdown(dropdownId);
    else setLocalOpen(true);
  };
  const close = () => {
    if (isShared) setActiveDropdown(null);
    else setLocalOpen(false);
  };

  const selected = splitTerritories(value);
  const isForm = variant === "form";
  // Only flag an empty one — once something is picked the row is fine, whatever
  // the caller still thinks.
  const showAttention = needsAttention && selected.length === 0 && !disabled;
  // How much fits before the trigger has to fall back to flags-only: the form
  // variant is a full-width field, the table variant a ~140px cell.
  const nameLimit = isForm ? 6 : 3;
  const flagLimit = isForm ? 40 : 18;

  useLayoutEffect(() => {
    if (!isOpen || !wrapperRef.current) return;
    const rect = layoutRect(wrapperRef.current);
    // Layout pixels, like rect and like the styles below — window.innerWidth is
    // visual, and mixing the two is what let this panel hang off the right edge.
    const { vw, vh } = layoutViewport();

    const w = Math.min(isForm ? 900 : 800, vw - 16);
    // A 4-column, ~800px panel opened from a ~140px table cell isn't a dropdown
    // hanging off a field, it's a picker. Anchoring its left edge to the cell
    // sent it past the right of the screen; centring it in the viewport keeps
    // the whole list reachable wherever the column happens to sit. The form
    // variant is a full-width field, so there it still opens under its trigger.
    const centred = w > rect.width * 2;
    const left = centred
      ? Math.max(4, (vw - w) / 2)
      : Math.max(4, Math.min(rect.left, vw - w - 4));

    const spaceBelow = vh - rect.bottom;
    const flipUp = spaceBelow < 260 && rect.top > spaceBelow;

    setFixedStyle({
      position: "fixed",
      zIndex: 999999,
      left,
      width: w,
      ...(flipUp ? { bottom: vh - rect.top + 4 } : { top: rect.bottom + 4 }),
    });
    searchRef.current?.focus();
  }, [isOpen, isForm]);

  // Codes are searchable as well as visible: now that the list shows "Brazil
  // (BR)", typing the code someone just read off a task name should find the
  // country rather than coming back empty.
  const q = query.trim().toLowerCase();
  const filtered = options.filter(
    (opt) =>
      opt.toLowerCase().includes(q) ||
      territoryCode(opt).toLowerCase().includes(q)
  );
  // Ticked countries float to the top so a long selection stays reviewable
  // without scrolling the whole list.
  const ordered = [
    ...filtered.filter((o) => selected.includes(o)),
    ...filtered.filter((o) => !selected.includes(o)),
  ];

  const toggle = (opt) => onChange(toggleTerritory(value, opt));

  return (
    <div
      ref={wrapperRef}
      className={`relative w-full ${isOpen ? "z-[999999]" : "z-50"}`}
    >
      {isOpen && (
        <div
          className="fixed inset-0 z-40"
          onMouseDown={(e) => {
            e.stopPropagation();
            close();
          }}
        />
      )}

      <button
        type="button"
        onClick={() => (isOpen ? close() : open())}
        disabled={disabled}
        title={selected.join(", ")}
        className={`relative w-full flex items-start gap-1 border rounded-xl z-50 transition-all text-left ${
          isForm ? "py-2.5 px-3 bg-white shadow-sm" : "py-2 px-2.5"
        } ${
          disabled
            ? "opacity-45 cursor-not-allowed bg-transparent border-transparent"
            : isOpen
            ? `border-[#12a0e1] ring-4 ring-[#12a0e1]/10 ${
                isDarkModal ? "bg-[#1e2530]" : "bg-white"
              }`
            : showAttention
            ? `border-rose-400 ring-2 ring-rose-400/15 ${
                isDarkModal ? "bg-rose-500/5" : "bg-rose-50/60"
              }`
            : isForm
            ? "border-[#dce4ec] hover:border-slate-300"
            : `border-transparent ${
                isDarkModal
                  ? "hover:border-[#384252] hover:bg-[#1e2530]"
                  : "hover:border-slate-300 hover:bg-white/50 bg-transparent"
              }`
        }`}
      >
        <span
          className={`flex-1 min-w-0 font-semibold ${
            isForm ? "text-sm" : "text-[12px]"
          } ${
            showAttention
              ? "text-rose-500"
              : selected.length === 0
              ? isDarkModal
                ? "text-slate-600"
                : "text-slate-400"
              : isDarkModal
              ? "text-slate-100"
              : isForm
              ? "text-[#122027]"
              : "text-[#3b5998]"
          }`}
        >
          {selected.length === 0 ? (
            // Deliberately the same one word as the resting placeholder: the
            // red border already says "this needs you", and a longer string
            // wrapped to two lines and made the whole cell taller.
            showAttention ? "Country" : placeholder
          ) : selected.length <= nameLimit ? (
            // Few enough to name outright — chips wrap onto extra lines rather
            // than truncating, so the cell grows a little instead of hiding a
            // country.
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              {selected.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 max-w-full">
                  <span className="text-sm leading-none shrink-0">
                    {territoryFlag(t)}
                  </span>
                  <span className="truncate">{t}</span>
                </span>
              ))}
            </span>
          ) : (
            // Too many to name in the cell: show every flag (they wrap) plus a
            // count. Full list is on the tooltip and in the open panel.
            <span className="flex flex-wrap items-center gap-x-1 gap-y-0.5 leading-snug">
              {selected.slice(0, flagLimit).map((t, i) => (
                <span
                  key={`${t}-${i}`}
                  title={t}
                  className="text-sm leading-none"
                >
                  {territoryFlag(t)}
                </span>
              ))}
              {selected.length > flagLimit && (
                <span className="text-[10px] font-black text-slate-400">
                  +{selected.length - flagLimit}
                </span>
              )}
              <span
                className={`text-[10px] font-black uppercase tracking-wider ${
                  isDarkModal ? "text-slate-400" : "text-slate-400"
                }`}
              >
                {selected.length} countries
              </span>
            </span>
          )}
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 shrink-0 mt-0.5 transition-transform duration-200 ${
            isOpen ? "rotate-180" : ""
          } ${disabled ? "text-slate-300" : "text-slate-400"}`}
        />
      </button>

      {isOpen && (
        <div
          style={fixedStyle}
          className={`fixed border shadow-2xl rounded-2xl overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200 ${
            isDarkModal
              ? "bg-[#19202b] border-[#2d3748]"
              : "bg-white border-slate-200"
          }`}
        >
          <div
            className={`p-2 border-b ${
              isDarkModal ? "border-[#2d3748]" : "border-slate-100"
            }`}
          >
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter countries…"
              className={`w-full px-3 py-2 text-[12px] font-semibold rounded-xl border outline-none focus:border-[#12a0e1] focus:ring-2 focus:ring-[#12a0e1]/10 ${
                isDarkModal
                  ? "bg-[#131a24] border-[#2d3748] text-slate-100 placeholder:text-slate-600"
                  : "bg-white border-slate-200 text-slate-800 placeholder:text-slate-400"
              }`}
            />
          </div>

          <div className="max-h-[300px] overflow-y-auto custom-scrollbar">
            {ordered.length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1 p-2">
                {ordered.map((opt) => {
                  const on = selected.includes(opt);
                  return (
                    <button
                      type="button"
                      key={opt}
                      onClick={() => toggle(opt)}
                      title={opt}
                      className={`w-full flex items-center gap-2 px-2.5 py-2 text-[11px] font-semibold rounded-xl transition-all ${
                        on
                          ? isDarkModal
                            ? "bg-[#12a0e1]/20 text-white"
                            : "bg-[#12a0e1]/10 text-[#12a0e1]"
                          : isDarkModal
                          ? "text-slate-300 hover:bg-[#253042] hover:text-white"
                          : "text-slate-700 hover:bg-[#12a0e1]/10 hover:text-[#12a0e1]"
                      }`}
                    >
                      <span
                        className={`w-3.5 h-3.5 rounded border grid place-items-center shrink-0 ${
                          on
                            ? "bg-[#12a0e1] border-[#12a0e1] text-white"
                            : isDarkModal
                            ? "border-slate-600"
                            : "border-slate-300"
                        }`}
                      >
                        {on && <Check className="w-2.5 h-2.5" strokeWidth={4} />}
                      </span>
                      <span className="shrink-0 text-sm leading-none">
                        {territoryFlag(opt)}
                      </span>
                      <span className="truncate">{opt}</span>
                      {/* The market code, as a call-back to what people write
                          at the end of a task name. Muted and last so it reads
                          as an annotation on the country, not a second name,
                          and dropped entirely where we don't have one. */}
                      {territoryCode(opt) && (
                        <span
                          className={`ml-auto shrink-0 font-mono text-[9.5px] tracking-wide ${
                            on
                              ? "opacity-70"
                              : isDarkModal
                              ? "text-slate-500"
                              : "text-slate-400"
                          }`}
                        >
                          {territoryCode(opt)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div
                className={`px-4 py-3 text-xs italic ${
                  isDarkModal ? "text-slate-500" : "text-slate-400"
                }`}
              >
                No matches found.
              </div>
            )}
          </div>

          <div
            className={`flex items-center justify-between gap-2 px-3 py-2 border-t ${
              isDarkModal
                ? "border-[#2d3748] bg-[#151c26]"
                : "border-slate-100 bg-slate-50"
            }`}
          >
            <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
              {selected.length
                ? `${selected.length} selected`
                : "No countries yet"}
            </span>
            <div className="flex items-center gap-1.5">
              {selected.length > 0 && (
                <button
                  type="button"
                  onClick={() => onChange(joinTerritories([]))}
                  className="px-2.5 py-1.5 text-[11px] font-bold rounded-lg text-slate-500 hover:text-rose-500 hover:bg-rose-50 transition-colors"
                >
                  Clear
                </button>
              )}
              <button
                type="button"
                onClick={close}
                className="px-3 py-1.5 text-[11px] font-black rounded-lg bg-[#12a0e1] text-white hover:bg-[#0e8bc4] transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
