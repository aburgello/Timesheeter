// Catching up with the shared task cache (wrike_tasks_cache), and sharing out
// webhook work between open tabs. Both need the database objects from
// migrations 20261004140000 and 20261004140100; callers check
// hasChangeTracking() / claimWebhookEvents() and keep the old behaviour when
// they're missing.
//
// Cursors are the database's own timestamps (cached_at, removed_at), never the
// browser clock.

// Rows that existed before change tracking carry this timestamp, so a cursor
// here means "everything written since tracking began".
export const TRACKING_START = "2000-01-01T00:00:00Z";

// How often a browser runs reconcileWithServer. Weekly is well inside the
// 30 days removal records are kept, and catches anything else that slipped.
export const RECONCILE_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

// A write that was in flight when we last looked can commit with a timestamp
// just behind the cursor. Writes are short, so a few seconds of overlap covers
// it, and the overlap is all a catch-up re-downloads.
const OVERLAP_MS = 15 * 1000;
const PAGE = 1000;

const later = (a, b) => (Date.parse(b) > Date.parse(a) ? b : a);

export async function hasChangeTracking(supabase) {
  const { error } = await supabase.from("wrike_tasks_cache").select("cached_at").limit(1);
  return !error;
}

// Every row of `table` matching `filter`, paged by id (keyset, not offsets:
// rows written mid-read would shift offset pages and skip a row).
async function selectAll(supabase, table, columns, filter = (q) => q) {
  const out = [];
  let lastId = null;
  for (;;) {
    let q = filter(supabase.from(table).select(columns)).order("id").limit(PAGE);
    if (lastId !== null) q = q.gt("id", lastId);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE) return out;
    lastId = data[data.length - 1].id;
  }
}

// The whole cache, for a browser with nothing local.
export async function pullAll(supabase) {
  const rows = await selectAll(supabase, "wrike_tasks_cache", "id,task_data,cached_at");
  return {
    tasks: rows.map((r) => r.task_data),
    cursor: rows.reduce((c, r) => later(c, r.cached_at), TRACKING_START),
  };
}

// Rows written and ids removed since `cursor`. A task removed and later cached
// again loses its removal record, so the two lists never contradict.
export async function pullSharedChanges(supabase, cursor) {
  // Never reach back past TRACKING_START, or the overlap would sweep in every
  // row that predates tracking.
  const since = new Date(Math.max(Date.parse(cursor) - OVERLAP_MS, Date.parse(TRACKING_START))).toISOString();
  const [rows, removed] = await Promise.all([
    selectAll(supabase, "wrike_tasks_cache", "id,task_data,cached_at", (q) => q.gt("cached_at", since)),
    selectAll(supabase, "wrike_tasks_cache_removed", "id,removed_at", (q) => q.gt("removed_at", since)),
  ]);
  let next = cursor;
  rows.forEach((r) => { next = later(next, r.cached_at); });
  removed.forEach((r) => { next = later(next, r.removed_at); });
  return { tasks: rows.map((r) => r.task_data), removedIds: removed.map((r) => r.id), cursor: next };
}

// Compares this browser's ids with the server's, both ways: ids the server no
// longer has (to drop) and rows the server has that this browser never got (to
// add). The catch-up can't see either for rows written before the change log
// existed. Ids cost ~400 KB for the whole cache; only missing rows are fetched.
export async function reconcileWithServer(supabase, localIds) {
  const serverIds = (await selectAll(supabase, "wrike_tasks_cache", "id")).map((r) => r.id);
  const server = new Set(serverIds);
  const local = new Set(localIds);
  const goneIds = localIds.filter((id) => !server.has(id));
  const missingIds = serverIds.filter((id) => !local.has(id));
  const missingTasks = [];
  for (let i = 0; i < missingIds.length; i += 200) {
    const chunk = missingIds.slice(i, i + 200);
    const rows = await selectAll(supabase, "wrike_tasks_cache", "id,task_data", (q) => q.in("id", chunk));
    missingTasks.push(...rows.map((r) => r.task_data));
  }
  return { goneIds, missingTasks };
}

// Claims webhook events for this tab. Returns the Set of event ids it won, or
// null when claiming isn't available (then every tab handles everything, as
// before). Exactly one caller wins each event.
export async function claimWebhookEvents(supabase, eventIds) {
  if (!eventIds.length) return new Set();
  const { data, error } = await supabase.rpc("claim_wrike_webhook_events", { event_ids: eventIds });
  if (error) return null;
  return new Set((data || []).map(Number));
}
