// The shared dictionary refresh and the dated timelog fetch. Both replace code
// that could hand back a partial answer as if it were whole, so these pin the
// fallbacks: a failed download keeps what was there before, and a refused or
// empty date filter falls back to the old unfiltered request.
import { fetchWrikeMeta } from "../src/lib/wrikeMeta.js";
import { fetchContactTimelogs } from "../src/lib/wrikeApi.js";

const respond = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const quiet = async (fn) => {
  const { warn, log } = console;
  console.warn = () => {};
  console.log = () => {};
  try { return await fn(); } finally { console.warn = warn; console.log = log; }
};

const withFetch = async (handler, fn) => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return handler(String(url)); };
  try { return { result: await quiet(fn), calls }; } finally { globalThis.fetch = original; }
};

const previous = {
  folderDictionary: { F0: { id: "F0", title: "Old", childIds: [] } },
  contactDictionary: { U0: "Old Person" },
  statusDictionary: { S0: "Old Status" },
};

// Everything answers: fresh dictionaries, recycle bin dropped, complete.
{
  const { result } = await withFetch((url) => {
    if (url.startsWith("/api/wrike/folders")) {
      return respond(200, { data: [
        { id: "F1", title: "Film", childIds: ["F2"], scope: "WsFolder" },
        { id: "F9", title: "Deleted", childIds: [], scope: "RbFolder" },
      ] });
    }
    if (url.startsWith("/api/wrike/contacts")) return respond(200, { data: [{ id: "U1", firstName: "Ada", lastName: "Lovelace" }] });
    if (url.startsWith("/api/wrike/workflows")) return respond(200, { data: [{ customStatuses: [{ id: "S1", name: "In Progress" }] }] });
    return respond(404, {});
  }, () => fetchWrikeMeta(previous));
  check("meta: complete when all three answer", result.complete, true);
  check("meta: folders fresh, recycle bin dropped", Object.keys(result.folderDictionary), ["F1"]);
  check("meta: contacts fresh", result.contactDictionary, { U1: "Ada Lovelace" });
  check("meta: statuses fresh", result.statusDictionary, { S1: "In Progress" });
}

// Contacts refused (a 400 here, so the test doesn't sit through the retry
// back-off a 429 gets): the old contact list survives, the
// others still refresh, and the refresh is reported incomplete. This is the
// case that used to write {} over everyone's contact names.
{
  const { result } = await withFetch((url) => {
    if (url.startsWith("/api/wrike/folders")) return respond(200, { data: [{ id: "F1", title: "Film", childIds: [] }] });
    if (url.startsWith("/api/wrike/contacts")) return respond(400, { error: "nope" });
    if (url.startsWith("/api/wrike/workflows")) return respond(200, { data: [{ customStatuses: [{ id: "S1", name: "Done" }] }] });
    return respond(404, {});
  }, () => fetchWrikeMeta(previous));
  check("meta: incomplete when one list fails", result.complete, false);
  check("meta: failed list keeps the previous copy", result.contactDictionary, previous.contactDictionary);
  check("meta: the others still refresh", Object.keys(result.folderDictionary), ["F1"]);
}

// A folder page failing part-way: the whole previous tree is kept, never the
// pages that arrived before the failure.
{
  const { result } = await withFetch((url) => {
    if (url.includes("nextPageToken")) return respond(400, { error: "bad page" });
    if (url.startsWith("/api/wrike/folders")) return respond(200, { data: [{ id: "F1", title: "Half", childIds: [] }], nextPageToken: "T2" });
    if (url.startsWith("/api/wrike/contacts")) return respond(200, { data: [{ id: "U1", firstName: "A" }] });
    if (url.startsWith("/api/wrike/workflows")) return respond(200, { data: [{ customStatuses: [] }] });
    return respond(404, {});
  }, () => fetchWrikeMeta(previous));
  check("meta: half a folder tree is not kept", result.folderDictionary, previous.folderDictionary);
  check("meta: and the refresh is incomplete", result.complete, false);
}

// An empty answer is not a successful refresh.
{
  const { result } = await withFetch((url) => {
    if (url.startsWith("/api/wrike/folders")) return respond(200, { data: [{ id: "F1", title: "Film", childIds: [] }] });
    if (url.startsWith("/api/wrike/contacts")) return respond(200, { data: [] });
    return respond(200, { data: [{ customStatuses: [] }] });
  }, () => fetchWrikeMeta(previous));
  check("meta: empty contacts keep the previous copy", result.contactDictionary, previous.contactDictionary);
}

// ── fetchContactTimelogs ──────────────────────────────────────────────────────
const log = (id, day) => ({ id, taskId: "T", trackedDate: `${day}T00:00:00`, hours: 1 });

