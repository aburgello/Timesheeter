import React, { useEffect, useMemo, useCallback } from "react";
import {
  Activity, Download, RefreshCw,
  List,
  Layers, Globe, Tag, Film,
} from "lucide-react";

import { CATEGORIES, DAYS_OF_WEEK } from "../../constants";
import { useTrackerState } from "../../hooks/useTrackerState";
import { useTaskActions } from "../../hooks/useTaskActions";
import { useWrikeUser } from "../../hooks/useWrikeUser";
import { useTasks } from "../../hooks/useTasks";
import { useJobLookup } from "../../hooks/useJobLookup";
import { useDepartment } from "../../hooks/useDepartment";
import { trackerSubtitleFor, jobQuickFiltersFor } from "../../lib/departments";
import { getCurrentWeekStart } from "../../hooks/useLegacyRows";
import { formatDurationText, parseTimeToSeconds } from "../../utils/timeHelpers";
import SearchableSelect from "../shared/SearchableSelect";
import MultiCountrySelect from "../shared/MultiCountrySelect";
import PageHeader, { pageHeaderActionClass } from "../shared/PageHeader";
import TriageModal from "./TriageModal";
import DeleteModal from "./DeleteModal";
import ExportModal from "./ExportModal";
import TimerPanel from "./TimerPanel";
import HistoryTab from "./HistoryTab";

