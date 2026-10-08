import { formatMoney, clientKey, indexRates, hourlyRate, quoteTotals } from "../src/lib/rateCards.js";

check("dollars by default", formatMoney(164), "$164.00");
check("the client's currency", [formatMoney(124, "GBP"), formatMoney(239, "AUD"), formatMoney(128.04, "EUR")], ["£124.00", "A$239.00", "€128.04"]);
check("no price", [formatMoney(null), formatMoney(NaN, "GBP")], ["—", "—"]);
check("client names match loosely", clientKey("  Paramount Pictures International "), "paramount pictures international");

const cards = indexRates([
  { client_id: 1, rate_role_id: 10, hourly_rate: "191.00" },
  { client_id: 1, rate_role_id: 20, hourly_rate: "135.00" },
  { client_id: 1, rate_role_id: 30, hourly_rate: "34.00" },
  { client_id: 2, rate_role_id: 20, hourly_rate: "124.00" },
]);
const paramount = cards.get(1);
check("a client with no rates has no card", cards.get(3), undefined);
check("the logger's position", hourlyRate({ positionRoleId: 20, card: paramount }), 135);
check("the same position on another client's card", hourlyRate({ positionRoleId: 20, card: cards.get(2) }), 124);
check("the category's position wins", hourlyRate({ categoryRoleId: 30, positionRoleId: 20, card: paramount }), 34);
check("unbilled is zero whatever the card says", hourlyRate({ unbilled: true, positionRoleId: 20, card: paramount }), 0);
check("unbilled is zero with no card", hourlyRate({ unbilled: true }), 0);
check("no card: unpriced", hourlyRate({ positionRoleId: 20 }), null);
check("position bills as nothing: unpriced", hourlyRate({ card: paramount }), null);
check("not on this client's card: unpriced", hourlyRate({ positionRoleId: 10, card: cards.get(2) }), null);
check("a zero rate on the card is a price", hourlyRate({ positionRoleId: 5, card: new Map([[5, 0]]) }), 0);

check("quote", quoteTotals([
  { rate: "191", hours: "1" },
  { rate: "164", hours: "3" },
  { rate: "135", hours: "" },
  { rate: "", hours: "2" },
]), { hours: 6, total: 683 });
check("empty quote", quoteTotals([{ rate: "191", hours: "" }]), { hours: 0, total: 0 });
