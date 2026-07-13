import React from "react";
import { ChevronRight } from "lucide-react";

// The app's one drill-down navigation idiom — a full-width, large-target row
// with a gradient sweep on hover/focus. First used on Profile Hub, reused
// wherever a page needs "pick one of a few things" navigation (Administration)
// instead of a tab bar or a card grid — same shape everywhere a manager might
// need to navigate, regardless of how comfortable they are with software.
//
// `open` is optional and switches the chevron from "this navigates
// somewhere" (slides right on hover) to "this expands in place" (rotates
// 90deg when open) — used when a row toggles an accordion instead of
// changing the page. Omit it entirely for real navigation.
//
// `compact` scales the row down for nesting inside another HubRow's
// accordion (smaller icon/type, tighter padding, left-indented) while
// keeping the exact same gradient-sweep/hover behavior — so a submenu row
// and its parent row feel like the same control at two sizes, not two
// different components that happen to look similar.
export default function HubRow({ section, onClick, badge, first, open, compact }) {
  const { label, desc, icon: Icon, gradient } = section;
  return (
    <button
      onClick={onClick}
      className={`group relative w-full flex items-center text-left border-b border-[#dce4ec] last:border-b-0 focus:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-white/70 ${
        compact ? "gap-4 pl-9 pr-5 sm:pl-12 sm:pr-7 py-4" : "gap-4 sm:gap-5 px-5 sm:px-7 py-5"
      }`}
    >
      <div
        className={`absolute inset-0 bg-gradient-to-r ${gradient} origin-left scale-x-0 group-hover:scale-x-100 group-focus:scale-x-100 transition-transform duration-300 ease-out`}
      />

      {/* Icon chip: gradient-filled at rest, translucent-white once the row
          it sits on has itself gone gradient. */}
      <div
        className={`relative z-10 shrink-0 rounded-2xl bg-gradient-to-br ${gradient} group-hover:bg-none group-hover:bg-white/20 group-focus:bg-none group-focus:bg-white/20 flex items-center justify-center text-white transition-colors duration-300 ${
          compact ? "w-9 h-9" : "w-11 h-11"
        }`}
      >
        <Icon className={compact ? "w-4 h-4" : "w-5 h-5"} />
      </div>

      <div className="relative z-10 min-w-0 flex-1 overflow-hidden">
        <div data-hub-rise>
          <p
            className={`font-display font-bold tracking-tight leading-none text-[#122027] group-hover:text-white group-focus:text-white transition-colors duration-300 ${
              compact ? "text-sm sm:text-base" : first ? "text-2xl sm:text-3xl" : "text-xl sm:text-2xl"
            }`}
          >
            {label}
          </p>
          <p className={`text-[#768994] group-hover:text-white/80 group-focus:text-white/80 mt-1 truncate transition-colors duration-300 ${compact ? "text-xs" : "text-xs sm:text-sm"}`}>
            {desc}
          </p>
        </div>
      </div>

      <div className="relative z-10 flex items-center gap-3 shrink-0">
        {badge}
        {open === undefined ? (
          <ChevronRight className={`text-[#768994] group-hover:text-white group-focus:text-white group-hover:translate-x-1 transition-all duration-300 ${compact ? "w-4 h-4" : "w-5 h-5"}`} />
        ) : (
          <ChevronRight
            className={`text-[#768994] group-hover:text-white group-focus:text-white transition-transform duration-300 ${open ? "rotate-90" : ""} ${compact ? "w-4 h-4" : "w-5 h-5"}`}
          />
        )}
      </div>
    </button>
  );
}
