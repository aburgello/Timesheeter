import React from "react";
import { PAGE_GRADIENTS } from "../../lib/pageGradients";

// Full-bleed page header whose gradient matches the Home row it was
// navigated from (see src/lib/pageGradients.js) — the header IS the row,
// grown, so the Home wash-transition resolves directly into it instead of
// cutting to an unrelated white card. Used by every top-level page.
export default function PageHeader({ pageId, icon: Icon, title, subtitle, children, maxWidthClass = "max-w-[1800px]" }) {
  const gradient = PAGE_GRADIENTS[pageId] || PAGE_GRADIENTS.timesheet;

  return (
    <div className={`bg-gradient-to-br ${gradient} py-6 sm:py-7`}>
      {/* Padding lives inside the max-width box, not on this outer
          full-bleed wrapper — matching the page body's own
          max-w-[1800px] + px-6 pattern exactly, so the header's
          right-aligned children line up with the content below at any width
          (see the >1800px alignment fix). */}
      <div className={`${maxWidthClass} mx-auto px-4 sm:px-6 flex flex-col sm:flex-row sm:items-center gap-5`}>
        <div className="flex items-center gap-4 min-w-0 flex-1">
          {Icon && (
            <div className="shrink-0 w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-white/15 border border-white/20 backdrop-blur-sm flex items-center justify-center">
              <Icon className="w-7 h-7 sm:w-8 sm:h-8 text-white" strokeWidth={1.75} />
            </div>
          )}
          <div className="min-w-0">
            <h1 className="font-display text-xl sm:text-2xl font-bold text-white tracking-tight truncate">
              {title}
            </h1>
            {subtitle && (
              <p className="text-xs sm:text-sm text-white/80 font-medium mt-0.5 truncate">
                {subtitle}
              </p>
            )}
          </div>
        </div>

        {children && (
          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

// Shared className for action buttons rendered inside a PageHeader — white
// translucent pill, legible on any of the section gradients.
export const pageHeaderActionClass =
  "flex items-center gap-2 px-4 py-2 bg-white/15 hover:bg-white/25 text-white border border-white/20 backdrop-blur-sm rounded-xl transition-all shadow-sm font-bold text-sm disabled:opacity-50 disabled:cursor-not-allowed";
