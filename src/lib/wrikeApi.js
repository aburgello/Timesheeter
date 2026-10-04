// All Wrike API calls go through the Worker proxy at /api/wrike/* instead of
// hitting wrike.com directly. The Worker attaches the member's OAuth access
// token (refreshing it when needed) — the browser never sees it.

export function startWrikeOAuth() {
  window.location.href = "/api/wrike/oauth/start";
}

export async function disconnectWrike() {
  await fetch("/api/wrike/oauth/disconnect", { method: "POST" });
}

// `connected` is tri-state: true, false, or null for "couldn't find out".
//
// null exists because reporting false on a failed check is a lie with teeth —
// it puts a Connect button in front of someone whose Wrike session is fine, and
// makes a database blip look like being signed out. The Worker answers 503 for
// that case specifically (see handleStatus); a request that never completed
// proves just as little, so it maps to null too.
export async function fetchWrikeOAuthStatus() {
  try {
    const res = await fetch("/api/wrike/oauth/status");
    if (res.status === 503) return { connected: null };
    if (!res.ok) return { connected: false };
    return await res.json();
  } catch (_) {
    return { connected: null };
  }
}

// Mirrors a locally-logged time entry onto the underlying Wrike task via
// POST /tasks/{id}/timelogs (proxied verbatim by handleProxy in
// worker/index.js). Wrike's API takes POST params as a query string, like
// every other endpoint this app calls, not a JSON body.
//
// No comment is sent — the job/territory/category/notes metadata already
// lives in Supabase (what Tracker and Legacy Timesheets read from), so it's
// not lost by leaving Wrike's own timelog entry bare; this only keeps
// Wrike's activity feed from being cluttered with our internal shorthand.
//
// Returns { ok, id } rather than throwing — every caller logs to Supabase
// first (that's this app's source of truth), so a Wrike-side failure
// (permissions, locked timesheet period, etc.) must not roll back or block
// a log that already succeeded locally.
//
// `id` is the id of the timelog Wrike just created, and the caller MUST store
// it on the row as wrike_timelog_id. This used to return a bare `true` and
// throw the response away, which quietly created a duplicate-hours loop: the
// pull paths dedupe on wrike_timelog_id alone (see fetchExistingTimelogIds),
// so a timelog this app created but never recorded the id of is one it has
// never seen. Log an hour here, run Legacy's "Pull Wrike Times" the same day,
// and that hour comes back as a second row — both of which then go out to the
// timesheet site. Recording the id closes the loop using the dedupe machinery
// that already exists, rather than adding another one.
//
// `ok` is separate from `id` on purpose: Wrike answering 200 without a
// parseable id is a success we can't dedupe, not a failure. Collapsing the two
// would either report a good write as failed, or store a bogus id.
//
// trackedDate is the caller's — the row it is logging alongside knows which
// day it belongs to, and passing it keeps the two from drifting. The default
// is LOCAL today, not `new Date().toISOString()`: that yields a UTC date, so
// anywhere west of Greenwich an evening log was stamped onto tomorrow.
const localIsoDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export async function logTimeToWrike(taskId, seconds, trackedDate = localIsoDate()) {
  if (!taskId) return { ok: false, id: null };
  const hours = seconds / 3600;
  const params = new URLSearchParams({ hours: String(hours), trackedDate });
  try {
    const res = await fetch(`/api/wrike/tasks/${taskId}/timelogs?${params}`, { method: "POST" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[wrikeApi] timelog POST failed (${res.status})`, body);
      return { ok: false, id: null };
    }
    // Wrike answers { kind: "timelogs", data: [{ id, … }] }. A body we can't
    // read is still a successful write — don't turn it into a failed one.
    const id = await res
      .json()
      .then((j) => j?.data?.[0]?.id || null)
      .catch(() => null);
    if (!id) console.warn("[wrikeApi] timelog created but no id returned — row cannot be deduped");
    return { ok: true, id };
  } catch (e) {
    console.warn("[wrikeApi] timelog POST error", e);
    return { ok: false, id: null };
  }
}

// A person's timelogs between two local dates ("YYYY-MM-DD", both inclusive).
//
// Every caller used to ask for /contacts/{id}/timelogs with no date range and
// throw away everything outside the day or week it wanted, so each pull
// downloaded the member's ENTIRE Wrike timelog history, and that grows by
// every hour anyone logs, for as long as the account exists.
//
// Two things keep this from changing what callers see:
//  · The range asked of Wrike is padded by a day on each side. Wrike doesn't
//    document whether `end` is inclusive, and a log on the boundary must not
//    go missing. Callers still filter to their exact dates, as they always have.
//  · If the filtered request fails at any point, this makes the old unfiltered
//    one instead, so the worst case is the behaviour from before this existed.
//
// `by` picks which date the range applies to: "trackedDate" (the day the time
// was for, what the pulls want) or "createdDate" (when it was entered, what the
// Profile's "recent activity" list sorts by).
//
// Asks for Wrike's largest page and stops at the first page that isn't full
// (see the loop for why the token alone can't be trusted to say "more"). Returns [] when nothing could be fetched, which is what every
// caller got before from a failed response (`json.data || []`).
const TIMELOG_PAGE = 1000; // Wrike's maximum

const addDays = (isoDate, n) => {
  const [y, m, d] = isoDate.split("-").map(Number);
  return localIsoDate(new Date(y, m - 1, d + n));
};

export async function fetchContactTimelogs(contactId, { from, to, plainText = false, by = "trackedDate" } = {}) {
  if (!contactId) return [];
  const base = `/api/wrike/contacts/${contactId}/timelogs`;
  const extra = plainText ? "plainText=true" : "";

  const unfiltered = async () => {
    try {
      const res = await fetch(extra ? `${base}?${extra}` : base);
      return (await res.json()).data || [];
    } catch {
      return [];
    }
  };

  if (!from || !to) return unfiltered();

  const range = encodeURIComponent(
    JSON.stringify({ start: addDays(from, -1), end: addDays(to, 1) })
  );
  const query = `${by}=${range}&pageSize=${TIMELOG_PAGE}${extra ? `&${extra}` : ""}`;
  let url = `${base}?${query}`;
  const logs = [];
  try {
    while (url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const page = json.data || [];
      logs.push(...page);
      // A short page is the last one, whatever else came with it. Wrike sends
      // a nextPageToken even then, and asking for that "next page" with the
      // token alone is a 400. That 400 is what made the first live version of
      // this fall back to the full history on every pull (seen 2026-10-04).
      // For one member over a few days a page is never full, so in practice
      // this is always a single request.
      if (page.length < TIMELOG_PAGE || !json.nextPageToken) break;
      // A genuinely full page: repeat the query with the token, in case Wrike
      // wants the filter restated. If it still refuses, the catch below falls
      // back to the full list rather than returning part of the range.
      url = `${base}?${query}&nextPageToken=${encodeURIComponent(json.nextPageToken)}`;
    }
  } catch (e) {
    // Any failure, first page or a later one, falls back to the whole
    // unfiltered list rather than returning part of the range: a partial
    // list would silently leave hours out of a pull.
    console.warn(`[wrikeApi] dated timelog fetch failed (${e.message}), fetching unfiltered`);
    return unfiltered();
  }
  // An empty answer is also treated as "the filter may not have worked". An
  // earlier version of this app noted a "broken trackedDate query param" and
  // gave up on it, without recording how it was broken, so an empty result is
  // re-checked the old way rather than trusted. That costs one full download
  // on a day with nothing logged, which is no worse than every pull used to be.
  return logs.length ? logs : unfiltered();
}
