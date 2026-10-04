import { statusLines, findOurWebhook, isWorkingHours } from "../src/lib/systemStatus.js";

const tuesdayNoon = new Date(2026, 9, 6, 12, 0);
const sundayNoon = new Date(2026, 9, 4, 12, 0);
const ago = (now, mins) => new Date(now.getTime() - mins * 60000).toISOString();
const level = (lines, id) => lines.find((l) => l.id === id).level;

check("status: Tuesday noon is working hours", isWorkingHours(tuesdayNoon), true);
check("status: Sunday isn't", isWorkingHours(sundayNoon), false);

{
  const lines = statusLines({
    lastSyncedAt: ago(tuesdayNoon, 10), dictionariesAt: ago(tuesdayNoon, 60),
    lastEventAt: ago(tuesdayNoon, 5), webhook: { status: "Active" }, cacheRows: 31000, removedRecently: 600,
  }, tuesdayNoon);
  check("status: all fresh is all ok", lines.filter((l) => l.level !== "info").map((l) => l.level), ["ok", "ok", "ok", "ok"]);
  check("status: sync shown as an age", lines[0].value, "10 min ago");
}
{
  const input = { lastSyncedAt: ago(tuesdayNoon, 300), dictionariesAt: ago(tuesdayNoon, 60), lastEventAt: ago(tuesdayNoon, 300), webhook: { status: "Active" } };
  check("status: a stale sync warns in working hours", level(statusLines(input, tuesdayNoon), "sync"), "warn");
  check("status: no events for hours warns in working hours", level(statusLines(input, tuesdayNoon), "event"), "warn");
  const weekend = { ...input, lastSyncedAt: ago(sundayNoon, 300), lastEventAt: ago(sundayNoon, 300) };
  check("status: ...but not at the weekend", level(statusLines(weekend, sundayNoon), "event"), "info");
}
{
  const base = { lastSyncedAt: null, dictionariesAt: ago(tuesdayNoon, 4 * 24 * 60), lastEventAt: null };
  check("status: lists not refreshed for days warn", level(statusLines(base, tuesdayNoon), "dictionaries"), "warn");
  check("status: never synced reads 'never'", statusLines(base, tuesdayNoon)[0].value, "never");
  check("status: suspended webhook is bad", statusLines({ ...base, webhook: { status: "Suspended" } }, tuesdayNoon).find((l) => l.id === "webhook"), { id: "webhook", label: "Live updates in Wrike", value: "suspended", level: "bad" });
  check("status: missing webhook is bad", level(statusLines({ ...base, webhook: null }, tuesdayNoon), "webhook"), "bad");
  check("status: unknown webhook isn't alarming", level(statusLines({ ...base, webhook: undefined }, tuesdayNoon), "webhook"), "info");
  check("status: cache lines only when counted", statusLines(base, tuesdayNoon).some((l) => l.id === "cache"), false);
}

check("status: finds the webhook pointing at this site",
  findOurWebhook([{ id: "a", hookUrl: "https://other.test/api/wrike/webhook" }, { id: "b", hookUrl: "https://site.test/api/wrike/webhook" }], "https://site.test")?.id, "b");
check("status: none pointing here is null", findOurWebhook([], "https://site.test"), null);
