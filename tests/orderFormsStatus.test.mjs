import { orderUrgency, marketSummary, fileTotals, sortMarkets } from "../src/lib/orderForms/status.js";

const TODAY = "2026-10-07";
// Every order has a delivery deadline: that is what makes a row an order.
const order = (status, deliveryDeadline = "2026-12-01", mediaApproved = "") => ({ status, deliveryDeadline, mediaApproved });
const market = (name, orders, unreadable = null, undated = 0) => ({ name, code: "", unreadable, orders, undated });

// ── Urgency ───────────────────────────────────────────────────────────────────
check("due today", orderUrgency(order("pending", "2026-10-07"), TODAY), "dueSoon");
check("due in 7 days", orderUrgency(order("pending", "2026-10-14"), TODAY), "dueSoon");
check("due in 8 days is not urgent", orderUrgency(order("pending", "2026-10-15"), TODAY), null);
check("yesterday is overdue", orderUrgency(order("unanswered", "2026-10-06"), TODAY), "overdue");
check("confirmed is never urgent", orderUrgency(order("confirmed", "2026-10-01"), TODAY), null);
check("month boundary", orderUrgency(order("pending", "2026-11-03"), "2026-10-28"), "dueSoon");

// ── Market status ─────────────────────────────────────────────────────────────
const s = (orders, unreadable, undated) => marketSummary(market("X", orders, unreadable, undated), TODAY);

check("no orders: not started", s([]).status, "notStarted");
check("orders in, none answered: unconfirmed", s([order("unanswered"), order("unanswered")]).status, "unconfirmed");
check("every order confirmed: confirmed", s([order("confirmed"), order("confirmed")]).status, "confirmed");
check("any pending: pending", s([order("confirmed"), order("pending")]).status, "pending");
// Kazakhstan on Street Fighter: 8 confirmed, 4 never answered.
check("some confirmed, some unanswered: pending, not confirmed",
  s([order("confirmed"), order("confirmed"), order("unanswered")]).status, "pending");
check("pending and unanswered: pending", s([order("pending"), order("unanswered")]).status, "pending");
check("unreadable", s([], "No header row found").status, "unreadable");
check("rows without a deadline are carried through", s([], null, 3).undated, 3);
check("a market with only undated rows has not started", s([], null, 3).status, "notStarted");

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

// ── File totals and default order ─────────────────────────────────────────────
const file = {
  markets: [
    market("Japan", []),
    market("Germany", [order("confirmed", "2026-10-30")]),
    market("Italy", [order("pending", "2026-11-20")]),
    market("France", [order("pending", "2026-10-09")]),
    market("Spain", [order("pending", "2026-10-01")]),
    market("Croatia", [order("unanswered", "2026-12-01")]),
    market("Broken", [], "No header row found"),
  ],
};
check("totals", fileTotals(file, TODAY), { markets: 7, orders: 5, confirmed: 1, pending: 3, unconfirmed: 1, due: 2, notStarted: 1 });

const sorted = sortMarkets(file.markets.map((m) => marketSummary(m, TODAY))).map((m) => m.name);
check("default order: urgent, pending, unconfirmed, confirmed, not started, unreadable",
  sorted, ["Spain", "France", "Italy", "Croatia", "Germany", "Japan", "Broken"]);
