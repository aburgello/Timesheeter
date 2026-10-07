import { orderUrgency, marketSummary, fileTotals, sortMarkets, isFilledIn } from "../src/lib/orderForms/status.js";

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

// Orders entered, confirmation column never answered.
const entered = (fields) => ({ status: "unanswered", deliveryDeadline: "", mediaApproved: "", ...fields });
check("template defaults alone are not filled in", isFilledIn(entered({ width: "1920", height: "1080", placement: "DINTH", duration: "15" })), false);
check("a site name is filled in", isFilledIn(entered({ siteName: "Foyer" })), true);
check("a deadline is filled in", isFilledIn(entered({ deliveryDeadline: "2026-10-13" })), true);
check("entered but unanswered: unconfirmed", s([entered({ siteName: "Foyer" }), entered({})]).status, "unconfirmed");
check("template rows only: still not started", s([entered({ width: "1920", height: "1080" })]).status, "notStarted");
check("one answer and it is no longer unconfirmed", s([entered({ siteName: "Foyer" }), order("pending")]).status, "pending");

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
    market("Croatia", [{ status: "unanswered", deliveryDeadline: "2026-12-01", mediaApproved: "", siteName: "Foyer" }]),
    market("Broken", [], "No header row found"),
  ],
};
check("totals", fileTotals(file, TODAY), { markets: 7, orders: 6, confirmed: 1, pending: 3, unconfirmed: 1, due: 2, notStarted: 1 });

const sorted = sortMarkets(file.markets.map((m) => marketSummary(m, TODAY))).map((m) => m.name);
check("default order: urgent, pending, unconfirmed, confirmed, not started, unreadable",
  sorted, ["Spain", "France", "Italy", "Croatia", "Germany", "Japan", "Broken"]);
