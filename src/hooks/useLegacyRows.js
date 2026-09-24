import { useCallback, useMemo, useRef } from "react";
import { useTasks } from "./useTasks";
import { parseTimeToHours } from "../utils/timeHelpers";
import { normaliseLegacyRow } from "../utils/legacyRow";
import { ukDateForWeekday } from "../utils/dates";

// Hours from any stored shape — "1:30", "1.5", "2", "none". Kept as a named
// export because the day/week totals in LegacyTimesheets read in hours, but it
// is the shared parser underneath, so it can no longer disagree with the one
// useTasks uses to build rawSeconds.
export const hmToHours = parseTimeToHours;


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

  // Add a single blank row (from the + button, or from the Generate Today's
  // Timesheet grid). Stamps the date of the DAY THE ROW IS FOR, not today:
  // every caller sets dayOfWeek from the day tab in view, and stamping today
  // instead left the row's own label and its date disagreeing — which the week
  // filter then judged by the date while the grid grouped by the label.
  const addRow = useCallback(async (row) => {
    await addTask({
      ...normaliseLegacyRow(row),
      source: "legacy",
      date: row.date || ukDateForWeekday(row.dayOfWeek),
    });
  }, [addTask]);

  // Add multiple rows at once (from Wrike pull) — ensure a valid dd/mm/yyyy date on each
  const addRows = useCallback(async (newRows) => {
    return addTasks(newRows.map((r) => ({
      ...normaliseLegacyRow(r),
      source: "legacy",
      // A pulled row carries the timelog's own date; the fallback is for a row
      // that somehow arrived without one, and it uses the row's weekday rather
      // than today for the same reason addRow does.
      date: /^\d{2}\/\d{2}\/\d{4}$/.test(r.date) ? r.date : ukDateForWeekday(r.dayOfWeek),
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

  // Delete several rows in one request (Legacy's Merge replaces them).
  const deleteRows = useCallback(async (ids) => {
    await deleteTasks(ids);
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
    deleteRows,
    weekStart,
    // id → nonce for rows whose write to Supabase just landed; the grid flashes
    // the row so an optimistic edit is visibly confirmed.
    justSaved,
  };
}
