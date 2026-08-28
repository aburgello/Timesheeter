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
