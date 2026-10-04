// All Wrike calls go through the Worker proxy at /api/wrike/*, which attaches
// the member's OAuth token. The browser never sees the token.

export function startWrikeOAuth() {
  window.location.href = "/api/wrike/oauth/start";
}

export async function disconnectWrike() {
  await fetch("/api/wrike/oauth/disconnect", { method: "POST" });
}

// `connected` is true, false, or null for "couldn't find out". A failed check
// must not read as signed out (that would show a Connect button to someone whose
// session is fine), so the Worker's 503 and network errors both map to null.
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

// Copies a time entry logged here onto the Wrike task (POST /tasks/{id}/timelogs;
// Wrike takes POST params as a query string). No comment is sent: the job and
// category details live in Supabase.
//
// Returns { ok, id } and never throws, because callers have already saved the
// row to Supabase and a Wrike failure mustn't undo that.
//
// The caller MUST store `id` as the row's wrike_timelog_id. The pulls dedupe on
// that id alone, so a timelog whose id we didn't record is pulled back in as a
// second row. `ok` without an `id` means Wrike saved it but we can't dedupe it.
//
// trackedDate defaults to LOCAL today; toISOString() would give the UTC date and
// put evening logs west of Greenwich on tomorrow.
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
    // A body we can't read is still a successful write.
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

// A person's timelogs between two local dates ("YYYY-MM-DD", inclusive), so a
// pull doesn't download their whole history.
//
// - The range sent to Wrike is padded a day each side (Wrike doesn't say whether
//   `end` is inclusive). Callers still filter to their exact dates.
// - `by` is "trackedDate" (the day the time was for) or "createdDate" (when it
//   was entered, which Profile's recent list sorts by).
// - Any failure, or an empty answer, falls back to the old unfiltered request,
//   so the worst case is the old behaviour. Returns [] if nothing could be
//   fetched.
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
      // A short page is the last one. Wrike sends a nextPageToken even then, and the
      // token-only follow-up is a 400.
      if (page.length < TIMELOG_PAGE || !json.nextPageToken) break;
      // A full page: restate the filter alongside the token.
      url = `${base}?${query}&nextPageToken=${encodeURIComponent(json.nextPageToken)}`;
    }
  } catch (e) {
    // Fall back to the whole list rather than return part of the range.
    console.warn(`[wrikeApi] dated timelog fetch failed (${e.message}), fetching unfiltered`);
    return unfiltered();
  }
  // An earlier version noted the trackedDate filter as "broken" without saying
  // how, so an empty answer is re-checked unfiltered rather than trusted.
  return logs.length ? logs : unfiltered();
}
