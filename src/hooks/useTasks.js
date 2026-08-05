import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { supabase, whenIdentityReady, selectAll } from "../lib/supabaseClient";
import { parseTimeToSeconds, secondsToHM } from "../utils/timeHelpers";

// --- Translators ---

// Stores time as "H:MM" — human-readable in Supabase. null (not "none") is the
// empty value here so the column reads as empty rather than as the string the
// grid's dropdown uses.
const secsToHM = (s) => secondsToHM(s, null);

const parseDbTime = parseTimeToSeconds;

// Given a partial update that touches time, fill in the representation the
// caller didn't set, so in-memory seconds and the "H:MM" string always agree.
const syncTimeFields = (changes) => {
  const out = { ...changes };
  if ("rawSeconds" in out) out.timeSpent = secondsToHM(out.rawSeconds ?? 0);
  else if ("timeSpent" in out) out.rawSeconds = parseTimeToSeconds(out.timeSpent);
  if ("additionalSeconds" in out) out.additionalTime = secondsToHM(out.additionalSeconds ?? 0);
  else if ("additionalTime" in out) out.additionalSeconds = parseTimeToSeconds(out.additionalTime);
  return out;
};

const toDb = (task) => ({
  id: task.id,
  source: task.source || "tracker",
  wrike_user_id: task.wrikeUserId ?? null,
  // Shared
  job_number: task.jobNumber ?? null,
  category: task.category ?? null,
  day_of_week: task.dayOfWeek ?? null,
  date: task.date ?? null,
  territory: task.territory ?? null,
  notes: task.notes ?? null,
  wrike_timelog_id: task.wrikeTimelogId ?? null,
  // Time: always written as "H:MM". A caller may hand us either shape (a pull
  // sets timeSpent, the Tracker sets rawSeconds); both are parsed to seconds
  // and re-formatted so only one shape ever reaches the column.
  time_spent: secsToHM(
    task.timeSpent != null ? parseTimeToSeconds(task.timeSpent) : (task.rawSeconds ?? 0)
  ),
  additional_time: secsToHM(
    task.additionalTime != null
      ? parseTimeToSeconds(task.additionalTime)
      : (task.additionalSeconds ?? 0)
  ),
  // Legacy fields
  film_title: task.filmTitle ?? null,
  client: task.client ?? null,
  project_description: task.projectDescription ?? null,
  client_amends: task.clientAmends ?? false,
  is_3d: task.is3D ?? false,
  task_id: task.taskId ?? null,
});

const fromDb = (row) => ({
  id: row.id,
  source: row.source || "tracker",
  wrikeUserId: row.wrike_user_id,
  // Shared
  jobNumber: row.job_number,
  category: row.category,
  dayOfWeek: row.day_of_week,
  date: row.date,
  territory: row.territory,
  notes: row.notes,
  wrikeTimelogId: row.wrike_timelog_id,
  // Time: raw DB value kept for legacy dropdown compat; seconds derived for in-memory use
  timeSpent: row.time_spent,
  additionalTime: row.additional_time,
  rawSeconds: parseDbTime(row.time_spent),
  additionalSeconds: parseDbTime(row.additional_time),
  // Legacy fields
  filmTitle: row.film_title,
  client: row.client,
  projectDescription: row.project_description,
  clientAmends: row.client_amends ?? false,
  is3D: row.is_3d ?? false,
  taskId: row.task_id,
});

/**
 * Supabase-backed task store.
 *
 * @param triggerToast  Toast callback
 * @param source        "tracker" | "legacy" | null (no filter)
 * @param wrikeUserId   The Wrike user ID — used to scope reads/writes to the
 *                      current user. Falls back to localStorage on each render
 *                      so subsequent page loads are instant (no waiting for the
 *                      Wrike API call to complete before tasks appear).
 */
