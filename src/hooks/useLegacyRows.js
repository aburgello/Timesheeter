import { useCallback, useMemo, useRef } from "react";
import { useTasks } from "./useTasks";
import { parseTimeToHours, parseTimeToSeconds } from "../utils/timeHelpers";

// Hours from any stored shape — "1:30", "1.5", "2", "none". Kept as a named
// export because the day/week totals in LegacyTimesheets read in hours, but it
// is the shared parser underneath, so it can no longer disagree with the one
// useTasks uses to build rawSeconds.
export const hmToHours = parseTimeToHours;

// Normalise a legacy row on add/read — useTasks.fromDb already handles seconds↔hours.
// No rounding here, and none at export either: Supabase and the exported JSON both
// carry the exact pulled/entered time. The timesheet website's step size varies by
// job (UK-folder jobs take 0.25, INT jobs 0.5), so the bookmarklet snaps each row
// against that row's own dropdown — the only place the real grid is knowable.
const normaliseLegacyRow = (row) => ({
  ...row,
  territory: row.territory || "",
  timeSpent: row.timeSpent || "none",
  additionalTime: row.additionalTime || "none",
  // Derive rawSeconds from timeSpent for in-memory use, through the shared
  // parser so "H:MM", "1.5" and "2" all mean what they say.
  rawSeconds: row.rawSeconds ?? parseTimeToSeconds(row.timeSpent),
  // Auto-derive project description from job number
  projectDescription: row.projectDescription ||
    (row.jobNumber?.includes(",") ? row.jobNumber.substring(row.jobNumber.indexOf(",") + 1).trim() : ""),
});

/**
 * Wraps useTasks scoped to source="legacy".
 * Exposes the same API that LegacyTimesheets.js already uses
 * (rows, setRows, addRow, updateRow, deleteRow, addRows)
 * so the component needs minimal changes.
 */

// Returns "YYYY-MM-DD" for Monday of the current week
export function getCurrentWeekStart() {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
}

// dd/mm/yyyy — the canonical stored format for task dates
const dmyDate = (d = new Date()) =>
  `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

export function useLegacyRows(triggerToast, wrikeUserId = null) {
  const weekStart = useRef(getCurrentWeekStart()).current;

  const {
    tasks: rows,
    setTasks: setRows,
    loading,
    addTask,
    addTasks,
    updateTask,
    deleteTasks,
    justSaved,
  } = useTasks(triggerToast, null, wrikeUserId, weekStart);

  // Add a single blank row (from the + button) — always stamp today's date
  const addRow = useCallback(async (row) => {
    await addTask({ ...normaliseLegacyRow(row), source: "legacy", date: row.date || dmyDate() });
  }, [addTask]);

  // Add multiple rows at once (from Wrike pull) — ensure a valid dd/mm/yyyy date on each
  const addRows = useCallback(async (newRows) => {
    await addTasks(newRows.map((r) => ({
      ...normaliseLegacyRow(r),
      source: "legacy",
      date: /^\d{2}\/\d{2}\/\d{4}$/.test(r.date) ? r.date : dmyDate(),
    })));
  }, [addTasks]);

  // Update a single field on a row (called as updateRow(id, field, value))
  const updateRow = useCallback(async (id, field, value) => {
    // "country" was merged into "territory" — treat them as the same field
    if (field === "country") {
      await updateTask(id, { territory: value });
    } else {
      await updateTask(id, { [field]: value });
    }
  }, [updateTask]);

  // Delete a single row
  const deleteRow = useCallback(async (id) => {
    await deleteTasks([id]);
  }, [deleteTasks]);

  // Normalise on read — week filtering is already applied inside useTasks
  const normalisedRows = useMemo(() => rows.map(normaliseLegacyRow), [rows]);

  return {
    rows: normalisedRows,
    setRows,
    loading,
    addRow,
    addRows,
    updateRow,
    deleteRow,
    weekStart,
    // id → nonce for rows whose write to Supabase just landed; the grid flashes
    // the row so an optimistic edit is visibly confirmed.
    justSaved,
  };
}
