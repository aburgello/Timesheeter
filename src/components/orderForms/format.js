// Display helpers shared by the Order Forms screens.

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
  notStarted: "Not started",
  unreadable: "Couldn't read",
};

export const STATUS_CLASS = {
  confirmed: "bg-[#1cc1a5]/15 text-[#0b7a68]",
  pending: "bg-amber-100 text-amber-800",
  unanswered: "bg-slate-100 text-slate-500",
  notStarted: "bg-slate-100 text-slate-500",
  unreadable: "bg-rose-50 text-rose-700",
};

export const URGENCY_LABEL = { overdue: "Overdue", dueSoon: "Due this week" };
export const URGENCY_TEXT = { overdue: "text-rose-600", dueSoon: "text-amber-700" };

export const pillClass = "inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-bold whitespace-nowrap";
