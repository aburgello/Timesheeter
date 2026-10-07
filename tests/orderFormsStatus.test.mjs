import { orderUrgency, marketSummary, fileTotals, sortMarkets } from "../src/lib/orderForms/status.js";

const TODAY = "2026-10-07";
const order = (status, deliveryDeadline = "", mediaApproved = "") => ({ status, deliveryDeadline, mediaApproved });
const market = (name, orders, unreadable = null) => ({ name, code: "", unreadable, orders });

// ── Urgency ───────────────────────────────────────────────────────────────────
check("due today", orderUrgency(order("pending", "2026-10-07"), TODAY), "dueSoon");
check("due in 7 days", orderUrgency(order("pending", "2026-10-14"), TODAY), "dueSoon");
check("due in 8 days is not urgent", orderUrgency(order("pending", "2026-10-15"), TODAY), null);
check("yesterday is overdue", orderUrgency(order("unanswered", "2026-10-06"), TODAY), "overdue");
check("confirmed is never urgent", orderUrgency(order("confirmed", "2026-10-01"), TODAY), null);
check("no deadline is not urgent", orderUrgency(order("pending"), TODAY), null);
check("month boundary", orderUrgency(order("pending", "2026-11-03"), "2026-10-28"), "dueSoon");

// ── Market status ─────────────────────────────────────────────────────────────
const s = (orders, unreadable) => marketSummary(market("X", orders, unreadable), TODAY);

check("all unanswered: not started", s([order("unanswered"), order("unanswered")]).status, "notStarted");
check("no orders: not started", s([]).status, "notStarted");
check("every answered order confirmed", s([order("confirmed"), order("unanswered")]).status, "confirmed");
check("any pending: pending", s([order("confirmed"), order("pending")]).status, "pending");
check("unreadable", s([], "No header row found").status, "unreadable");

const mixed = s([
  order("confirmed", "2026-10-02", "Yes"),
  order("pending", "2026-10-20", "No"),
  order("pending", "2026-10-09", "approved"),
  order("unanswered"),
]);
check("counts", [mixed.total, mixed.confirmed, mixed.pending, mixed.unanswered], [4, 1, 2, 1]);
check("media approved count", mixed.mediaApproved, 2);
check("next deadline skips confirmed orders", mixed.nextDeadline, "2026-10-09");
check("market urgency", mixed.urgency, "dueSoon");

check("overdue outranks due soon",
  s([order("pending", "2026-10-09"), order("pending", "2026-10-01")]).urgency, "overdue");
check("all confirmed: earliest deadline, no urgency",
  [s([order("confirmed", "2026-10-20"), order("confirmed", "2026-10-02")]).nextDeadline,
   s([order("confirmed", "2026-10-02")]).urgency],
  ["2026-10-02", null]);
check("no deadlines at all", s([order("pending")]).nextDeadline, "");

// ── File totals and default order ─────────────────────────────────────────────
const file = {
  markets: [
    market("Japan", [order("unanswered")]),
    market("Germany", [order("confirmed", "2026-10-30")]),
    market("Italy", [order("pending", "2026-11-20")]),
    market("France", [order("pending", "2026-10-09")]),
    market("Spain", [order("pending", "2026-10-01")]),
    market("Broken", [], "No header row found"),
  ],
};
check("totals", fileTotals(file, TODAY), { markets: 6, orders: 5, confirmed: 1, pending: 3, due: 2, notStarted: 1 });

const sorted = sortMarkets(file.markets.map((m) => marketSummary(m, TODAY))).map((m) => m.name);
check("default order: urgent, pending, confirmed, not started, unreadable",
  sorted, ["Spain", "France", "Italy", "Germany", "Japan", "Broken"]);
