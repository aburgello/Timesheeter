// Catching up with the shared task cache, claiming webhook events, and which
// webhook ids a view fetches. Runs against a small in-memory stand-in for the
// Supabase query builder.
import {
  TRACKING_START,
  hasChangeTracking,
  pullAll,
  pullSharedChanges,
  reconcileWithServer,
  claimWebhookEvents,
} from "../src/lib/sharedTaskSync.js";
import { idsWorthFetching } from "../src/lib/wrikeWebhookSubscription.js";

function fakeSupabase(tables, { missingColumn = null, claims = new Set(), rpcError = false } = {}) {
  const reads = [];
  const from = (table) => {
    const filters = [];
    let columns = "*";
    let limit = Infinity;
    const q = {
      select(c) { columns = c; return q; },
      gt(col, val) { filters.push((r) => String(r[col]) > String(val)); return q; },
      in(col, vals) { filters.push((r) => vals.includes(r[col])); return q; },
      order() { return q; },
      limit(n) { limit = n; return q; },
      then(resolve) {
        reads.push(table);
        if (missingColumn && columns.split(",").includes(missingColumn)) {
          return resolve({ data: null, error: { message: `column ${missingColumn} does not exist` } });
        }
        const rows = (tables[table] || [])
          .filter((r) => filters.every((f) => f(r)))
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, limit)
          .map((r) => Object.fromEntries(columns.split(",").map((c) => [c, r[c]])));
        return resolve({ data: rows, error: null });
      },
    };
    return q;
  };
  const rpc = async (name, { event_ids }) => {
    if (rpcError) return { data: null, error: { message: "function does not exist" } };
    const won = [...new Set(event_ids)].filter((id) => !claims.has(id));
    won.forEach((id) => claims.add(id));
    return { data: won, error: null };
  };
  return { from, rpc, reads };
}

const row = (id, cached_at) => ({ id, cached_at, task_data: { id, title: `T ${id}` } });

// Detecting the database objects.
{
  check("tracking: present", await hasChangeTracking(fakeSupabase({ wrike_tasks_cache: [] })), true);
  check(
    "tracking: missing column means fall back",
    await hasChangeTracking(fakeSupabase({ wrike_tasks_cache: [] }, { missingColumn: "cached_at" })),
    false
  );
}

// A full pull pages through everything and ends at the newest timestamp.
{
  const rows = Array.from({ length: 2500 }, (_, i) =>
    row(`A${String(i).padStart(5, "0")}`, i === 1700 ? "2026-10-04T10:00:00.5+00:00" : TRACKING_START)
  );
  const sb = fakeSupabase({ wrike_tasks_cache: rows });
  const { tasks, cursor } = await pullAll(sb);
  check("pullAll: every row, across pages", tasks.length, 2500);
  check("pullAll: no duplicates", new Set(tasks.map((t) => t.id)).size, 2500);
  check("pullAll: cursor is the newest cached_at", cursor, "2026-10-04T10:00:00.5+00:00");
}

// Catch-up returns rows written and ids removed since the cursor.
{
  const sb = fakeSupabase({
    wrike_tasks_cache: [
      row("OLD", "2026-10-04T09:00:00+00:00"),
      row("NEW", "2026-10-04T10:05:00+00:00"),
      row("EDGE", "2026-10-04T09:59:50+00:00"), // inside the overlap
    ],
    wrike_tasks_cache_removed: [
      { id: "GONE", removed_at: "2026-10-04T10:06:00+00:00" },
      { id: "LONGGONE", removed_at: "2026-10-01T00:00:00+00:00" },
    ],
  });
  const r = await pullSharedChanges(sb, "2026-10-04T10:00:00.000Z");
  check("catch-up: new rows and the overlap", r.tasks.map((t) => t.id).sort(), ["EDGE", "NEW"]);
  check("catch-up: recent removals only", r.removedIds, ["GONE"]);
  check("catch-up: cursor moves to the newest change", r.cursor, "2026-10-04T10:06:00+00:00");
}

