import { useState, useEffect } from "react";
import { DAYS_OF_WEEK } from "../constants";
import { notify } from "../lib/toast";

/**
 * All UI state for the Tracker component.
 * Tasks are no longer stored here — they live in useTasks (Supabase-backed).
 * Job options remain in localStorage as a UI convenience list.
 */
export function useTrackerState() {
  // --- Form fields — pre-filled from last logged task ---
  const [jobNumber, setJobNumber] = useState(() => {
    try {
      const last = localStorage.getItem("xyi_last_task_defaults");
      return last ? JSON.parse(last).jobNumber || "" : "";
    } catch { return ""; }
  });
  const [territory, setTerritory] = useState(() => {
    try {
      const last = localStorage.getItem("xyi_last_task_defaults");
      return last ? JSON.parse(last).territory || "" : "";
    } catch { return ""; }
  });
  const [category, setCategory] = useState(() => {
    try {
      const last = localStorage.getItem("xyi_last_task_defaults");
      return last ? JSON.parse(last).category || "" : "";
    } catch { return ""; }
  });
  const [notes, setNotes] = useState("");

  // --- Timer ---
  const [isRunning, setIsRunning] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [trackingSince, setTrackingSince] = useState(null);
  const [entryMode, setEntryMode] = useState("timer");
  const [manualHours, setManualHours] = useState("");
  const [manualMinutes, setManualMinutes] = useState("");
  const [showReward, setShowReward] = useState(false);

  // --- Retain toggles ---
  const [retainJobNumber, setRetainJobNumber] = useState(true);
  const [retainTerritory, setRetainTerritory] = useState(true);
  const [retainCategory, setRetainCategory] = useState(true);

  // --- Day / Tab ---
  const [selectedDay, setSelectedDay] = useState(() => {
    const dayNames = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const todayName = dayNames[new Date().getDay()];
    return DAYS_OF_WEEK.includes(todayName) ? todayName : "Monday";
  });
  const [activeTab, setActiveTab] = useState("history");

  // --- Job options (persisted locally — just a UI convenience dropdown list) ---
  const [jobOptions, setJobOptions] = useState(() => {
    // Starts empty rather than from a hardcoded catalogue. Tracker.jsx merges
    // jobLookup.jobNumbers over this list, so the Job Book is the real source;
    // this only remembers jobs logged on this device that the book hasn't seen.
    const saved = localStorage.getItem("xyi_job_options_v5");
    return saved ? JSON.parse(saved) : [];
  });

  useEffect(() => {
    localStorage.setItem("xyi_job_options_v5", JSON.stringify(jobOptions));
  }, [jobOptions]);

  // --- Toast (now backed by Sonner via the shared notifier) ---
  const [toast, setToast] = useState({ show: false, message: "", type: "error" });
  const triggerToast = (message, type = "error") => notify(message, type);

  // --- Triage & modals ---
  const [triageQueue, setTriageQueue] = useState([]);
  const [triageCategory, setTriageCategory] = useState("");
  const [itemToDelete, setItemToDelete] = useState(null);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showRecentJobsModal, setShowRecentJobsModal] = useState(false);
  const [recentTaskDraft, setRecentTaskDraft] = useState(null);
  const [recentJobsFilter, setRecentJobsFilter] = useState("Active");
  const [jsonCopied, setJsonCopied] = useState(false);
  const [pastedJson, setPastedJson] = useState("");

  // --- Inline editing ---
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [editNoteText, setEditNoteText] = useState("");
  const [historyTimer, setHistoryTimer] = useState({ taskId: null, type: null });
  const [editingGroupId, setEditingGroupId] = useState(null);
  const [editGroupForm, setEditGroupForm] = useState({ jobNumber: "", territory: "", category: "" });
  const [editingTaskId, setEditingTaskId] = useState(null);
  const [editTaskForm, setEditTaskForm] = useState({ jobNumber: "", territory: "", category: "" });
  const [editingTimeId, setEditingTimeId] = useState(null);
  const [editTimeForm, setEditTimeForm] = useState({
    rawHours: 0, rawMins: 0, rawSecs: 0,
    addHours: 0, addMins: 0, addSecs: 0,
  });

  // --- Timer interval (only handles the running clock; history timer ticks
  //     are handled in Tracker.jsx using updateTask from useTasks) ---
  useEffect(() => {
    if (!isRunning || !trackingSince) return;
    const interval = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - trackingSince) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [isRunning, trackingSince]);

  return {
    // Form fields
    jobNumber, setJobNumber,
    territory, setTerritory,
    category, setCategory,
    notes, setNotes,
    // Timer
    isRunning, setIsRunning,
    elapsedTime, setElapsedTime,
    trackingSince, setTrackingSince,
    entryMode, setEntryMode,
    manualHours, setManualHours,
    manualMinutes, setManualMinutes,
    showReward, setShowReward,
    // Retain
    retainJobNumber, setRetainJobNumber,
    retainTerritory, setRetainTerritory,
    retainCategory, setRetainCategory,
    // Day/Tab
    selectedDay, setSelectedDay,
    activeTab, setActiveTab,
    // Job options
    jobOptions, setJobOptions,
    // Toast
    toast, setToast, triggerToast,
    // Triage & modals
    triageQueue, setTriageQueue,
    triageCategory, setTriageCategory,
    itemToDelete, setItemToDelete,
    showExportModal, setShowExportModal,
    showRecentJobsModal, setShowRecentJobsModal,
    recentTaskDraft, setRecentTaskDraft,
    recentJobsFilter, setRecentJobsFilter,
    jsonCopied, setJsonCopied,
    pastedJson, setPastedJson,
    // Inline editing
    editingNoteId, setEditingNoteId,
    editNoteText, setEditNoteText,
    historyTimer, setHistoryTimer,
    editingGroupId, setEditingGroupId,
    editGroupForm, setEditGroupForm,
    editingTaskId, setEditingTaskId,
    editTaskForm, setEditTaskForm,
    editingTimeId, setEditingTimeId,
    editTimeForm, setEditTimeForm,
  };
}