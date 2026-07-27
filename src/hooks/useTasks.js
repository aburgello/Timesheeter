import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { supabase, whenIdentityReady } from "../lib/supabaseClient";

// --- Translators ---

// Stores time as "H:MM" — human-readable in Supabase
const secsToHM = (s) => {
  if (!(s > 0)) return null;
  const mins = Math.round(s / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
};

// Reads "H:MM" (new), decimal hours ("0.5"), or integer minutes ("30") — all legacy-compat
const parseDbTime = (v) => {
  if (!v || v === "none") return 0;
  const s = String(v);
  // New format: "H:MM"
  const hm = s.match(/^(\d+):(\d{2})$/);
  if (hm) return (parseInt(hm[1]) * 60 + parseInt(hm[2])) * 60;
  const n = parseFloat(s);
  if (isNaN(n) || n <= 0) return 0;
  // Old decimal hours ("0.5", "1.50") → seconds
  if (s.includes(".")) return Math.round(n * 3600);
  // Old integer minutes ("30", "90") → seconds
  return Math.round(n * 60);
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
  // Time: DB stores integer minutes (new) or decimal hours (old legacy rows)
  time_spent: task.timeSpent ?? secsToHM(task.rawSeconds ?? 0),
  additional_time: task.additionalTime ?? secsToHM(task.additionalSeconds ?? 0),
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
      let query = supabase.from("tasks").select("*").order("id", { ascending: false });
      if (source) query = query.eq("source", source);
      if (effectiveUid) query = query.eq("wrike_user_id", effectiveUid);

      const { data, error } = await query;

      if (error) {
        console.error("Failed to load tasks:", error);
        triggerToast?.("Failed to load tasks from database.");
      } else {
        const mapped = (data ?? []).map(fromDb);
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

  const updateTask = useCallback(async (id, changes) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...changes } : t)));

    const KEY_MAP = {
      jobNumber: "job_number", territory: "territory", category: "category",
      notes: "notes", dayOfWeek: "day_of_week",
      filmTitle: "film_title", client: "client",
      projectDescription: "project_description",
      timeSpent: "time_spent", additionalTime: "additional_time",
      clientAmends: "client_amends", is3D: "is_3d",
    };

    // Convert in-memory seconds to decimal hours before persisting
    const resolved = { ...changes };
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
    }
  }, []);

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
  };
}
