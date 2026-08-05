import React, { useState, useEffect } from "react";
import { ChevronDown, Search } from "lucide-react";

const SearchableSelect = ({
  options,
  value,
  onChange,
  placeholder,
  disabled,
  icon: Icon,
  quickFilters,
  getPrefix,
  isGrouped = false,
  // Optional (groupName, items) => number, higher sorts nearer the top. Opt-in
  // because insertion order is meaningful for curated lists like CATEGORIES,
  // but meaningless for an append-only one like jobOptions — where it simply
  // means "whatever was seen first", i.e. the oldest films.
  groupRank = null,
  alignRight = false,
  // Optional shared-dropdown props (same pattern as LegacyTimesheets)
  // When provided, only one dropdown can be open at a time across siblings.
  dropdownId,
  activeDropdown,
  setActiveDropdown,
}) => {
  const [localOpen, setLocalOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState(value);

  // Shared mode: open when this ID is active; local mode: use own state
  const isShared = dropdownId !== undefined && activeDropdown !== undefined && setActiveDropdown !== undefined;
  const isOpen = isShared ? activeDropdown === dropdownId : localOpen;

  const openDropdown = () => {
    if (isShared) setActiveDropdown(dropdownId);
    else setLocalOpen(true);
  };
  const closeDropdown = () => {
    if (isShared) setActiveDropdown(null);
    else setLocalOpen(false);
  };
  const toggleDropdown = () => (isOpen ? closeDropdown() : openDropdown());

  useEffect(() => setSearchTerm(value), [value]);

  const filteredOptions = options.filter((opt) =>
    opt.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const groupedOptions = {};
  if (isGrouped) {
    filteredOptions.forEach((opt) => {
      let group = "Misc / General";
      if (opt.includes(" : ")) {
        group = opt.split(" : ")[0];
      } else if (opt.includes(" - ")) {
        group = opt.split(" - ")[0];
      } else if (opt.startsWith("XYi")) {
        group = "XYi Internal";
      }
      if (!groupedOptions[group]) groupedOptions[group] = [];
      groupedOptions[group].push(opt);
    });
  }

  // Group order: by rank when the caller supplies one, alphabetically within
  // equal ranks so the list is stable and scannable rather than arbitrary.
  const groupEntries = Object.entries(groupedOptions);
  if (isGrouped && groupRank) {
    groupEntries.sort(
      (a, b) =>
        groupRank(b[0], b[1]) - groupRank(a[0], a[1]) || a[0].localeCompare(b[0])
    );
  }

  const getDisplayLabel = (opt) => {
    if (isGrouped && opt.includes(" : "))
      return opt.split(" : ").slice(1).join(" : ");
    if (isGrouped && opt.includes(" - "))
      return opt.split(" - ").slice(1).join(" - ");
    return opt;
  };

  return (
    <div className={`relative w-full flex-1 ${isOpen ? "z-[999999]" : "z-20"}`}>
      <style>{`
        @keyframes shine {
          0% { transform: translateX(-150%) skewX(-15deg); }
          100% { transform: translateX(150%) skewX(-15deg); }
        }
        /* animation-fill-mode matters here: without it the sweep snaps back to its
           un-animated position when the last iteration ends — which is dead
           centre over the chip — leaving a permanent pale blob sitting there.
           Holding the final keyframe parks it off the right edge instead,
           where overflow-hidden clips it away. */
        .animate-shine-6 { animation: shine 1.5s ease-in-out 10 forwards; }
        @media (prefers-reduced-motion: reduce) {
          .animate-shine-6 { animation: none; opacity: 0; }
        }
      `}</style>

      {quickFilters && (
        <div className="flex flex-wrap gap-2 mb-2">
          {quickFilters.map((filter, i) => (
            <button
              type="button"
              key={filter}
              onClick={() => { setSearchTerm(filter); openDropdown(); }}
              disabled={disabled}
              className="relative overflow-hidden px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-[#12a0e1]/10 hover:bg-[#12a0e1]/20 text-[#12a0e1] rounded-md border border-[#12a0e1]/20 transition-colors disabled:opacity-50"
            >
              {/* The lead chip gets the sweep, whatever it's called — the
                  filter list is department-specific (see jobQuickFiltersFor). */}
              {i === 0 && (
                <span className="absolute inset-0 w-full h-full bg-gradient-to-r from-transparent via-white/80 to-transparent animate-shine-6 pointer-events-none" />
              )}
              <span className="relative z-10">{filter}</span>
            </button>
          ))}
        </div>
      )}

      {isOpen && (
        <div
          className="fixed inset-0 z-40"
          onMouseDown={(e) => {
            e.stopPropagation();
            closeDropdown();
            onChange(searchTerm);
          }}
        />
      )}

      <div
        className={`relative flex items-center bg-white border focus-within:ring-2 focus-within:ring-[#12a0e1]/20 focus-within:border-[#12a0e1] transition-all rounded-xl z-50 ${
          disabled
            ? "opacity-60 bg-slate-50"
            : "hover:border-slate-300 border-[#dce4ec] shadow-sm"
        }`}
      >
        <div className="pl-3.5 pr-1.5 text-[#768994] flex items-center justify-center min-w-[28px]">
          {getPrefix && getPrefix(searchTerm) ? (
            <span className="text-base leading-none">{getPrefix(searchTerm)}</span>
          ) : Icon ? (
            <Icon className="w-4 h-4" />
          ) : (
            <Search className="w-4 h-4" />
          )}
        </div>
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => { setSearchTerm(e.target.value); openDropdown(); }}
          onFocus={() => { if (!disabled) openDropdown(); }}
          placeholder={placeholder}
          disabled={disabled}
          className="w-full py-2.5 px-2 bg-transparent text-sm text-[#122027] outline-none placeholder:text-[#768994]"
        />
        <div
          className="pr-3.5 pl-1.5 text-[#768994] cursor-pointer"
          onClick={() => !disabled && toggleDropdown()}
        >
          <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`} />
        </div>
      </div>

      {isOpen && !disabled && (
        <div
          className={`absolute top-full mt-2 bg-white/95 backdrop-blur-xl border border-[#dce4ec] rounded-xl shadow-xl z-[999999] max-h-80 overflow-y-auto overscroll-contain animate-in fade-in slide-in-from-top-2 duration-200 w-full sm:min-w-[600px] md:min-w-[750px] lg:min-w-[900px] ${
            alignRight ? "right-0" : "left-0"
          }`}
        >
          {filteredOptions.length > 0 ? (
            isGrouped ? (
              groupEntries.map(([groupName, items]) => (
                <div key={groupName} className="border-b border-slate-100 last:border-0">
                  <div className="px-4 py-1.5 text-[10px] font-black text-[#12a0e1] uppercase tracking-widest bg-slate-50 sticky top-0 z-10 border-b border-slate-100/60">
                    {groupName}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-1 p-2">
                    {items.map((opt, i) => {
                      const displayLabel = getDisplayLabel(opt);
                      return (
                        <button
                          type="button"
                          key={i}
                          onClick={() => { setSearchTerm(opt); onChange(opt); closeDropdown(); }}
                          className="w-full text-left px-3 py-2 text-xs text-[#323b43] hover:bg-[#12a0e1]/10 hover:text-[#12a0e1] transition-colors rounded-lg flex items-center group/item"
                          title={opt}
                        >
                          <span className="truncate w-full">
                            {searchTerm
                              ? displayLabel
                                  .split(new RegExp(`(${searchTerm})`, "gi"))
                                  .map((part, index) =>
                                    part.toLowerCase() === searchTerm.toLowerCase() ? (
                                      <span key={index} className="bg-[#12a0e1]/20 font-semibold text-[#122027] rounded-sm px-0.5">
                                        {part}
                                      </span>
                                    ) : part
                                  )
                              : displayLabel}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1 p-2">
                {filteredOptions.map((opt, i) => (
                  <button
                    type="button"
                    key={i}
                    onClick={() => { setSearchTerm(opt); onChange(opt); closeDropdown(); }}
                    className="w-full text-left px-3 py-2 text-xs text-[#323b43] hover:bg-[#12a0e1]/10 hover:text-[#12a0e1] transition-colors rounded-lg truncate flex items-center"
                    title={opt}
                  >
                    {getPrefix && getPrefix(opt) && (
                      <span className="mr-2 text-base leading-none">{getPrefix(opt)}</span>
                    )}
                    {searchTerm ? (
                      <span>
                        {opt
                          .split(new RegExp(`(${searchTerm})`, "gi"))
                          .map((part, index) =>
                            part.toLowerCase() === searchTerm.toLowerCase() ? (
                              <span key={index} className="bg-[#12a0e1]/20 font-semibold text-[#122027] rounded-sm px-0.5">
                                {part}
                              </span>
                            ) : part
                          )}
                      </span>
                    ) : opt}
                  </button>
                ))}
              </div>
            )
          ) : (
            <div className="px-4 py-3 text-sm text-[#768994] italic">
              No exact matches. Type to create new entry.
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default SearchableSelect;
