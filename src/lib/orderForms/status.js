// What the Order Forms screens show about a market, worked out from its orders.
// Derived on display rather than stored, so changing a rule here doesn't mean
// re-loading anyone's files.

const DUE_SOON_DAYS = 7;

const addDays = (iso, days) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

// A confirmed order is done as far as the market is concerned, so only the
// others can be late.
export function orderUrgency(order, todayIso) {
  if (order.status === "confirmed" || !order.deliveryDeadline) return null;
  if (order.deliveryDeadline < todayIso) return "overdue";
  return order.deliveryDeadline <= addDays(todayIso, DUE_SOON_DAYS) ? "dueSoon" : null;
}

// Has the market entered anything on this row? The template ships with sizes,
// placement and duration already in, so those don't count: a row is filled in
// once it has something only the market could have typed.
const MARKET_ENTERED = ["siteName", "deliveryDeadline", "liveDate", "artwork", "translations", "notes", "mediaApproved"];
export const isFilledIn = (order) => MARKET_ENTERED.some((field) => order[field]);

const isApproved = (value) => /^(y|yes|approved)/i.test(String(value || "").trim());

const earliest = (orders) =>
  orders.map((o) => o.deliveryDeadline).filter(Boolean).sort()[0] || "";

export function marketSummary(market, todayIso) {
  const orders = market.orders;
  const count = (status) => orders.filter((o) => o.status === status).length;
  const confirmed = count("confirmed");
  const pending = count("pending");
  const unanswered = count("unanswered");

  let status;
  if (market.unreadable) status = "unreadable";
  // Orders entered but the confirmation column never answered is its own
  // state: the market has done the work, and a PM needs to chase the answer.
  else if (confirmed + pending === 0) status = orders.some(isFilledIn) ? "unconfirmed" : "notStarted";
  else status = pending === 0 ? "confirmed" : "pending";

  const urgencies = orders.map((o) => orderUrgency(o, todayIso));
  const urgency = urgencies.includes("overdue") ? "overdue" : urgencies.includes("dueSoon") ? "dueSoon" : null;

  const open = orders.filter((o) => o.status !== "confirmed");
  return {
    name: market.name,
    code: market.code,
    unreadable: market.unreadable,
    status,
    total: orders.length,
    confirmed,
    pending,
    unanswered,
    mediaApproved: orders.filter((o) => isApproved(o.mediaApproved)).length,
    nextDeadline: earliest(open) || earliest(orders),
    urgency,
  };
}

export function fileTotals(file, todayIso) {
  const summaries = file.markets.map((m) => marketSummary(m, todayIso));
  const count = (test) => summaries.filter(test).length;
  return {
    markets: summaries.length,
    orders: summaries.reduce((n, m) => n + m.total, 0),
    confirmed: count((m) => m.status === "confirmed"),
    pending: count((m) => m.status === "pending"),
    unconfirmed: count((m) => m.status === "unconfirmed"),
    due: count((m) => m.urgency),
    notStarted: count((m) => m.status === "notStarted"),
  };
}

// The order a PM needs to read them in: what's late or nearly due, then what's
// still open or unanswered, then what's settled, then markets that haven't begun.
const rank = (m) => {
  if (m.status === "unreadable") return 6;
  if (m.urgency === "overdue") return 0;
  if (m.urgency === "dueSoon") return 1;
  return { pending: 2, unconfirmed: 3, confirmed: 4, notStarted: 5 }[m.status];
};

export function sortMarkets(summaries) {
  return [...summaries].sort((a, b) =>
    rank(a) - rank(b) ||
    (a.nextDeadline || "9999").localeCompare(b.nextDeadline || "9999") ||
    a.name.localeCompare(b.name));
}
