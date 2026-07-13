import { DAYS_OF_WEEK } from "../constants";
import { guessFieldsFromTask } from "../utils/wrikeHelpers";
import { fetchExistingTimelogIds } from "../lib/supabaseClient";
import { roundToHalfHourSeconds } from "../utils/timeHelpers";
import { logTimeToWrike } from "../lib/wrikeApi";

/**
 * All task manipulation handlers: log, delete, edit group/task/time/note,
 * export/import, Wrike pull, recent jobs.
 *
 * Receives state slice + setters from useTrackerState.
 */
export function useTaskActions(state) {
  const {
    jobNumber, territory, category, notes,
    setJobNumber, setTerritory, setCategory, setNotes,
    isRunning, elapsedTime, setIsRunning, setElapsedTime, setTrackingSince,
    entryMode, manualHours, manualMinutes, setManualHours, setManualMinutes,
    setShowReward,
    retainJobNumber, retainTerritory, retainCategory,
    selectedDay,
    tasks, setTasks, addTask, addTasks, updateTask, updateTasks, deleteTasks, importTasks,
    jobOptions, setJobOptions,
    triggerToast,
    setTriageQueue,
    itemToDelete, setItemToDelete,
    setJsonCopied,
    pastedJson, setPastedJson,
    editingNoteId, setEditingNoteId, editNoteText,
    historyTimer, setHistoryTimer,
    editingGroupId, setEditingGroupId, editGroupForm,
    editingTaskId, setEditingTaskId, editTaskForm,
    editingTimeId, setEditingTimeId, editTimeForm,
    setShowRecentJobsModal, recentTaskDraft, setRecentTaskDraft,
    wrikeUser,
  } = state;

  // --- Timer toggle ---
  const handleToggleTimer = () => {
    if (!jobNumber.trim() || !territory.trim() || !category.trim()) {
      triggerToast("Please assign Job String, Country, and Category to track.");
      return;
    }
    if (isRunning) {
      setIsRunning(false);
      setTrackingSince(null);
    } else {
      setIsRunning(true);
      setTrackingSince(Date.now() - elapsedTime * 1000);
    }
  };

  // --- Log task ---
  const handleLogTask = () => {
    if (!jobNumber.trim() || !territory.trim() || !category.trim()) {
      triggerToast("Cannot save row without Job Number, Country, and Category.");
      return;
    }

    let finalSeconds = elapsedTime;
    if (entryMode === "manual") {
      finalSeconds =
        parseInt(manualHours || 0, 10) * 3600 +
        parseInt(manualMinutes || 0, 10) * 60;
      if (finalSeconds === 0) return triggerToast("Enter a valid manual duration.");
    } else if (elapsedTime === 0) {
      return triggerToast("No time tracked to log.");
    }

    if (jobNumber && !jobOptions.includes(jobNumber))
      setJobOptions((prev) => [...prev, jobNumber]);

    const newTask = {
      id: Date.now(),
      jobNumber, territory, category, notes,
      dayOfWeek: selectedDay,
      rawSeconds: finalSeconds,
      additionalSeconds: 0,
      date: new Date().toLocaleDateString("en-GB"),
      timeLogged: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    addTask(newTask);
    // Save as smart defaults for next session
    localStorage.setItem("xyi_last_task_defaults", JSON.stringify({ jobNumber, territory, category }));
    triggerToast(`Logged successfully to ${selectedDay}!`, "success");
    setShowReward(true);
    setTimeout(() => setShowReward(false), 1200);

    if (entryMode === "timer") {
      setIsRunning(false);
      setTrackingSince(null);
      setElapsedTime(0);
    } else {
      setManualHours("");
      setManualMinutes("");
    }

    if (!retainJobNumber) setJobNumber("");
    if (!retainTerritory) setTerritory("");
    if (!retainCategory) setCategory("");
    setNotes("");
  };

  // --- Pull Wrike time ---
  // wrikeData is optional — used as a cache if already loaded, otherwise
  // we fetch only the specific task IDs that appear in today's timelogs.
  const handlePullWrikeTime = async (wrikeData) => {
    const wrikeUserId = state.wrikeUser?.id;
    if (!wrikeUserId) return triggerToast("Please connect Wrike in your Profile → Settings first.");

    state.setIsPullingTime(true);

    try {
      const dayNames = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

      const fieldsParam = encodeURIComponent("[customFields,description]");

      // Fetch timelogs (contacts-scoped = same endpoint as Legacy, more reliable)
      // and active timers in parallel
      const [timelogsRes, timersRes] = await Promise.all([
        fetch(`/api/wrike/contacts/${wrikeUserId}/timelogs`),
        fetch("/api/wrike/timers"),
      ]);

      const logs = (await timelogsRes.json()).data || [];
      const activeTimers = (await timersRes.json()).data || [];

      // Filter to today using local date string (avoids UTC-midnight shift)
      const todayLogs = logs.filter((l) => l.trackedDate?.split("T")[0] === todayStr);
      const todayTimers = activeTimers.filter((t) => t.updatedDate?.split("T")[0] === todayStr);

      // Build a task lookup map — seed from wrikeData if already available
      const taskMap = {};
      (wrikeData || []).forEach((t) => { taskMap[t.id] = t; });

      // Fetch only the task IDs we don't already have
      const neededIds = [...new Set([
        ...todayLogs.map((l) => l.taskId),
        ...todayTimers.map((t) => t.taskId),
      ])].filter((id) => id && !taskMap[id]);

      if (neededIds.length > 0) {
        // Fetch each task individually with a bare fallback — same pattern as
        // handleOpenWrikeModal in Legacy (batch path-param can 403/404 silently)
        await Promise.all(neededIds.map(async (taskId) => {
          try {
            let res = await fetch(`/api/wrike/tasks/${taskId}?fields=${fieldsParam}`);
            if (!res.ok) {
              res = await fetch(`/api/wrike/tasks/${taskId}`);
            }
            if (res.ok) {
              const json = await res.json();
              if (json.data) json.data.forEach((t) => { taskMap[t.id] = t; });
            } else {
              console.warn(`Could not fetch task ${taskId}: ${res.status}`);
            }
          } catch (err) {
            console.warn(`Failed to fetch task ${taskId}:`, err);
          }
        }));
      }

      const guessFields = (taskId, commentText, fallbackTitle) => {
        // Pass comment as extraText so territory aliases (e.g. UAE) in comments are resolved
        const guessed = guessFieldsFromTask(taskMap[taskId], jobOptions, commentText || "", state.jobLookup?.getJob);
        // Register this job number in Job Book the first time it's seen (no-op if already known)
        state.jobLookup?.ensureJob(guessed.jobNumber, guessed);
        return { ...guessed, notes: commentText || guessed.notes || fallbackTitle };
      };

      // Fetch existing timelog IDs across ALL sources so we don't duplicate
      // entries that were already pulled in Legacy (or vice versa)
      const existingTimelogIds = await fetchExistingTimelogIds(wrikeUserId);

      const newTasks = [];

      todayLogs.forEach((log) => {
        if (existingTimelogIds.has(log.id)) return;
        const fields = guessFields(log.taskId, log.comment, "Wrike Timelog");
        const logDate = new Date(log.trackedDate);
        const logDayName = dayNames[logDate.getDay()];
        // Derive project description from job number "Film : CODE, Description"
        const projectDescription = fields.jobNumber?.includes(",")
          ? fields.jobNumber.substring(fields.jobNumber.indexOf(",") + 1).trim()
          : "";
        newTasks.push({
          id: Date.now() + Math.floor(Math.random() * 1000),
          wrikeTimelogId: log.id,
          taskId: log.taskId,
          ...fields,
          projectDescription,
          dayOfWeek: DAYS_OF_WEEK.includes(logDayName) ? logDayName : "Monday",
          rawSeconds: Math.floor(log.hours * 3600),
          additionalSeconds: 0,
          date: logDate.toLocaleDateString("en-GB"),
          timeLogged: logDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        });
      });

      todayTimers.forEach((timer) => {
        const timerUniqueId = `timer-${timer.taskId}-${timer.updatedDate}`;
        if (existingTimelogIds.has(timerUniqueId)) return;
        const fields = guessFields(timer.taskId, "", "Wrike Live Timer");
        const logDate = new Date(timer.updatedDate);
        const logDayName = dayNames[logDate.getDay()];
        const accumulatedSeconds = Math.floor((timer.accumulatedMins || 0) * 60);
        newTasks.push({
          id: Date.now() + Math.floor(Math.random() * 1000),
          wrikeTimelogId: timerUniqueId,
          taskId: timer.taskId,
          ...fields,
          notes: `${fields.notes} [Live Wrike Timer ⏱️]`,
          dayOfWeek: DAYS_OF_WEEK.includes(logDayName) ? logDayName : "Monday",
          rawSeconds: accumulatedSeconds > 0 ? accumulatedSeconds : 60,
          additionalSeconds: 0,
          date: logDate.toLocaleDateString("en-GB"),
          timeLogged: logDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        });
      });

      if (newTasks.length > 0) {
        addTasks(newTasks);
        triggerToast(`Pulled ${newTasks.length} entr${newTasks.length === 1 ? "y" : "ies"} from today!`, "success");

        const needingTriage = newTasks.filter((t) => t.category === "⚠️ Unassigned");
        if (needingTriage.length > 0) {
          setTriageQueue(
            needingTriage.map((t) => ({
              jobNumber: t.jobNumber,
              territory: t.territory,
              taskIds: [t.id],
              sampleTitle: t.notes,
            }))
          );
        }
      } else {
        triggerToast("No new timelogs found for today.", "info");
      }
    } catch (err) {
      triggerToast("Failed to pull Wrike times: " + err.message);
    } finally {
      state.setIsPullingTime(false);
    }
  };

  // --- Group edit ---
  const startGroupEdit = (group, key) => {
    setEditingGroupId(key);
    state.setEditGroupForm({
      jobNumber: group.jobNumber === "⚠️ Unassigned" ? "" : group.jobNumber,
      territory: group.territory === "⚠️ Unassigned" ? "" : group.territory,
      category: group.category === "⚠️ Unassigned" ? "" : group.category,
    });
  };

  const handleSaveGroupEdit = (groupTasks) => {
    if (!editGroupForm.jobNumber || !editGroupForm.territory || !editGroupForm.category) {
      triggerToast("Please select Job, Country, and Category for the batch.");
      return;
    }
    const taskIds = groupTasks.map((t) => t.id);
    // Re-derive filmTitle from the (possibly newly-picked) job number "Film Name : CODE, ..." —
    // otherwise a stale filmTitle from a bad Wrike folder-tree guess would survive the edit.
    const jobColonMatch = editGroupForm.jobNumber.match(/^([^:]+)\s*:/);
    const filmTitle = jobColonMatch ? jobColonMatch[1].trim() : undefined;
    updateTasks(taskIds, {
      jobNumber: editGroupForm.jobNumber,
      territory: editGroupForm.territory,
      category: editGroupForm.category,
      ...(filmTitle ? { filmTitle } : {}),
    });
    if (editGroupForm.jobNumber && !jobOptions.includes(editGroupForm.jobNumber)) {
      setJobOptions((prev) => [...prev, editGroupForm.jobNumber]);
    }
    setEditingGroupId(null);
    triggerToast("Batch updated and assigned successfully!", "success");
  };

  // --- Task edit ---
  const startTaskEdit = (task) => {
    setEditingTaskId(task.id);
    state.setEditTaskForm({
      jobNumber: task.jobNumber === "⚠️ Unassigned" ? "" : task.jobNumber,
      territory: task.territory === "⚠️ Unassigned" ? "" : task.territory,
      category: task.category === "⚠️ Unassigned" ? "" : task.category,
    });
  };

  const handleSaveTaskEdit = (taskId) => {
    if (!editTaskForm.jobNumber || !editTaskForm.territory || !editTaskForm.category) {
      triggerToast("Please select Job, Country, and Category to move this task.");
      return;
    }
    updateTask(taskId, { jobNumber: editTaskForm.jobNumber, territory: editTaskForm.territory, category: editTaskForm.category });
    if (editTaskForm.jobNumber && !jobOptions.includes(editTaskForm.jobNumber)) {
      setJobOptions((prev) => [...prev, editTaskForm.jobNumber]);
    }
    setEditingTaskId(null);
    triggerToast("Subtask detached and moved successfully!", "success");
  };

  // --- Time edit ---
  const startEditingTime = (task) => {
    setEditingTimeId(task.id);
    state.setEditTimeForm({
      rawHours: Math.floor((task.rawSeconds || 0) / 3600),
      rawMins: Math.floor(((task.rawSeconds || 0) % 3600) / 60),
      rawSecs: (task.rawSeconds || 0) % 60,
      addHours: Math.floor((task.additionalSeconds || 0) / 3600),
      addMins: Math.floor(((task.additionalSeconds || 0) % 3600) / 60),
      addSecs: (task.additionalSeconds || 0) % 60,
    });
  };

  const saveEditedTime = (id) => {
    const newRaw =
      parseInt(editTimeForm.rawHours || 0) * 3600 +
      parseInt(editTimeForm.rawMins || 0) * 60 +
      parseInt(editTimeForm.rawSecs || 0);
    const newAdd =
      parseInt(editTimeForm.addHours || 0) * 3600 +
      parseInt(editTimeForm.addMins || 0) * 60 +
      parseInt(editTimeForm.addSecs || 0);

    updateTask(id, { rawSeconds: newRaw, additionalSeconds: newAdd });
    setEditingTimeId(null);
    triggerToast("Time updated successfully!", "success");
  };

  // --- Note edit ---
  const startEditingNote = (task) => {
    setEditingNoteId(task.id);
    state.setEditNoteText(task.notes || "");
  };

  const saveEditedNote = (id) => {
    updateTask(id, { notes: state.editNoteText });
    setEditingNoteId(null);
    triggerToast("Note updated.", "success");
  };

  // --- Delete ---
  const executeDelete = () => {
    if (!itemToDelete) return;
    if (historyTimer.taskId && itemToDelete.ids.includes(historyTimer.taskId)) {
      setHistoryTimer({ taskId: null, type: null });
    }
    deleteTasks(itemToDelete.ids);
    triggerToast(
      itemToDelete.type === "group" ? "Batch deleted successfully." : "Subtask deleted successfully.",
      "success"
    );
    setItemToDelete(null);
  };

  // --- History timer ---
  const toggleHistoryTimer = (taskId, type) => {
    setHistoryTimer((prev) =>
      prev.taskId === taskId && prev.type === type
        ? { taskId: null, type: null }
        : { taskId, type }
    );
  };

  // --- Export / import ---
  const getConsolidatedTasks = (taskList) => {
    const consolidated = {};
    taskList.forEach((t) => {
      const key = `${t.dayOfWeek}|${t.jobNumber}|${t.territory}|${t.category}`;
      if (!consolidated[key]) {
        consolidated[key] = { ...t, rawSeconds: 0, additionalSeconds: 0, notesArray: [], subtaskCount: 0 };
      }
      consolidated[key].rawSeconds += t.rawSeconds || 0;
      consolidated[key].additionalSeconds += t.additionalSeconds || 0;
      consolidated[key].subtaskCount += 1;
      if (t.notes && !consolidated[key].notesArray.includes(t.notes)) {
        consolidated[key].notesArray.push(t.notes);
      }
    });
    // Round to nearest 0.5h at export time only — the old timesheet website
    // only accepts half-hour values. Supabase itself stores unrounded time.
    return Object.values(consolidated).map((c) => ({
      ...c,
      rawSeconds: roundToHalfHourSeconds(c.rawSeconds),
      additionalSeconds: c.additionalSeconds > 0 ? roundToHalfHourSeconds(c.additionalSeconds) : 0,
      notes: c.notesArray.filter(Boolean).join(" | "),
    }));
  };

  const generateExportData = () => ({
    version: 5,
    exportDate: new Date().toISOString(),
    tasks: getConsolidatedTasks(tasks),
    rawTasks: tasks,
    jobOptions,
  });

  const handleCopyJSONToClipboard = () => {
    try {
      const tempTextArea = document.createElement("textarea");
      tempTextArea.value = JSON.stringify(generateExportData());
      document.body.appendChild(tempTextArea);
      tempTextArea.select();
      document.execCommand("copy");
      document.body.removeChild(tempTextArea);
      setJsonCopied(true);
      triggerToast("JSON Copied! Ready to paste into Timesheet Bookmarklet.", "success");
      setTimeout(() => setJsonCopied(false), 3000);
    } catch {
      triggerToast("Failed to copy JSON.");
    }
  };

  const handlePasteImport = async () => {
    try {
      const data = JSON.parse(pastedJson);
      const tasksToImport = data.rawTasks || data.tasks || [];
      if (data && tasksToImport) {
        const count = await importTasks(tasksToImport);
        if (data.jobOptions) setJobOptions((prev) => [...new Set([...prev, ...data.jobOptions])]);
        setPastedJson("");
        if (count > 0) triggerToast(`Merged ${count} new tasks successfully!`, "success");
      } else throw new Error("Invalid format");
    } catch {
      triggerToast("Invalid JSON syntax pasted.");
    }
  };

  // --- Recent jobs ---
  const handleExpandRecentJob = (task) => {
    const guessed = guessFieldsFromTask(task, jobOptions, "", state.jobLookup?.getJob);
    setRecentTaskDraft({
      taskId: task.id,
      jobNumber: guessed.jobNumber !== "⚠️ Unassigned" ? guessed.jobNumber : "",
      territory: guessed.territory !== "⚠️ Unassigned" ? guessed.territory : "",
      category: "",
      notes: task.title || "",
      hours: "",
      minutes: "",
    });
  };

  const handleInstaLogRecentJob = () => {
    if (!recentTaskDraft.category) {
      triggerToast("Please select a category first.");
      return;
    }
    const finalSeconds =
      parseInt(recentTaskDraft.hours || 0, 10) * 3600 +
      parseInt(recentTaskDraft.minutes || 0, 10) * 60;
    if (finalSeconds === 0) {
      triggerToast("Please enter the time spent (Hrs/Mins) to log.");
      return;
    }
    if (recentTaskDraft.jobNumber && !jobOptions.includes(recentTaskDraft.jobNumber)) {
      setJobOptions((prev) => [...prev, recentTaskDraft.jobNumber]);
    }
    const newTask = {
      id: Date.now(),
      jobNumber: recentTaskDraft.jobNumber,
      territory: recentTaskDraft.territory,
      category: recentTaskDraft.category,
      notes: recentTaskDraft.notes,
      dayOfWeek: selectedDay,
      rawSeconds: finalSeconds,
      additionalSeconds: 0,
      date: new Date().toLocaleDateString("en-GB"),
      timeLogged: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };
    addTask(newTask);
    logTimeToWrike(recentTaskDraft.taskId, finalSeconds).then((ok) => {
      triggerToast(ok ? "Synced to Wrike task." : "Logged locally, but Wrike sync failed.", ok ? "success" : "info");
    });
    triggerToast(`Insta-Logged successfully to ${selectedDay}!`, "success");
    setShowReward(true);
    setTimeout(() => setShowReward(false), 1200);
    setShowRecentJobsModal(false);
    setRecentTaskDraft(null);
  };

  const handleConfirmRecentJob = () => {
    if (!recentTaskDraft.category) {
      triggerToast("Please select a category first.");
      return;
    }
    setJobNumber(recentTaskDraft.jobNumber);
    setTerritory(recentTaskDraft.territory);
    setCategory(recentTaskDraft.category);
    setNotes(recentTaskDraft.notes);
    setShowRecentJobsModal(false);
    setRecentTaskDraft(null);
    triggerToast("Job loaded! Hit Start Timer when ready.", "success");
  };

  return {
    handleToggleTimer,
    handleLogTask,
    handlePullWrikeTime,
    startGroupEdit, handleSaveGroupEdit,
    startTaskEdit, handleSaveTaskEdit,
    startEditingTime, saveEditedTime,
    startEditingNote, saveEditedNote,
    executeDelete,
    toggleHistoryTimer,
    getConsolidatedTasks,
    handleCopyJSONToClipboard,
    handlePasteImport,
    handleExpandRecentJob,
    handleInstaLogRecentJob,
    handleConfirmRecentJob,
  };
}