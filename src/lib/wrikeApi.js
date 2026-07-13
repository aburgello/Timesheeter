// All Wrike API calls go through the Worker proxy at /api/wrike/* instead of
// hitting wrike.com directly. The Worker attaches the member's OAuth access
// token (refreshing it when needed) — the browser never sees it.

export function startWrikeOAuth() {
  window.location.href = "/api/wrike/oauth/start";
}

export async function disconnectWrike() {
  await fetch("/api/wrike/oauth/disconnect", { method: "POST" });
}

export async function fetchWrikeOAuthStatus() {
  try {
    const res = await fetch("/api/wrike/oauth/status");
    if (!res.ok) return { connected: false };
    return await res.json();
  } catch (_) {
    return { connected: false };
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
// Returns true/false rather than throwing — every caller logs to Supabase
// first (that's this app's source of truth), so a Wrike-side failure
// (permissions, locked timesheet period, etc.) must not roll back or block
// a log that already succeeded locally.
export async function logTimeToWrike(taskId, seconds) {
  if (!taskId) return false;
  const hours = seconds / 3600;
  const trackedDate = new Date().toISOString().split("T")[0];
  const params = new URLSearchParams({ hours: String(hours), trackedDate });
  try {
    const res = await fetch(`/api/wrike/tasks/${taskId}/timelogs?${params}`, { method: "POST" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[wrikeApi] timelog POST failed (${res.status})`, body);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[wrikeApi] timelog POST error", e);
    return false;
  }
}
