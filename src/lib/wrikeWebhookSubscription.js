import { supabase } from "./supabaseClient";

const DEBOUNCE_MS = 2000;

// Subscribes to wrike_webhook_events inserts (written by worker/index.js's
// Wrike webhook receiver) and calls onTaskIds with a deduplicated batch of
// changed task IDs, debounced so a burst of edits to the same/nearby tasks
// coalesces into one call instead of firing per-event.
//
// Returns an unsubscribe function — call it from a useEffect cleanup.
export function subscribeToWrikeTaskEvents(onTaskIds) {
  let pendingIds = new Set();
  let debounceTimer = null;

  const flush = () => {
    const ids = [...pendingIds];
    pendingIds = new Set();
    debounceTimer = null;
    onTaskIds(ids);
  };

  const channel = supabase
    .channel(`wrike_webhook_events_live_${Math.random().toString(36).slice(2)}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "wrike_webhook_events" },
      (payload) => {
        const taskId = payload.new?.task_id;
        if (!taskId) return;
        pendingIds.add(taskId);
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(flush, DEBOUNCE_MS);
      }
    )
    .subscribe();

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    supabase.removeChannel(channel);
  };
}
