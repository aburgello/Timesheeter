import { useCallback, useMemo, useRef } from "react";
import { useTasks } from "./useTasks";

// Parses either a decimal string ("1.5") or an "H:MM" string ("1:30") into hours.
// getTimesheetValue() in LegacyTimesheet.js produces H:MM for Wrike-pulled rows;
// everything else (TIME_OPTIONS, manual edits) uses decimal strings.
export const hmToHours = (val) => {
  if (typeof val !== "string" || !val.includes(":")) {
    const n = parseFloat(val);
    return isNaN(n) ? 0 : n;
  }
  const [h, m] = val.split(":").map(Number);
  return (h || 0) + (m || 0) / 60;
};

// Normalise a legacy row on add/read — useTasks.fromDb already handles seconds↔hours.
// No rounding here: Supabase stores the exact pulled/entered time (same as Tracker).
// 0.5h rounding only happens at JSON-export time (see handleCopyJSON), since that's
// the only consumer (the old timesheet website) that requires half-hour steps.
const normaliseLegacyRow = (row) => ({
  ...row,
  territory: row.territory || "",
  timeSpent: row.timeSpent || "none",
  additionalTime: row.additionalTime || "none",
  // Derive rawSeconds from timeSpent for in-memory use. Uses hmToHours so "H:MM"
  // values (from Wrike pulls) convert correctly instead of being truncated by
  // parseFloat at the colon.
  rawSeconds: row.rawSeconds || (row.timeSpent && row.timeSpent !== "none"
    ? Math.round(hmToHours(row.timeSpent) * 3600)
    : 0),
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
  };
}