export default function Tracker({ wrikeData, onNavigateToHub }) {
  const state = useTrackerState();
  const department = useDepartment();
  const {
    jobNumber, setJobNumber, territory, setTerritory, category, setCategory, notes, setNotes,
    isRunning, elapsedTime, entryMode, setEntryMode, manualHours, setManualHours,
    manualMinutes, setManualMinutes, showReward,
    retainJobNumber, setRetainJobNumber, retainTerritory, setRetainTerritory,
    retainCategory, setRetainCategory,
    selectedDay, setSelectedDay,
    jobOptions,
    toast, setToast, triggerToast,
    triageQueue, setTriageQueue, triageCategory, setTriageCategory,
    itemToDelete, setItemToDelete,
    showExportModal, setShowExportModal,
    jsonCopied, setJsonCopied, pastedJson, setPastedJson,
    editingNoteId, setEditingNoteId, editNoteText, setEditNoteText,
    historyTimer, setHistoryTimer,
    editingGroupId, setEditingGroupId, editGroupForm, setEditGroupForm,
    editingTaskId, setEditingTaskId, editTaskForm, setEditTaskForm,
    editingTimeId, setEditingTimeId, editTimeForm, setEditTimeForm,
  } = state;

  // isPullingTime lives here since it's UI feedback only
  const [isPullingTime, setIsPullingTime] = React.useState(false);
  const [activeDropdown, setActiveDropdown] = React.useState(null);

  // Must be before useTasks so wrikeUser.id is available to scope the query
  const { wrikeUser, userStats, handleFetchLifetimeStats } =
    useWrikeUser(wrikeData, triggerToast);

  // Tasks are Supabase-backed via useTasks — scoped to this Wrike user + current week
  const { tasks, setTasks, loading: tasksLoading, addTask, addTasks, updateTask, updateTasks, deleteTasks, importTasks } = useTasks(triggerToast, null, wrikeUser?.id, getCurrentWeekStart());

  // Job Book lookup — lets guessed job/film/client be overridden by admin-curated
  // data, and self-populates Job Book from real usage the first time a job is seen.
  const jobLookup = useJobLookup();

  // What the job picker actually offers: the Job Book first (the live list,
  // continuously backfilled from Wrike), then anything this browser has logged
  // that hasn't reached the book yet. jobOptions on its own is a hardcoded
  // constant plus local additions, which is why most of the studio's jobs
  // couldn't be found by searching.
  //
  // Deduped by XY code, not by string. The same job exists in both lists under
  // different spellings — the constant says "Paw Patrol: The Dino Movie", the
  // book says "Paw Patrol The Dino Movie" — and since the picker groups by the
  // text before " : ", a plain union listed that film twice, once with 19 jobs
  // and once with 37. The book's spelling wins: it's the curated source, and
  // it's what the timesheet bookmarklet matches against.
  const allJobOptions = useMemo(() => {
    const byCode = new Map();
    const keyFor = (opt) => (opt.match(/XY\d{5,6}/i) || [opt])[0].toUpperCase();
    for (const opt of jobLookup.jobNumbers || []) byCode.set(keyFor(opt), opt);
    for (const opt of jobOptions) {
      const k = keyFor(opt);
      if (!byCode.has(k)) byCode.set(k, opt);
    }
    return [...byCode.values()];
  }, [jobLookup.jobNumbers, jobOptions]);

  // Downstream too: the job-number guesser resolves a Wrike code against this
  // list, so a short list meant a real job resolved to nothing.
  const stateWithPull = { ...state, jobOptions: allJobOptions, tasks, setTasks, addTask, addTasks, updateTask, updateTasks, deleteTasks, importTasks, isPullingTime, setIsPullingTime, wrikeUser, jobLookup };
  const actions = useTaskActions(stateWithPull);

  // Lottie script loader
  useEffect(() => {
    if (!document.querySelector('script[src*="dotlottie-wc"]')) {
      const script = document.createElement("script");
      script.src = "https://unpkg.com/@lottiefiles/dotlottie-wc@0.9.14/dist/dotlottie-wc.js";
      script.type = "module";
      document.head.appendChild(script);
    }
  }, []);

  // Normalise a task regardless of whether it came from Tracker or Legacy.
  // Both fall back through the shared parser rather than parseFloat, which
  // truncated an "H:MM" string at the colon and turned 2:30 into 2 hours.
  const getTerritory = (t) => t.territory || "Unknown Territory";
  const getRawSeconds = (t) => t.rawSeconds || parseTimeToSeconds(t.timeSpent);
  const getAddSeconds = (t) => t.additionalSeconds || parseTimeToSeconds(t.additionalTime);

  // Derived data
  // Job picker ordering. jobOptions is append-only — every job ever seen, in
  // the order it was first seen — so the dropdown opened on the oldest films
  // in the studio's history and you scrolled past finished work to reach what
  // you're actually on today.
  //
  // Rank each film by the newest job under it, using the Job Book's own dates.
  // Anything marked done contributes nothing, so a wrapped campaign sinks even
  // if it was recent. Films you've logged against this week beat everything,
  // since that's the strongest signal of what you're working on right now.
  const myRecentFilms = useMemo(() => {
    const seen = new Set();
    for (const t of tasks) if (t.filmTitle) seen.add(t.filmTitle.toLowerCase());
    return seen;
  }, [tasks]);

  const rankJobGroup = useCallback(
    (groupName, items) => {
      if (myRecentFilms.has(String(groupName).toLowerCase())) return Number.MAX_SAFE_INTEGER;
      let newest = 0;
      for (const opt of items) {
        const job = jobLookup?.getJob?.(opt);
        if (!job || job.job_done) continue;
        const t = Date.parse(job.start_date || job.created_at || "") || 0;
        if (t > newest) newest = t;
      }
      return newest;
    },
    [jobLookup, myRecentFilms]
  );

  const currentFilteredTasks = tasks.filter((t) => t.dayOfWeek === selectedDay);
  const getSecondsForDay = (day) =>
    tasks.filter((t) => t.dayOfWeek === day).reduce((sum, t) => sum + getRawSeconds(t) + getAddSeconds(t), 0);

  const consolidatedGroups = currentFilteredTasks.reduce((acc, task) => {
    const territory = getTerritory(task);
    const key = `${task.jobNumber}|||${territory}|||${task.category}`;
    if (!acc[key]) {
      acc[key] = { jobNumber: task.jobNumber || "Unknown Job", territory, category: task.category || "Unknown Category", filmTitle: task.filmTitle || "", tasks: [], totalRaw: 0, totalAdd: 0 };
    }
    acc[key].tasks.push(task);
    acc[key].totalRaw += getRawSeconds(task);
    acc[key].totalAdd += getAddSeconds(task);
    return acc;
  }, {});

  return (
    <div className="min-h-screen bg-slate-100 text-[#122027] font-sans selection:bg-[#12a0e1]/30 selection:text-[#122027] pb-12">
      {/* Global overlays */}
      <TriageModal
        triageQueue={triageQueue} setTriageQueue={setTriageQueue}
        triageCategory={triageCategory} setTriageCategory={setTriageCategory}
        setTasks={setTasks} updateTasks={updateTasks} triggerToast={triggerToast}
      />
      <DeleteModal
        itemToDelete={itemToDelete} setItemToDelete={setItemToDelete}
        executeDelete={actions.executeDelete}
      />
      <ExportModal
        showExportModal={showExportModal} setShowExportModal={setShowExportModal}
        jsonCopied={jsonCopied} pastedJson={pastedJson} setPastedJson={setPastedJson}
        handleCopyJSONToClipboard={actions.handleCopyJSONToClipboard}
        handlePasteImport={actions.handlePasteImport}
      />

      <PageHeader pageId="timesheet" icon={Activity} title="XYi Timesheeter" subtitle={trackerSubtitleFor(department)}>
        <button
          onClick={() => actions.handlePullWrikeTime(wrikeData)}
          disabled={isPullingTime}
          className={pageHeaderActionClass}
        >
          <RefreshCw className={`w-4 h-4 ${isPullingTime ? "animate-spin" : ""}`} />
          {isPullingTime ? "Pulling..." : "Pull Wrike Time"}
        </button>
        <button
          onClick={() => setShowExportModal(true)}
          className={pageHeaderActionClass}
        >
          <Download className="w-4 h-4" /> Manage Data
        </button>
      </PageHeader>

      <div className="max-w-[1800px] mx-auto px-4 sm:px-6 pt-8 space-y-6">
        {/* Day selector */}
        <div className="bg-white/60 backdrop-blur-xl shadow-sm border border-[#dce4ec] p-3 rounded-3xl">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
            {DAYS_OF_WEEK.map((day) => {
              const isActive = selectedDay === day;
              const daySeconds = getSecondsForDay(day);
              return (
                <button
                  key={day}
                  onClick={() => setSelectedDay(day)}
                  className={`relative flex flex-col items-center justify-center py-4 px-2 rounded-2xl transition-[transform,background-color,border-color] border focus-visible:ring-4 focus-visible:ring-[#12a0e1]/25 focus-visible:ring-inset focus-visible:outline-none ${
                    isActive
                      ? "bg-white border-[#12a0e1]/30 text-[#12a0e1] shadow-md scale-[1.02]"
                      : "bg-transparent border-transparent text-[#122027] hover:bg-white/50 hover:text-[#122027]"
                  }`}
                >
                  <span className={`text-sm uppercase tracking-wider ${isActive ? "font-black" : "font-semibold"}`}>{day}</span>
                  <span className={`text-[11px] mt-1.5 font-mono px-3 py-0.5 rounded-full font-bold ${
                    daySeconds > 0
                      ? isActive ? "bg-[#12a0e1]/10 text-[#12a0e1]" : "bg-slate-200 text-[#122027]"
                      : "bg-slate-100 text-[#122027]"
                  }`}>
                    {daySeconds > 0 ? formatDurationText(daySeconds) : "Snoozing"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Main layout */}
        <div className="flex flex-col lg:flex-row items-start gap-6 relative">
          <div className="flex-1 min-w-0 w-full space-y-6">
            {/* Job input form */}
            <div className="bg-white border border-[#dce4ec] shadow-xl shadow-slate-200/40 rounded-3xl p-6 sm:p-8 sm:pb-10 relative z-30">
              <div className="absolute inset-x-0 top-0 h-8 overflow-hidden rounded-t-3xl pointer-events-none">
                <div className="absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r from-[#12a0e1] to-[#1cc1a5]" />
              </div>
              <div className="flex justify-between items-center pb-5 mt-0">
                <h2 className="text-xl font-black text-[#122027] tracking-tight">Track Job</h2>
                <span className="text-xs font-bold px-3 py-1 bg-slate-100 text-[#768994] rounded-lg uppercase tracking-wider">{selectedDay}</span>
              </div>
              <div className="space-y-5">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Job String */}
                  <div className="md:col-span-2">
                    <div className="flex justify-between items-center mb-1.5">
                      <label className="text-[11px] font-black text-[#768994] uppercase tracking-widest flex items-center gap-1.5">
                        <Layers className="w-3.5 h-3.5" /> Job String
                      </label>
                      <label className="flex items-center gap-1.5 text-[11px] font-bold text-[#12a0e1] cursor-pointer hover:opacity-70 transition-opacity">
                        <input type="checkbox" checked={retainJobNumber} onChange={(e) => setRetainJobNumber(e.target.checked)} className="rounded border-slate-300 text-[#12a0e1] focus:ring-[#12a0e1] w-3.5 h-3.5" />
                        Keep Selection
                      </label>
                    </div>
                    <SearchableSelect options={allJobOptions} value={jobNumber} onChange={setJobNumber} placeholder="Type to search or add..." icon={Film} disabled={isRunning && entryMode === "timer"} quickFilters={jobQuickFiltersFor(department)} isGrouped={true} groupRank={rankJobGroup} alignRight={false} dropdownId="tracker-job" activeDropdown={activeDropdown} setActiveDropdown={setActiveDropdown} />
                  </div>
                  {/* Country */}
                  <div>
                    <div className="flex justify-between items-center mb-1.5">
                      <label className="text-[11px] font-black text-[#768994] uppercase tracking-widest flex items-center gap-1.5">
                        <Globe className="w-3.5 h-3.5" /> Country
                      </label>
                      <label className="flex items-center gap-1.5 text-[11px] font-bold text-[#12a0e1] cursor-pointer">
                        <input type="checkbox" checked={retainTerritory} onChange={(e) => setRetainTerritory(e.target.checked)} className="rounded border-slate-300 text-[#12a0e1] focus:ring-[#12a0e1] w-3.5 h-3.5" />
                        Keep
                      </label>
                    </div>
                    <MultiCountrySelect value={territory} onChange={setTerritory} placeholder="Pick countries..." variant="form" disabled={isRunning && entryMode === "timer"} dropdownId="tracker-territory" activeDropdown={activeDropdown} setActiveDropdown={setActiveDropdown} needsAttention={!!jobNumber} />
                  </div>
                  {/* Category */}
                  <div>
                    <div className="flex justify-between items-center mb-1.5">
                      <label className="text-[11px] font-black text-[#768994] uppercase tracking-widest flex items-center gap-1.5">
                        <Tag className="w-3.5 h-3.5" /> Category
                      </label>
                      <label className="flex items-center gap-1.5 text-[11px] font-bold text-[#12a0e1] cursor-pointer">
                        <input type="checkbox" checked={retainCategory} onChange={(e) => setRetainCategory(e.target.checked)} className="rounded border-slate-300 text-[#12a0e1] focus:ring-[#12a0e1] w-3.5 h-3.5" />
                        Keep
                      </label>
                    </div>
                    <SearchableSelect options={CATEGORIES} value={category} onChange={setCategory} placeholder="Search..." disabled={isRunning && entryMode === "timer"} isGrouped={true} alignRight={true} dropdownId="tracker-category" activeDropdown={activeDropdown} setActiveDropdown={setActiveDropdown} />
                  </div>
                  {/* Notes */}
                  <div className="md:col-span-2">
                    <textarea
                      value={notes} onChange={(e) => setNotes(e.target.value)}
                      placeholder="More info / Notes (Optional)..." disabled={isRunning && entryMode === "timer"}
                      rows="2"
                      className="w-full bg-white border border-[#dce4ec] focus:border-[#12a0e1] focus:ring-2 focus:ring-[#12a0e1]/20 rounded-xl px-4 py-3 text-sm transition-[transform,background-color,border-color] outline-none resize-none placeholder:text-[#768994] shadow-sm"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Logged rows */}
            <div className="bg-white border border-[#dce4ec] shadow-xl shadow-slate-200/40 rounded-3xl flex flex-col relative min-h-[800px] h-auto z-20 pb-4">
              <div className="flex items-center gap-2 px-6 py-4 border-b border-[#dce4ec] bg-slate-50/50 rounded-t-3xl">
                <List className="w-4 h-4 text-[#12a0e1]" />
                <span className="font-bold text-sm text-[#122027]">Logged Rows ({currentFilteredTasks.length})</span>
              </div>
              <div className="p-6 sm:p-8 flex-1 bg-slate-50/50 rounded-b-3xl">
                <HistoryTab
                  loading={tasksLoading}
                  currentFilteredTasks={currentFilteredTasks}
                  consolidatedGroups={consolidatedGroups}
                  editingGroupId={editingGroupId} setEditingGroupId={setEditingGroupId}
                  editGroupForm={editGroupForm} setEditGroupForm={setEditGroupForm}
                  editingTaskId={editingTaskId} setEditingTaskId={setEditingTaskId}
                  editTaskForm={editTaskForm} setEditTaskForm={setEditTaskForm}
                  editingTimeId={editingTimeId} setEditingTimeId={setEditingTimeId}
                  editTimeForm={editTimeForm} setEditTimeForm={setEditTimeForm}
                  editingNoteId={editingNoteId} setEditingNoteId={setEditingNoteId}
                  editNoteText={editNoteText} setEditNoteText={setEditNoteText}
                  jobOptions={jobOptions}
                  updateTask={updateTask}
                  startGroupEdit={actions.startGroupEdit}
                  handleSaveGroupEdit={actions.handleSaveGroupEdit}
                  startTaskEdit={actions.startTaskEdit}
                  handleSaveTaskEdit={actions.handleSaveTaskEdit}
                  startEditingTime={actions.startEditingTime}
                  saveEditedTime={actions.saveEditedTime}
                  startEditingNote={actions.startEditingNote}
                  saveEditedNote={actions.saveEditedNote}
                  setItemToDelete={setItemToDelete}
                />
              </div>
            </div>
          </div>

          <TimerPanel
            isRunning={isRunning} elapsedTime={elapsedTime}
            entryMode={entryMode} setEntryMode={setEntryMode}
            manualHours={manualHours} setManualHours={setManualHours}
            manualMinutes={manualMinutes} setManualMinutes={setManualMinutes}
            showReward={showReward}
            handleToggleTimer={actions.handleToggleTimer}
            handleLogTask={actions.handleLogTask}
            tasks={tasks}
            onNavigateToHub={onNavigateToHub}
            wrikeUser={wrikeUser} userStats={userStats}
            handleFetchLifetimeStats={handleFetchLifetimeStats}
          />
        </div>
      </div>
    </div>
  );
}