export function useTasks(triggerToast, source = null, wrikeUserId = null, weekStart = null) {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);

  // Prop takes priority; localStorage is the fast-path for subsequent loads
  // (already set by setWrikeUserId() on a previous visit).
  const effectiveUid = useMemo(
    () => wrikeUserId || localStorage.getItem("wrike_user_id") || null,
    [wrikeUserId]
  );

  // Stable ref so insert/update callbacks always stamp the latest user ID
  // without needing to be re-created (avoids cascading re-renders).
  const uidRef = useRef(effectiveUid);
  useEffect(() => { uidRef.current = effectiveUid; }, [effectiveUid]);

  // Re-fetch when source, user ID, or week changes
  useEffect(() => {
    const fetchTasks = async () => {
      setLoading(true);
      // On a first login the anon session / identity stamp may still be in
      // flight; querying before then returns an empty set under RLS.
      await whenIdentityReady();
      // Note: "date" is a text column with mixed historical formats (ISO and
      // dd/mm/yyyy), so filtering it with .gte() at the DB level is unreliable
      // (lexicographic string comparison, not a real date compare). Instead we
      // fetch all matching rows and filter by weekStart client-side after
      // normalising every date to ISO below.
      // selectAll: a plain read stops at 1000 rows. Ordered newest-first that
      // truncation quietly eats a long-serving user's OLDEST tasks, so the
      // current week looks fine while older weeks come up empty. selectAll pages
      // ascending, so reverse to keep the newest-first order callers expect.
      let error = null;
      const data = await selectAll("tasks", "*", (q) => {
        if (source) q = q.eq("source", source);
        if (effectiveUid) q = q.eq("wrike_user_id", effectiveUid);
        return q;
      }).catch((e) => { error = e; return []; });

      if (error) {
        console.error("Failed to load tasks:", error);
        triggerToast?.("Failed to load tasks from database.");
      } else {
        const mapped = data.slice().reverse().map(fromDb);
        if (weekStart) {
          // Normalise any "dd/mm/yyyy" dates to ISO before comparing.
          // Old entries were saved with toLocaleDateString("en-GB") which sorts
          // incorrectly against weekStart ("24/06/2026" > "2026-06-29" lexicographically).
          const toIso = (d) => {
            if (!d) return null;
            if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
            const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
            return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
          };
          setTasks(mapped.filter(t => {
            const iso = toIso(t.date);
            return iso && iso >= weekStart;
          }));
        } else {
          setTasks(mapped);
        }
      }
      setLoading(false);
    };

    fetchTasks();
  }, [source, effectiveUid, weekStart]);

  const addTask = useCallback(async (task) => {
    const t = { ...task, wrikeUserId: task.wrikeUserId ?? uidRef.current };
    setTasks((prev) => [t, ...prev]);
    await whenIdentityReady();
    const { error } = await supabase.from("tasks").insert(toDb(t));
    if (error) {
      console.error("Failed to save task:", error);
      triggerToast?.("Saved locally but failed to sync.");
      setTasks((prev) => prev.filter((x) => x.id !== t.id));
    }
  }, []);

  const addTasks = useCallback(async (newTasks) => {
    const stamped = newTasks.map((t) => ({ ...t, wrikeUserId: t.wrikeUserId ?? uidRef.current }));
    setTasks((prev) => [...stamped, ...prev]);
    await whenIdentityReady();
    const { error } = await supabase.from("tasks").insert(stamped.map(toDb));
    if (error) {
      console.error("Failed to save tasks:", error);
      triggerToast?.("Some tasks failed to sync.");
      setTasks((prev) => prev.filter((t) => !stamped.some((s) => s.id === t.id)));
    }
  }, []);

  // Which rows have just been written to Supabase successfully, as id → nonce.
  //
  // Edits here are optimistic: the cell shows the new value the instant you
  // leave it, whether or not the write landed. A failure toasts, but a success
  // said nothing at all, so "did that actually save?" had no answer — on a
  // timesheet, of all things. Consumers use this to confirm the write.
  //
  // A nonce rather than a boolean, so a second save to the same row inside the
  // display window is distinguishable from the first (the grid keys its flash on
  // it, which restarts the animation instead of leaving it mid-flight).
  const [justSaved, setJustSaved] = useState({});
  const savedTimers = useRef({});
  const flagSaved = useCallback((id) => {
    setJustSaved((prev) => ({ ...prev, [id]: (prev[id] || 0) + 1 }));
    clearTimeout(savedTimers.current[id]);
    savedTimers.current[id] = setTimeout(() => {
      setJustSaved((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }, 1000);
  }, []);
  // Timers outlive the write, so a page swap mid-save would otherwise set state
  // on an unmounted hook.
  useEffect(() => () => {
    for (const t of Object.values(savedTimers.current)) clearTimeout(t);
  }, []);

  const updateTask = useCallback(async (id, changes) => {
    // A task carries time twice — seconds in memory, "H:MM" for the DB — and a
    // caller only ever sets one of them: the grid's dropdown writes timeSpent,
    // the Tracker's editor writes rawSeconds. Deriving the counterpart here
    // keeps them in step. Without this, editing a row's time left the old
    // rawSeconds in state, so the consolidated header and the bookmarklet
    // export both kept reporting the PREVIOUS duration until a full reload.
    const synced = syncTimeFields(changes);
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...synced } : t)));

    const KEY_MAP = {
      jobNumber: "job_number", territory: "territory", category: "category",
      notes: "notes", dayOfWeek: "day_of_week",
      filmTitle: "film_title", client: "client",
      projectDescription: "project_description",
      timeSpent: "time_spent", additionalTime: "additional_time",
      clientAmends: "client_amends", is3D: "is_3d",
    };

    // Persist from the synced seconds, so the column always lands as "H:MM"
    // regardless of which representation the caller set. The grid's dropdown
    // writes bare hours ("2"); normalising here stops that shape reaching the
    // database at all, instead of relying on every reader to interpret it.
    const resolved = { ...synced };
    if ("rawSeconds" in resolved) {
      resolved.timeSpent = secsToHM(resolved.rawSeconds ?? 0);
      delete resolved.rawSeconds;
    }
    if ("additionalSeconds" in resolved) {
      resolved.additionalTime = secsToHM(resolved.additionalSeconds ?? 0);
      delete resolved.additionalSeconds;
    }

    const dbChanges = {};
    for (const [key, val] of Object.entries(resolved)) {
      if (KEY_MAP[key]) dbChanges[KEY_MAP[key]] = val;
    }

    const { error } = await supabase.from("tasks").update(dbChanges).eq("id", id);
    if (error) {
      console.error("Failed to update task:", error);
      triggerToast?.("Update failed to sync.");
    } else {
      flagSaved(id);
    }
  }, [flagSaved]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateTasks = useCallback(async (ids, changes) => {
    setTasks((prev) => prev.map((t) => (ids.includes(t.id) ? { ...t, ...changes } : t)));
    const KEY_MAP = {
      jobNumber: "job_number", territory: "territory", category: "category",
      filmTitle: "film_title", client: "client",
      projectDescription: "project_description",
    };
    const dbChanges = {};
    for (const [key, val] of Object.entries(changes)) {
      if (KEY_MAP[key]) dbChanges[KEY_MAP[key]] = val;
    }
    const results = await Promise.all(
      ids.map((id) => supabase.from("tasks").update(dbChanges).eq("id", id))
    );
    if (results.some((r) => r.error)) triggerToast?.("Some updates failed to sync.");
  }, []);

  const deleteTasks = useCallback(async (ids) => {
    setTasks((prev) => prev.filter((t) => !ids.includes(t.id)));
    const { error } = await supabase.from("tasks").delete().in("id", ids);
    if (error) {
      console.error("Failed to delete:", error);
      triggerToast?.("Delete failed to sync.");
    }
  }, []);

  const importTasks = useCallback(async (incoming) => {
    const existingIds = new Set(tasks.map((t) => t.id));
    const stamped = incoming
      .filter((t) => !existingIds.has(t.id))
      .map((t) => ({ ...t, wrikeUserId: t.wrikeUserId ?? uidRef.current }));
    if (stamped.length === 0) { triggerToast?.("No new tasks found."); return 0; }
    setTasks((prev) => [...stamped, ...prev]);
    await whenIdentityReady();
    const { error } = await supabase.from("tasks").insert(stamped.map(toDb));
    if (error) {
      triggerToast?.("Import failed to sync.");
      setTasks((prev) => prev.filter((t) => !stamped.some((s) => s.id === t.id)));
      return 0;
    }
    return stamped.length;
  }, [tasks]);

  return {
    tasks, setTasks, loading,
    addTask, addTasks, updateTask, updateTasks, deleteTasks, importTasks,
    justSaved,
  };
}
