// Extracted verbatim from LegacyTimesheets.js — no logic changes.
// Self-contained: only reads its own props and internal state, no closure
// over LegacyTimesheet's component state.
import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { ChevronDown, Minus, Plus } from "lucide-react";
import { layoutRect, layoutViewport } from "../../utils/zoom";
import { isUnset } from "../../constants";
import { parseTimeToHours, parseTimeToSeconds, secondsToHM } from "../../utils/timeHelpers";

const STEP_SECONDS = 15 * 60;
const MAX_SECONDS = 24 * 3600; // the last entry in TIME_OPTIONS

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
  // For a cell too narrow for the usual field: no chevron and next to no side
  // padding, so the value has the width. The field still opens on focus. The
  // Wrike Hub's day cells are 44px, and the normal padding and chevron take 42
  // of them.
  compact = false,
  // Options to surface in their own group at the very top — the caller's
  // "you keep picking these" shortlist. Only shown while the list is
  // unfiltered: once you are searching you have said what you want, and a
  // shortlist above the matches is then just a duplicate of some of them.
  pinnedOptions = [],
  // Appended to the input's tooltip, on its own line — see MultiCountrySelect's
  // `hint` for why this can't live on the cell around it.
  hint = "",
  pinnedLabel = "Most used",
  // Set where this field is required and still empty. Same rule and the same
  // rose as MultiCountrySelect's prop of the same name, deliberately: country
  // and category are the two things a row can't go over to the timesheet
  // without, and a person scanning the table shouldn't have to learn two
  // different signals for one kind of gap.
  needsAttention = false,
  // Time fields only: a minus and a plus either side of the value, moving it
  // 0:15 at a time — the same control "Where did my day go?" uses. The value
  // between them is still this select, so the list and typing a time both
  // work as before.
  stepper = false,
  // Time fields only: the most this one may hold, in seconds. Plus stops
  // there, the list ends there, and a typed time over it is brought back down
  // (onOverMax tells the caller, so it can say why).
  maxSeconds = null,
  onOverMax,
  // Told about each step that moved the value: (direction, the cell's element).
  // The grid uses it to drop a coin into the day's total.
  onStep,
}) {
  const isOpen = activeDropdown === dropdownId && !disabled;
  const [searchTerm, setSearchTerm] = useState(value || "");
  const wrapperRef = useRef(null);
  const inputRef = useRef(null);
  const [fixedStyle, setFixedStyle] = useState({});

  // `disabled` too: a step still waiting to be saved when the day is locked is
  // turned away by the caller, and the cell has to go back to the saved value.
  useEffect(() => {
    setSearchTerm(value || "");
  }, [value, disabled]);

  // Steps show at once but are saved together, a moment after the last click.
  // Saving each one sent a request per click, and five quick clicks are five
  // requests that can land out of order and leave an earlier time stored.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const pendingStep = useRef(null);
  const stepTimer = useRef(null);
  const flushStep = () => {
    clearTimeout(stepTimer.current);
    if (pendingStep.current === null) return;
    const next = pendingStep.current;
    pendingStep.current = null;
    onChangeRef.current(next);
  };
  // Leaving the day (or the page) mid-wait still saves the step.
  useEffect(() => flushStep, []); // eslint-disable-line react-hooks/exhaustive-deps

  const ceiling = isTime && maxSeconds !== null ? Math.min(MAX_SECONDS, maxSeconds) : MAX_SECONDS;
  // Every way a value leaves this select goes through here, so the ceiling
  // holds whether the time was stepped, picked or typed.
  const commit = (next) => {
    if (isTime && maxSeconds !== null && parseTimeToSeconds(next) > ceiling) {
      const capped = secondsToHM(ceiling);
      setSearchTerm(capped);
      onOverMax?.();
      onChange(capped);
      return;
    }
    onChange(next);
  };

  const showStepper = stepper && isTime && !disabled;
  const seconds = parseTimeToSeconds(pendingStep.current ?? value);
  // From an off-grid time (a pull can log 1:10) a step lands on the grid first:
  // 1:10 goes up to 1:15 and down to 1:00.
  const step = (direction) => {
    const onGrid =
      direction > 0
        ? Math.floor(seconds / STEP_SECONDS) * STEP_SECONDS + STEP_SECONDS
        : Math.ceil(seconds / STEP_SECONDS) * STEP_SECONDS - STEP_SECONDS;
    const next = secondsToHM(Math.min(ceiling, Math.max(0, onGrid)));
    if (parseTimeToSeconds(next) !== seconds) {
      onStep?.(direction, wrapperRef.current);
      // The new figure comes up from below on +, down from above on -. Through
      // the Web Animations API so a second click mid-slide starts it again
      // cleanly; a CSS class already on the element would not replay.
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        inputRef.current?.animate(
          [{ transform: `translateY(${direction > 0 ? 60 : -60}%)`, opacity: 0 }, { transform: "none", opacity: 1 }],
          { duration: 200, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
        );
      }
    }
    pendingStep.current = next;
    setSearchTerm(next);
    setActiveDropdown(null);
    clearTimeout(stepTimer.current);
    stepTimer.current = setTimeout(flushStep, 400);
  };
  const stepButtonClass =
    "w-6 self-stretch shrink-0 flex items-center justify-center text-slate-400 hover:text-[#12a0e1] hover:bg-[#12a0e1]/10 disabled:opacity-30 disabled:hover:text-slate-400 disabled:hover:bg-transparent transition-colors focus:outline-none focus-visible:bg-[#12a0e1]/15 focus-visible:text-[#12a0e1]";

  // Compute fixed position on open so the dropdown escapes any overflow container.
  // useLayoutEffect fires before paint so the dropdown never renders at position 0,0.
  useLayoutEffect(() => {
    if (!isOpen || !wrapperRef.current) return;
    // layoutRect (not getBoundingClientRect) so the trigger's coordinates are
    // in the same layout space as innerWidth/Height and the fixed style we set
    // below. Under a non-1 html{zoom} a raw rect is visual pixels, which the
    // browser would zoom a second time on paint — landing the dropdown offset
    // from its trigger, worse the further down/right the row is. The app's own
    // zoom: 1.1 has since been removed, so the correction is currently a no-op.
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
    if (isTime && maxSeconds !== null && parseTimeToSeconds(opt) > ceiling) return false;
    if (searchTerm === value) return true;
    const term = searchTerm.toLowerCase();
    // Times are listed H:MM; anyone typing decimal hours ("1.5") out of habit
    // still finds 1:30.
    if (isTime && opt !== "none" && String(parseTimeToHours(opt)).startsWith(term)) return true;
    return opt.toLowerCase().includes(term);
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

  // Keyed off the committed `value`, never `searchTerm`. searchTerm doubles as
  // the search box, so it is legitimately empty the moment someone clears it to
  // type — reading that as "nothing chosen" would flash the cell red while they
  // were in the middle of choosing. An open dropdown paints blue anyway, so in
  // practice this only shows on a closed, untouched cell.
  const showAttention = needsAttention && isUnset(value) && !disabled;

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
            commit(searchTerm);
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
            : showAttention
            ? `border-rose-400 ring-2 ring-rose-400/15 ${
                isDarkModal ? "bg-rose-500/5" : "bg-rose-50/60"
              }`
            : showStepper
            ? "border-[#dce4ec] hover:border-slate-300 bg-white overflow-hidden"
            : `border-transparent ${
                isDarkModal
                  ? "hover:border-[#384252] hover:bg-[#1e2530]"
                  : "hover:border-slate-300 hover:bg-white/50 bg-transparent"
              }`
        }`}
      >
        {showStepper && (
          <button
            type="button"
            onClick={() => step(-1)}
            disabled={seconds <= 0}
            aria-label="15 minutes less"
            className={`${stepButtonClass} rounded-l-[11px]`}
          >
            <Minus className="w-3 h-3" strokeWidth={2.5} />
          </button>
        )}
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
          ref={inputRef}
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
          title={[searchTerm, hint].filter(Boolean).join("\n")}
          className={`w-full min-w-0 py-2 ${showStepper ? "px-0 tabular-nums" : compact ? "px-0.5 tabular-nums" : "px-2.5"} bg-transparent text-[12px] font-semibold outline-none truncate ${
            isDarkModal
              ? "text-slate-100 placeholder:text-slate-600"
              : "text-slate-800 placeholder:text-slate-400"
          } ${showAttention ? "placeholder:text-rose-500" : ""} ${
            isCountry && !isDarkModal ? "text-[#3b5998]" : ""
          } ${
            isTime ? "text-center" : ""
          } ${
            // An unset time says "none" in every row of the column. Dimmed, the
            // rows that do have a time are the ones that read.
            isTime && searchTerm === "none" && !showAttention && !isOpen ? "opacity-35" : ""
          } ${disabled ? "cursor-not-allowed" : ""}`}
        />
        {showStepper ? (
          <button
            type="button"
            onClick={() => step(1)}
            disabled={seconds >= ceiling}
            aria-label="15 minutes more"
            className={`${stepButtonClass} rounded-r-[11px]`}
          >
            <Plus className="w-3 h-3" strokeWidth={2.5} />
          </button>
        ) : compact ? null : (
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
        )}
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
                            commit(opt);
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
                        commit(opt);
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
