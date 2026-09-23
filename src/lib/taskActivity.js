// Reads from wrike_task_activity: status changes and assignments the webhook
// recorded, kept six weeks (migration 20260923181757). Only read when someone
// opens "What did I work on?", and only for one day at a time.
import { supabase, whenIdentityReady } from "./supabaseClient";
import { dayRangeUtc } from "../utils/commentActivity";

const COLUMNS = "task_id,event_type,author_id,status,custom_status_id,user_ids,occurred_at";
const CHUNK = 100; // task ids per query, to keep the URL a sensible length

// When recording began. A day before this has no history to estimate from.
// Asked once per session: it only ever moves when the cleanup job trims the
// oldest rows, and that only matters six weeks back.
let historyStartPromise = null;
export function historyStart() {
  if (!historyStartPromise) {
    historyStartPromise = (async () => {
      await whenIdentityReady();
      const { data, error } = await supabase
        .from("wrike_task_activity")
        .select("occurred_at")
        .order("occurred_at", { ascending: true })
        .limit(1);
      if (error) throw error;
      return data?.[0]?.occurred_at ? new Date(data[0].occurred_at) : null;
    })().catch((err) => {
      historyStartPromise = null; // let the next open try again
      throw err;
    });
  }
  return historyStartPromise;
}

/**
 * The day's activity that matters to `me`: every assignment of me, and every
 * status change or un-assignment on `taskIds` plus the tasks I was assigned.
 * Two or three small indexed queries.
 */
export async function fetchActivityForDay(date, me, taskIds) {
  await whenIdentityReady();
  const { start, end } = dayRangeUtc(date);
  const inDay = (q) => q.gte("occurred_at", start).lt("occurred_at", end);

  const assigned = await inDay(
    supabase
      .from("wrike_task_activity")
      .select(COLUMNS)
      .eq("event_type", "TaskResponsiblesAdded")
      .contains("user_ids", [me])
  );
  if (assigned.error) throw assigned.error;

  const ids = [...new Set([...taskIds, ...assigned.data.map((a) => a.task_id)])];
  const rows = [...assigned.data];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const res = await inDay(
      supabase
        .from("wrike_task_activity")
        .select(COLUMNS)
        .in("event_type", ["TaskStatusChanged", "TaskResponsiblesRemoved"])
        .in("task_id", ids.slice(i, i + CHUNK))
    );
    if (res.error) throw res.error;
    rows.push(...res.data);
  }
  return rows;
}
