// Client rate cards: what an hour costs depends on the client it's for and the
// rate-card position the work bills as. See the client_rates and rate_roles
// tables.

export const CURRENCIES = [
  { code: "USD", symbol: "$" },
  { code: "GBP", symbol: "£" },
  { code: "EUR", symbol: "€" },
  { code: "AUD", symbol: "A$" },
];

export const currencySymbol = (code) => CURRENCIES.find((c) => c.code === code)?.symbol ?? "$";

export const formatMoney = (n, currency = "USD") =>
  n == null || isNaN(n) ? "—" : `${currencySymbol(currency)}${Number(n).toFixed(2)}`;

// Jobs and logged time carry the client's name, not its id.
export const clientKey = (name) => String(name ?? "").trim().toLowerCase();

// client_rates rows → client id → (rate-card position id → hourly rate)
export function indexRates(rows) {
  const byClient = new Map();
  for (const r of rows || []) {
    if (!byClient.has(r.client_id)) byClient.set(r.client_id, new Map());
    byClient.get(r.client_id).set(r.rate_role_id, Number(r.hourly_rate));
  }
  return byClient;
}

// The hourly rate for one logged entry, or null when it can't be priced: the
// client has no card, the logger's position bills as nothing, or the card has
// no line for it. Null is deliberate. A made-up default would look like a real
// price in the report.
//
// The rate follows the work, not the worker: a category that names a rate-card
// position (a designer proofreading bills as Proof Reader) wins over the
// logger's own. Unbilled categories are zero whatever the card says.
export function hourlyRate({ unbilled, categoryRoleId, positionRoleId, card }) {
  if (unbilled) return 0;
  const roleId = categoryRoleId || positionRoleId;
  if (!roleId || !card) return null;
  return card.get(roleId) ?? null;
}

// A quick quote: hours typed against the card's lines. Lines with no rate or
// no hours add nothing.
export function quoteTotals(lines) {
  let hours = 0;
  let total = 0;
  for (const { rate, hours: h } of lines) {
    const hrs = Number(h);
    if (!(hrs > 0)) continue;
    hours += hrs;
    const r = Number(rate);
    if (rate !== "" && rate != null && r >= 0) total += r * hrs;
  }
  return { hours, total };
}
