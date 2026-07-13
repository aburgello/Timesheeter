// Single source of truth for each page's color identity — used by Home.jsx
// for its section rows/exit wash, and by each destination page's own header
// so the wash-lift transition resolves seamlessly into the page underneath
// instead of cutting to an unrelated color.
export const PAGE_GRADIENTS = {
  timesheet: "from-[#12a0e1] to-[#1cc1a5]",
  todayslist: "from-violet-500 to-purple-600",
  canvas: "from-amber-600 to-orange-700",
  legacy: "from-slate-500 to-slate-700",
  profile: "from-sky-600 to-blue-600",
  management: "from-[#122027] to-[#12a0e1]",
  jobbook: "from-teal-600 to-emerald-700",
};