// Nothing new: the cursor stays where it was.
{
  const sb = fakeSupabase({ wrike_tasks_cache: [row("OLD", "2026-10-04T09:00:00+00:00")], wrike_tasks_cache_removed: [] });
  const r = await pullSharedChanges(sb, "2026-10-04T10:00:00.000Z");
  check("catch-up: nothing new keeps the cursor", r.cursor, "2026-10-04T10:00:00.000Z");
}

// From TRACKING_START, rows that predate tracking aren't re-downloaded.
{
  const sb = fakeSupabase({
    wrike_tasks_cache: [row("PRE", "2000-01-01T00:00:00+00:00"), row("POST", "2026-10-04T10:00:00+00:00")],
    wrike_tasks_cache_removed: [],
  });
  const r = await pullSharedChanges(sb, TRACKING_START);
  check("catch-up: pre-tracking rows skipped", r.tasks.map((t) => t.id), ["POST"]);
}

// The id check works both ways: local rows the server no longer has, and
// server rows this browser never got (written before the change log existed,
// so no catch-up will ever bring them).
{
  const sb = fakeSupabase({
    wrike_tasks_cache: [row("A", TRACKING_START), row("B", TRACKING_START), row("NEVER_GOT", TRACKING_START)],
  });
  const r = await reconcileWithServer(sb, ["A", "B", "STALE"]);
  check("id check: stale local ids", r.goneIds, ["STALE"]);
  check("id check: rows this browser never got", r.missingTasks.map((t) => t.id), ["NEVER_GOT"]);
}

// Many missing rows are fetched in chunks, all of them.
{
  const rows = Array.from({ length: 1650 }, (_, i) => row(`M${String(i).padStart(5, "0")}`, TRACKING_START));
  const r = await reconcileWithServer(fakeSupabase({ wrike_tasks_cache: rows }), []);
  check("id check: every missing row fetched", r.missingTasks.length, 1650);
}

// Claiming: each event is won exactly once.
{
  const claims = new Set();
  const tabA = fakeSupabase({}, { claims });
  const tabB = fakeSupabase({}, { claims });
  const a = await claimWebhookEvents(tabA, [1, 2]);
  const b = await claimWebhookEvents(tabB, [2, 3]);
  check("claim: first tab wins its events", [...a], [1, 2]);
  check("claim: second tab only wins the new one", [...b], [3]);
  check("claim: unavailable means null (old behaviour)", await claimWebhookEvents(fakeSupabase({}, { rpcError: true }), [4]), null);
  check("claim: nothing to claim", [...(await claimWebhookEvents(tabA, []))], []);
}

// Which ids a view fetches.
{
  const events = [
    { id: 1, task_id: "SHOWN", event_type: "CommentAdded" },
    { id: 2, task_id: "OTHER", event_type: "TaskStatusChanged" },
    { id: 3, task_id: "NEWLY_MINE", event_type: "TaskResponsiblesAdded" },
    { id: 4, task_id: "CREATED", event_type: "TaskCreated" },
    { id: 5, task_id: "UNTYPED", event_type: null },
  ];
  const ids = ["SHOWN", "OTHER", "NEWLY_MINE", "CREATED", "UNTYPED"];
  check(
    "fetch filter: shown, entering and untyped only",
    idsWorthFetching(ids, events, new Set(["SHOWN"])),
    ["SHOWN", "NEWLY_MINE", "CREATED", "UNTYPED"]
  );
  check(
    "fetch filter: the board also takes status changes",
    idsWorthFetching(ids, events, new Set(["SHOWN"]), ["TaskStatusChanged"]),
    ["SHOWN", "OTHER", "UNTYPED"]
  );
  check("fetch filter: no event details fetches everything", idsWorthFetching(ids, [], new Set()), ids);
}
