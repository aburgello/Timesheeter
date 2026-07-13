import React, { useEffect } from "react";
import {
  Activity, Download, RefreshCw,
  List,
  Layers, Globe, Tag, Film,
} from "lucide-react";

import { TERRITORIES, TERRITORY_FLAGS, CATEGORIES, DAYS_OF_WEEK } from "../../constants";
import { useTrackerState } from "../../hooks/useTrackerState";
import { useTaskActions } from "../../hooks/useTaskActions";
import { useWrikeUser } from "../../hooks/useWrikeUser";
import { useTasks } from "../../hooks/useTasks";
import { useJobLookup } from "../../hooks/useJobLookup";
import { getCurrentWeekStart } from "../../hooks/useLegacyRows";
import { formatDurationText } from "../../utils/timeHelpers";
import SearchableSelect from "../shared/SearchableSelect";
import PageHeader, { pageHeaderActionClass } from "../shared/PageHeader";
import TriageModal from "./TriageModal";
import DeleteModal from "./DeleteModal";
import ExportModal from "./ExportModal";
import TimerPanel from "./TimerPanel";
import HistoryTab from "./HistoryTab";

export default function Tracker({ wrikeData, onNavigateToHub }) {
  const state = useTrackerState();
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

  const stateWithPull = { ...state, tasks, setTasks, addTask, addTasks, updateTask, updateTasks, deleteTasks, importTasks, isPullingTime, setIsPullingTime, wrikeUser, jobLookup };
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

  // Normalise a task regardless of whether it came from Tracker or Legacy
  const getTerritory = (t) => t.territory || "Unknown Territory";
  const getRawSeconds = (t) => {
    if (t.rawSeconds) return t.rawSeconds;
    if (t.timeSpent && t.timeSpent !== "none") return Math.round(parseFloat(t.timeSpent) * 3600);
    return 0;
  };
  const getAddSeconds = (t) => {
    if (t.additionalSeconds) return t.additionalSeconds;
    if (t.additionalTime && t.additionalTime !== "none") return Math.round(parseFloat(t.additionalTime) * 3600);
    return 0;
  };

  // Derived data
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

      <PageHeader pageId="timesheet" icon={Activity} title="XYi Timesheeter" subtitle="Timesheet Tracker for the Motion Peeps">
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
                  className={`relative flex flex-col items-center justify-center py-4 px-2 rounded-2xl transition-all border ${
                    isActive
                      ? "bg-white border-[#12a0e1]/30 text-[#12a0e1] shadow-md scale-[1.02]"
                      : "bg-transparent border-transparent text-[#768994] hover:bg-white/50 hover:text-[#122027]"
                  }`}
                >
                  <span className="text-sm font-black uppercase tracking-wider">{day}</span>
                  <span className={`text-[11px] mt-1.5 font-mono px-3 py-0.5 rounded-full font-bold ${
                    daySeconds > 0
                      ? isActive ? "bg-[#12a0e1]/10 text-[#12a0e1]" : "bg-slate-200 text-[#122027]"
                      : "bg-slate-100/50 text-[#768994]"
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
                    <SearchableSelect options={jobOptions} value={jobNumber} onChange={setJobNumber} placeholder="Type to search or add..." icon={Film} disabled={isRunning && entryMode === "timer"} quickFilters={["DOOH","Titles","Print","Digital","Internal"]} isGrouped={true} alignRight={false} dropdownId="tracker-job" activeDropdown={activeDropdown} setActiveDropdown={setActiveDropdown} />
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
                    <SearchableSelect options={TERRITORIES} value={territory} onChange={setTerritory} placeholder="Search..." disabled={isRunning && entryMode === "timer"} getPrefix={(val) => TERRITORY_FLAGS[val]} isGrouped={false} alignRight={false} dropdownId="tracker-territory" activeDropdown={activeDropdown} setActiveDropdown={setActiveDropdown} />
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
                      className="w-full bg-white border border-[#dce4ec] focus:border-[#12a0e1] focus:ring-2 focus:ring-[#12a0e1]/20 rounded-xl px-4 py-3 text-sm transition-all outline-none resize-none placeholder:text-[#768994] shadow-sm"
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
