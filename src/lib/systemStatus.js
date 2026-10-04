// Turns what the database and Wrike report into the Administration status
// lines. Each line is { id, label, value, level }, level being "ok", "warn",
// "bad" or "info".
//
// Syncs and webhook events only happen while people are working, so a quiet
// evening or weekend is not a warning. Outside working hours a stale value is
// shown as "info".

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function isWorkingHours(now) {
  const day = now.getDay();
  const hour = now.getHours();
  return day >= 1 && day <= 5 && hour >= 10 && hour < 19;
}

export function timeAgo(iso, now) {
  if (!iso) return "never";
  const ms = now.getTime() - Date.parse(iso);
  if (ms < MIN) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MIN)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
  return `${Math.floor(ms / DAY)} d ago`;
}

const ageOf = (iso, now) => (iso ? now.getTime() - Date.parse(iso) : Infinity);

// A value that should keep moving during the working day.
function freshness(iso, now, staleAfter) {
  if (ageOf(iso, now) <= staleAfter) return "ok";
  return isWorkingHours(now) ? "warn" : "info";
}

// webhook: { status: "Active" | "Suspended" | ... } for ours, null when Wrike
// has none pointing here, undefined when Wrike couldn't be asked.
export function statusLines({ lastSyncedAt, dictionariesAt, peopleSyncedAt, lastEventAt, webhook, cacheRows, removedRecently }, now = new Date()) {
  const lines = [
    {
      id: "sync",
      label: "Last sync from Wrike",
      value: timeAgo(lastSyncedAt, now),
      level: freshness(lastSyncedAt, now, HOUR),
    },
    {
      id: "dictionaries",
      label: "Folder and people lists refreshed",
      value: timeAgo(dictionariesAt, now),
      // Refreshed once a day by whoever syncs first.
      level: ageOf(dictionariesAt, now) <= 2 * DAY ? "ok" : "warn",
    },
    // undefined before that column exists.
    ...(peopleSyncedAt === undefined ? [] : [{
      id: "people",
      label: "People synced from Wrike",
      value: timeAgo(peopleSyncedAt, now),
      // Daily, when an administrator opens TimeHub.
      level: ageOf(peopleSyncedAt, now) <= 3 * DAY ? "ok" : "warn",
    }]),
    {
      id: "event",
      label: "Last live update from Wrike",
      value: timeAgo(lastEventAt, now),
      level: freshness(lastEventAt, now, 2 * HOUR),
    },
  ];

  let hook;
  if (webhook === undefined) hook = { value: "couldn't check", level: "info" };
  else if (webhook === null) hook = { value: "not registered", level: "bad" };
  else if (webhook.status === "Active") hook = { value: "active", level: "ok" };
  else hook = { value: String(webhook.status || "unknown").toLowerCase(), level: "bad" };
  lines.push({ id: "webhook", label: "Live updates in Wrike", ...hook });

  if (cacheRows != null) {
    lines.push({ id: "cache", label: "Tasks in the shared cache", value: cacheRows.toLocaleString("en-GB"), level: "info" });
  }
  if (removedRecently != null) {
    lines.push({ id: "removed", label: "Tasks removed, last 30 days", value: removedRecently.toLocaleString("en-GB"), level: "info" });
  }
  return lines;
}

// Ours among Wrike's webhooks: the one pointing at this site.
export function findOurWebhook(webhooks, origin) {
  const hookUrl = `${origin}/api/wrike/webhook`;
  return (webhooks || []).find((w) => w.hookUrl === hookUrl) || null;
}
