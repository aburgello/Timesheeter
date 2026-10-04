import { supabase } from "./supabaseClient";

const DEBOUNCE_MS = 2000;

// Calls onTaskIds(ids, events) with the ids of tasks Wrike reported as changed
// (rows the Worker's webhook receiver inserts into wrike_webhook_events),
// de-duplicated and debounced so a burst of edits is one call. `events` are
// the rows themselves ({ id, task_id, event_type }), for claiming and for
// idsWorthFetching. Returns the unsubscribe function for a useEffect cleanup.
export function subscribeToWrikeTaskEvents(onTaskIds) {
  let pendingIds = new Set();
  let pendingEvents = [];
  let debounceTimer = null;

  const flush = () => {
    const ids = [...pendingIds];
    const events = pendingEvents;
    pendingIds = new Set();
    pendingEvents = [];
    debounceTimer = null;
    onTaskIds(ids, events);
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
        if (payload.new.id != null) {
          pendingEvents.push({ id: payload.new.id, task_id: taskId, event_type: payload.new.event_type || null });
        }
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

// The ids a view needs to fetch: tasks it already shows, plus tasks whose
// events could bring them into it (`enteringTypes`, e.g. a new assignment).
// Anything else can't change what the view shows, so isn't worth a Wrike call.
// An event with no type counts as entering, and without event details every
// id is fetched, as before.
export function idsWorthFetching(ids, events, shownIds, enteringTypes = ["TaskCreated", "TaskResponsiblesAdded"]) {
  if (!events?.length) return ids;
  const shown = shownIds instanceof Set ? shownIds : new Set(shownIds);
  const entering = new Set(
    events.filter((e) => !e.event_type || enteringTypes.includes(e.event_type)).map((e) => e.task_id)
  );
  return ids.filter((id) => shown.has(id) || entering.has(id));
}