// The range asked of Wrike is padded a day each side.
{
  const { result, calls } = await withFetch(
    () => respond(200, { data: [log("L1", "2026-10-02")] }),
    () => fetchContactTimelogs("U1", { from: "2026-10-01", to: "2026-10-03" })
  );
  const sent = JSON.parse(new URL(calls[0], "http://x").searchParams.get("trackedDate"));
  check("timelogs: padded range", sent, { start: "2026-09-30", end: "2026-10-04" });
  check("timelogs: one request", calls.length, 1);
  check("timelogs: returns the logs", result.map((l) => l.id), ["L1"]);
}

// Padding crosses month and year boundaries correctly.
{
  const { calls } = await withFetch(
    () => respond(200, { data: [log("L1", "2027-01-01")] }),
    () => fetchContactTimelogs("U1", { from: "2027-01-01", to: "2027-01-01" })
  );
  const sent = JSON.parse(new URL(calls[0], "http://x").searchParams.get("trackedDate"));
  check("timelogs: padding crosses the year", sent, { start: "2026-12-31", end: "2027-01-02" });
}

const fullPage = (prefix) =>
  Array.from({ length: 1000 }, (_, i) => log(`${prefix}${i}`, "2026-10-01"));

// What happened live on 2026-10-04: Wrike sends a nextPageToken with a page
// that isn't full, and the token-only follow-up is a 400. A short page is the
// last one, so no second request is made at all.
{
  const { result, calls } = await withFetch(
    (url) => url.includes("nextPageToken")
      ? respond(400, { error: "invalid_request" })
      : respond(200, { data: [log("L1", "2026-10-02")], nextPageToken: "AFQ25L" }),
    () => fetchContactTimelogs("U1", { from: "2026-10-02", to: "2026-10-04" })
  );
  check("timelogs: short page with a token is the last page", calls.length, 1);
  check("timelogs: and its logs are returned", result.map((l) => l.id), ["L1"]);
  check("timelogs: asks for the largest page", calls[0].includes("&pageSize=1000"), true);
}

// A genuinely full page is followed, with the filter restated alongside the token.
{
  const { result, calls } = await withFetch(
    (url) => url.includes("nextPageToken")
      ? respond(200, { data: [log("L2", "2026-10-02")] })
      : respond(200, { data: fullPage("A"), nextPageToken: "P2" }),
    () => fetchContactTimelogs("U1", { from: "2026-10-01", to: "2026-10-02" })
  );
  check("timelogs: follows a full page", result.length, 1001);
  check("timelogs: next page restates the filter", calls[1].includes("trackedDate=") && calls[1].includes("nextPageToken=P2"), true);
}

// Wrike refuses the filter: the old unfiltered request is made instead.
{
  const { result, calls } = await withFetch(
    (url) => url.includes("trackedDate=")
      ? respond(400, { error: "invalid_parameter" })
      : respond(200, { data: [log("L1", "2026-10-01"), log("L0", "2025-01-01")] }),
    () => fetchContactTimelogs("U1", { from: "2026-10-01", to: "2026-10-01" })
  );
  check("timelogs: refused filter falls back", calls[1], "/api/wrike/contacts/U1/timelogs");
  check("timelogs: fallback returns the full list", result.map((l) => l.id), ["L1", "L0"]);
}

// A later page failing also falls back to the full list, not a partial range.
{
  const { result } = await withFetch(
    (url) => {
      if (url.includes("nextPageToken")) return respond(500, {});
      if (url.includes("trackedDate=")) return respond(200, { data: fullPage("A"), nextPageToken: "P2" });
      return respond(200, { data: [log("L1", "2026-10-01"), log("L2", "2026-10-02")] });
    },
    () => fetchContactTimelogs("U1", { from: "2026-10-01", to: "2026-10-02" })
  );
  check("timelogs: failed later page falls back", result.map((l) => l.id), ["L1", "L2"]);
}

// An empty filtered answer is double-checked the old way.
{
  const { result, calls } = await withFetch(
    (url) => url.includes("trackedDate=")
      ? respond(200, { data: [] })
      : respond(200, { data: [log("L1", "2026-10-01")] }),
    () => fetchContactTimelogs("U1", { from: "2026-10-01", to: "2026-10-01" })
  );
  check("timelogs: empty result re-checked unfiltered", calls.length, 2);
  check("timelogs: and returns what that found", result.map((l) => l.id), ["L1"]);
}

// createdDate ranges and plainText are passed through.
{
  const { calls } = await withFetch(
    () => respond(200, { data: [log("L1", "2026-10-01")] }),
    () => fetchContactTimelogs("U1", { from: "2026-08-01", to: "2026-10-01", plainText: true, by: "createdDate" })
  );
  check("timelogs: createdDate range", calls[0].includes("?createdDate="), true);
  check("timelogs: plainText kept", calls[0].includes("&plainText=true"), true);
}

// No range: exactly the old request.
{
  const { calls } = await withFetch(
    () => respond(200, { data: [] }),
    () => fetchContactTimelogs("U1", { plainText: true })
  );
  check("timelogs: no range is the old request", calls, ["/api/wrike/contacts/U1/timelogs?plainText=true"]);
}
