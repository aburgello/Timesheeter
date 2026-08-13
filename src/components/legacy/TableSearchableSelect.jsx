// Extracted verbatim from LegacyTimesheets.js — no logic changes.
// Self-contained: only reads its own props and internal state, no closure
// over LegacyTimesheet's component state.
import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { ChevronDown } from "lucide-react";
import { layoutRect, layoutViewport } from "../../utils/zoom";

// --- MODERN SEARCHABLE SELECT FOR TABLE ROWS ---
export default function TableSearchableSelect({
  options,
  value,
  onChange,
  placeholder,
  getPrefix,
  isGrouped = false,
  dropdownId,
  activeDropdown,
  setActiveDropdown,
  isCountry = false,
  isTime = false,
  isCategory = false,
  isJob = false,
  disabled = false,
  isDarkModal = false,
  // Options to surface in their own group at the very top — the caller's
  // "you keep picking these" shortlist. Only shown while the list is
  // unfiltered: once you are searching you have said what you want, and a
  // shortlist above the matches is then just a duplicate of some of them.
  pinnedOptions = [],
  pinnedLabel = "Most used",
}) {
  const isOpen = activeDropdown === dropdownId && !disabled;
  const [searchTerm, setSearchTerm] = useState(value || "");
  const wrapperRef = useRef(null);
  const [fixedStyle, setFixedStyle] = useState({});

  useEffect(() => {
    setSearchTerm(value || "");
  }, [value]);

  // Compute fixed position on open so the dropdown escapes any overflow container.
  // useLayoutEffect fires before paint so the dropdown never renders at position 0,0.
  useLayoutEffect(() => {
    if (!isOpen || !wrapperRef.current) return;
    // layoutRect (not getBoundingClientRect) so the trigger's coordinates are
    // in the same layout space as innerWidth/Height and the fixed style we set
    // below. Under the app's html{zoom:1.1} a raw rect is visual pixels, which
    // the browser would zoom a second time on paint — landing the dropdown
    // offset from its trigger, worse the further down/right the row is.
    const rect = layoutRect(wrapperRef.current);
    // Layout pixels, matching layoutRect and the inline styles below.
    const { vw, vh } = layoutViewport();

    let w = 300;
    if (isCountry) w = Math.min(800, vw - 16);
    else if (isCategory) w = Math.min(750, vw - 16);
    else if (isTime) w = 160;
    // Job dropdown tracks its column width (the trigger spans the cell), so it
    // lines up under the column and grows when the column is resized. Floor keeps
    // it readable when the column is narrow; long job strings wrap rather than
    // horizontally scroll.
    else if (isJob) w = Math.min(vw - 16, Math.max(rect.width, 280));

    const rightAlign = isTime || (isCategory && !isDarkModal);
    let left = rightAlign ? rect.right - w : rect.left;
    left = Math.max(4, Math.min(left, vw - w - 4));

    const spaceBelow = vh - rect.bottom;
    const flipUp = spaceBelow < 220 && rect.top > spaceBelow;
    const vertical = flipUp
      ? { bottom: vh - rect.top + 4 }
      : { top: rect.bottom + 4 };

    setFixedStyle({
      position: "fixed",
      zIndex: 999999,
      left,
      width: w,
      ...vertical,
    });
  }, [isOpen, isTime, isCountry, isCategory, isDarkModal]);

  const filteredOptions = options.filter((opt) => {
    if (searchTerm === value) return true;
    return opt.toLowerCase().includes(searchTerm.toLowerCase());
  });

  // Unfiltered = the search box still shows the current value (or nothing), so
  // the user hasn't started narrowing yet. Same test the filter above uses.
  const isUnfiltered = !searchTerm || searchTerm === value;
  const pinned = isUnfiltered
    ? pinnedOptions.filter((o) => options.includes(o))
    : [];

  const groupedOptions = {};
  if (isGrouped) {
    // The shortlist keeps its members in their real groups as well as at the
    // top. Removing them would mean someone scrolling to "Print" not finding
    // "Print - Proofreading" where they expect it, because they happen to use
    // it often — the shortcut would have moved the thing it is a shortcut to.
    if (pinned.length) groupedOptions[pinnedLabel] = pinned;
    filteredOptions.forEach((opt) => {
      let group = "Misc / General";
      if (opt.includes(" : ")) group = opt.split(" : ")[0];
      else if (opt.includes(" - ")) group = opt.split(" - ")[0];
      else if (opt.startsWith("XYi")) group = "XYi Internal";

      if (!groupedOptions[group]) groupedOptions[group] = [];
      groupedOptions[group].push(opt);
    });
  }

  const getDisplayLabel = (opt) => {
    if (isJob) return opt;
    if (isGrouped && opt.includes(" : "))
      return opt.split(" : ").slice(1).join(" : ");
    if (isGrouped && opt.includes(" - "))
      return opt.split(" - ").slice(1).join(" - ");
    return opt;
  };

  let gridClass = "grid-cols-1";
  if (isCountry) gridClass = "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4";
  else if (isTime) gridClass = "grid-cols-2";

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
            setActiveDropdown(null);
            onChange(searchTerm);
          }}
        />
      )}

      <div
        className={`relative flex items-center border rounded-xl z-50 transition-[border-color,background-color,box-shadow] ${
          disabled
            ? "opacity-45 cursor-not-allowed bg-transparent border-transparent"
            : isOpen
            ? `border-[#12a0e1] ring-4 ring-[#12a0e1]/10 ${
                isDarkModal ? "bg-[#1e2530]" : "bg-white"
              }`
            : `border-transparent ${
                isDarkModal
                  ? "hover:border-[#384252] hover:bg-[#1e2530]"
                  : "hover:border-slate-300 hover:bg-white/50 bg-transparent"
              }`
        }`}
      >
        {getPrefix && getPrefix(searchTerm) && (
          <span
            className={`pl-2.5 text-sm leading-none ${
              disabled ? "opacity-50" : ""
            }`}
          >
            {getPrefix(searchTerm)}
          </span>
        )}
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => {
            if (disabled) return;
            setSearchTerm(e.target.value);
            if (!isOpen) setActiveDropdown(dropdownId);
          }}
          onFocus={() => {
            if (!disabled) setActiveDropdown(dropdownId);
          }}
          disabled={disabled}
          placeholder={placeholder}
          title={searchTerm}
          className={`w-full py-2 px-2.5 bg-transparent text-[12px] font-semibold outline-none truncate ${
            isDarkModal
              ? "text-slate-100 placeholder:text-slate-600"
              : "text-slate-800 placeholder:text-slate-400"
          } ${isCountry && !isDarkModal ? "text-[#3b5998]" : ""} ${
            isTime ? "text-center" : ""
          } ${disabled ? "cursor-not-allowed" : ""}`}
        />
        <ChevronDown
          className={`w-3.5 h-3.5 mr-2 shrink-0 transition-transform duration-200 ${
            isOpen ? "rotate-180" : ""
          } ${
            disabled
              ? "text-slate-300"
              : isDarkModal
              ? "text-slate-500 hover:text-slate-400 cursor-pointer"
              : "text-slate-400 cursor-pointer"
          }`}
          onClick={() =>
            !disabled && setActiveDropdown(isOpen ? null : dropdownId)
          }
        />
      </div>

      {isOpen && (
        <div
          style={fixedStyle}
          className={`fixed border shadow-xl shadow-slate-200/40 max-h-[350px] overflow-y-auto custom-scrollbar animate-in fade-in slide-in-from-top-2 duration-200 rounded-2xl ${
            isDarkModal
              ? "bg-[#19202b] border-[#2d3748]"
              : "bg-white border-slate-200"
          }`}
        >
          {filteredOptions.length > 0 ? (
            isGrouped ? (
              Object.entries(groupedOptions)
                .sort(([groupA], [groupB]) => {
                  // The shortlist outranks even the active group: it is the
                  // reason the list was opened, and burying it under whichever
                  // group the current value belongs to defeats it.
                  if (groupA === pinnedLabel) return -1;
                  if (groupB === pinnedLabel) return 1;
                  const aIsMatch = value && value.includes(groupA);
                  const bIsMatch = value && value.includes(groupB);
                  if (aIsMatch && !bIsMatch) return -1;
                  if (!aIsMatch && bIsMatch) return 1;
                  return 0;
                })
                .map(([groupName, items]) => (
                  <div
                    key={groupName}
                    className={`border-b last:border-0 ${
                      isDarkModal ? "border-[#263143]" : "border-slate-100"
                    }`}
                  >
                    <div
                      className={`px-4 py-2 text-[10px] font-bold uppercase tracking-widest sticky top-0 z-10 flex items-center justify-between ${
                        isDarkModal
                          ? "bg-[#202938] text-[#4ea8de]"
                          : "bg-slate-50 text-[#12a0e1]"
                      }`}
                    >
                      <span>{groupName}</span>
                      {value && value.includes(groupName) && (
                        <span
                          className={`px-1.5 py-0.5 rounded-full text-[10px] font-black tracking-normal ${
                            isDarkModal
                              ? "bg-[#4ea8de]/20 text-[#4ea8de]"
                              : "bg-[#12a0e1]/10 text-[#12a0e1]"
                          }`}
                        >
                          ACTIVE
                        </span>
                      )}
                    </div>
                    <div
                      className={`grid gap-x-4 gap-y-1 p-2.5 ${
                        isCategory
                          ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
                          : "grid-cols-1"
                      }`}
                    >
                      {items.map((opt, i) => (
                        <button
                          type="button"
                          key={i}
                          onClick={() => {
                            setSearchTerm(opt);
                            onChange(opt);
                            setActiveDropdown(null);
                          }}
                          className={`w-full text-left px-3 py-2 text-[11px] font-semibold transition-[background-color,color] rounded-xl flex items-start leading-tight ${
                            value === opt
                              ? isDarkModal
                                ? "bg-[#12a0e1]/20 text-white font-bold"
                                : "bg-[#12a0e1]/10 text-[#12a0e1]"
                              : isDarkModal
                              ? "text-slate-300 hover:bg-[#253042] hover:text-white"
                              : "text-slate-700 hover:bg-[#12a0e1]/10 hover:text-[#12a0e1]"
                          }`}
                          title={opt}
                        >
                          <span
                            className={
                              isJob
                                ? "whitespace-normal break-words"
                                : "truncate"
                            }
                          >
                            {/* FULL label in the shortlist. Everywhere else the
                                group heading supplies the prefix, so items are
                                shown stripped ("Proofreading" under "Print").
                                The shortlist mixes families, and stripped
                                labels would show "Proofreading" twice with no
                                way to tell the Print one from the Digital. */}
                            {groupName === pinnedLabel ? opt : getDisplayLabel(opt)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))
            ) : (
              <div className={`grid gap-1 p-2 ${gridClass}`}>
                {[...filteredOptions]
                  .sort((a, b) => {
                    if (a === value) return -1;
                    if (b === value) return 1;
                    return 0;
                  })
                  .map((opt, i) => (
                    <button
                      type="button"
                      key={i}
                      onClick={() => {
                        setSearchTerm(opt);
                        onChange(opt);
                        setActiveDropdown(null);
                      }}
                      className={`w-full text-left py-2 text-[11px] font-semibold transition-[background-color,color] rounded-xl flex items-center ${
                        isTime
                          ? "justify-center font-mono font-bold px-1"
                          : "px-3 truncate"
                      } ${
                        value === opt
                          ? isDarkModal
                            ? "bg-[#12a0e1]/20 text-white font-bold"
                            : "bg-[#12a0e1]/10 text-[#12a0e1]"
                          : isDarkModal
                          ? "text-slate-300 hover:bg-[#253042] hover:text-white"
                          : "text-slate-700 hover:bg-[#12a0e1]/10 hover:text-[#12a0e1]"
                      }`}
                      title={opt}
                    >
                      {getPrefix && getPrefix(opt) && (
                        <span className="mr-2 text-base leading-none shrink-0">
                          {getPrefix(opt)}
                        </span>
                      )}
                      <span className={isTime ? "" : "truncate"}>{opt}</span>
                    </button>
                  ))}
              </div>
            )
          ) : (
            <div
              className={`px-4 py-3 text-xs italic ${
                isDarkModal ? "text-slate-500" : "text-slate-400"
              }`}
            >
              No matches found. Press enter to keep custom text.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
