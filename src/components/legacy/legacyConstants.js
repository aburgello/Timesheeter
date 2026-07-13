// Extracted verbatim from LegacyTimesheets.js — no logic changes.

export const COLUMNS = [
  "Job Number",
  "Client",
  "Film Title",
  "Project Description",
  "Country",
  "Category",
  "Client Amends",
  "Notes",
  "3D",
  "Time Spent",
  "Additional Time",
];

export const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

export const TIME_OPTIONS = [
  "none",
  ...Array.from({ length: 48 }, (_, i) => ((i + 1) * 0.5).toString()),
];

// --- HELPER: Dark Mode Dynamic Status Tags --
export const getDarkTagStyle = (tag) => {
  const baseStyle =
    "text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md border whitespace-nowrap inline-flex items-center justify-center shadow-sm";

  if (!tag)
    return `${baseStyle} bg-slate-800/50 text-slate-400 border-slate-700/50`;

  const lowerTag = String(tag).toLowerCase();

  if (lowerTag.includes("to amend"))
    return `${baseStyle} bg-rose-500/10 text-rose-400 border-rose-500/20`;
  if (lowerTag.includes("render review"))
    return `${baseStyle} bg-indigo-500/10 text-indigo-400 border-indigo-500/20`;
  if (lowerTag.includes("revised"))
    return `${baseStyle} bg-teal-500/10 text-teal-400 border-teal-500/20`;
  if (lowerTag.includes("creative approved"))
    return `${baseStyle} bg-blue-500/10 text-blue-400 border-blue-500/20`;
  if (lowerTag.includes("content approved"))
    return `${baseStyle} bg-purple-500/10 text-purple-400 border-purple-500/20`;
  if (lowerTag.includes("client review") || lowerTag.includes("content review"))
    return `${baseStyle} bg-yellow-500/10 text-yellow-400 border-yellow-500/20`;
  if (lowerTag.includes("motion"))
    return `${baseStyle} bg-emerald-500/10 text-emerald-400 border-emerald-500/20`;
  if (lowerTag.includes("digital"))
    return `${baseStyle} bg-cyan-500/10 text-cyan-400 border-cyan-500/20`;
  if (lowerTag.includes("prep for delivery"))
    return `${baseStyle} bg-orange-500/10 text-orange-400 border-orange-500/20`;
  if (lowerTag === "delivering" || lowerTag === "delivery")
    return `${baseStyle} bg-amber-500/10 text-amber-400 border-amber-500/20`;
  if (lowerTag.includes("on hold"))
    return `${baseStyle} bg-red-500/10 text-red-400 border-red-500/20`;
  if (lowerTag.includes("pm"))
    return `${baseStyle} bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/20`;
  if (lowerTag.includes("completed") || lowerTag.includes("delivered"))
    return `${baseStyle} bg-emerald-500/10 text-emerald-400 border-emerald-500/20`;

  return `${baseStyle} bg-slate-800/50 text-slate-300 border-slate-700/80`;
};
