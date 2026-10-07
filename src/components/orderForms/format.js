// Display helpers shared by the Order Forms screens.

import { TERRITORY_FLAGS } from "../../constants";
import { resolveCountryCode } from "../../utils/countryCodes";

// Spellings the order sheets use that the app's territory list and aliases don't.
const SHEET_NAMES = { Turkey: "Türkiye", "United Kingdom": "UK", "United States": "USA", "South Korea": "Korea" };

// A market's flag from its name as the index or a tab gives it: "Croatia",
// "Germany (GER)", "Czechia". The name is tried as written, then as a known
// sheet spelling, then through the same aliases task names resolve with, then
// by the code in its brackets. "" when nothing matches, so an unknown market
// shows no flag rather than a wrong one.
export function marketFlag(name) {
  const text = String(name || "").trim();
  const bare = text.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const code = /\(([^)]+)\)\s*$/.exec(text)?.[1] || "";
  for (const candidate of [bare, SHEET_NAMES[bare], resolveCountryCode(bare), code && resolveCountryCode(code)]) {
    if (candidate && TERRITORY_FLAGS[candidate]) return TERRITORY_FLAGS[candidate];
  }
  return "";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-10-14" → "14 Oct", with the year only when it isn't this one.
export function formatDay(iso, todayIso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const day = `${d} ${MONTHS[m - 1]}`;
  return todayIso && iso.slice(0, 4) !== todayIso.slice(0, 4) ? `${day} ${y}` : day;
}

export function loadedAgo(loadedAt, now = new Date()) {
  const days = Math.floor((now - new Date(loadedAt)) / 86400000);
  if (days <= 0) return "loaded today";
  return days === 1 ? "loaded yesterday" : `loaded ${days} days ago`;
}

export const STATUS_LABEL = {
  confirmed: "Confirmed",
  pending: "Pending",
  unanswered: "Unanswered",
  unconfirmed: "Unconfirmed",
  notStarted: "Not started",
  unreadable: "Couldn't read",
};

export const STATUS_CLASS = {
  confirmed: "bg-emerald-100 text-emerald-700",
  pending: "bg-amber-100 text-amber-800",
  unanswered: "bg-slate-100 text-slate-500",
  unconfirmed: "bg-violet-100 text-violet-700",
  notStarted: "bg-slate-100 text-slate-500",
  unreadable: "bg-rose-50 text-rose-700",
};

export const URGENCY_LABEL = { overdue: "Overdue", dueSoon: "Due this week" };
export const URGENCY_TEXT = { overdue: "text-rose-600", dueSoon: "text-amber-700" };

export const pillClass = "inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-bold whitespace-nowrap";
