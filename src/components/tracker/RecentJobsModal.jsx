import React, { useState, useEffect } from "react";
import {
  X, Clock, CheckSquare, Film, Layers, Plus, CheckCircle,
  Activity, Calendar, Tag,
} from "lucide-react";
import SearchableSelect from "../shared/SearchableSelect";
import { CATEGORIES } from "../../constants";
import { getTagStyle, getBorderColorClass } from "../../utils/tagStyles";

export default function RecentJobsModal({
  showRecentJobsModal, setShowRecentJobsModal,
  recentJobsFilter, setRecentJobsFilter,
  wrikeData, wrikeUser,
  recentTaskDraft, setRecentTaskDraft,
  handleExpandRecentJob, handleConfirmRecentJob, handleInstaLogRecentJob,
}) {
  const [localData, setLocalData] = useState([]);
  const [isFetching, setIsFetching] = useState(false);

  useEffect(() => {
    if (!showRecentJobsModal || !wrikeUser?.id) return;

    setIsFetching(true);
    const fields = encodeURIComponent("[description,superTaskIds]");

    Promise.all([
      fetch(`/api/wrike/tasks?responsibles=[${wrikeUser.id}]&status=Active&fields=${fields}&pageSize=500`),
      fetch(`/api/wrike/tasks?responsibles=[${wrikeUser.id}]&fields=${fields}&pageSize=1000`),
      fetch(`/api/wrike/workflows`),
    ])
      .then(([aRes, cRes, wRes]) => Promise.all([aRes.json(), cRes.json(), wRes.json()]))
      .then(([aJson, cJson, wJson]) => {
        const statusNameMap = {};
        (wJson.data || []).forEach((wf) => {
          (wf.customStatuses || []).forEach((cs) => { statusNameMap[cs.id] = cs.name; });
        });

        const allRaw = [...(aJson.data || []), ...(cJson.data || [])];

        // Build set of all task IDs assigned to this user
        const assignedIds = new Set(allRaw.map((t) => t.id));

        // Hide a task if any of its parents are also assigned to this user
        // (i.e. it's a leaf beneath a batch/parent the user also owns)
        const isChildOfAssigned = (task) =>
          (task.superTaskIds || []).some((pid) => assignedIds.has(pid));

        const enrich = (task) => {
          const customStatusName = task.customStatusId
            ? (statusNameMap[task.customStatusId] || task.status)
            : task.status;
          const isDone = task.status === "Completed" ||
            /^(delivered|completed|done|published)$/i.test(customStatusName);
          const html = (task.description || "").replace(/<[^>]*>/g, " ");
          const folderMatches = html.match(/\/Volumes\/[^\s]+/gi) || [];
          let projectName = "";
          const filmFreq = {};
          for (const path of folderMatches) {
            const parts = path.split("/");
            const digIdx = parts.findIndex((p) => p.toUpperCase() === "DIGITAL");
            if (digIdx > 0 && parts[digIdx - 1]) {
              const name = decodeURIComponent(parts[digIdx - 1]).replace(/[_\-]/g, " ").trim();
              filmFreq[name] = (filmFreq[name] || 0) + 1;
            }
          }
          if (Object.keys(filmFreq).length > 0) {
            projectName = Object.entries(filmFreq).sort((a, b) => b[1] - a[1])[0][0];
          }
          if (!projectName) {
            const verbMatch = task.title.match(
              /^(?:Edit|Design|Animation|Motion|Finish|Grade|Sound|Audio|VFX|Colourist|DI)\s*[-–]\s*(.+?)(?:\s*[-–]\s*.+)?$/i
            );
            if (verbMatch) projectName = verbMatch[1].trim();
          }
          if (!projectName) projectName = task.title.split(/[_\-]/)[0].trim() || "Other Projects";
          return { ...task, customStatusName, isDone, projectName, assignees: [wrikeUser.firstName] };
        };

        const activeTasks = (aJson.data || [])
          .filter((t) => !isChildOfAssigned(t))
          .map(enrich);
        const completedTasks = (cJson.data || [])
          .filter((t) => !isChildOfAssigned(t))
          .map(enrich)
          .filter((t) => t.isDone);

        const seen = new Set(activeTasks.map((t) => t.id));
        const fetched = [...activeTasks, ...completedTasks.filter((t) => !seen.has(t.id))];

        console.log("[RecentJobs] active:", activeTasks.length, "delivered:", completedTasks.length);
        setLocalData(fetched);
      })
      .catch(console.error)
      .finally(() => setIsFetching(false));
  }, [showRecentJobsModal, wrikeUser?.id]);

  if (!showRecentJobsModal) return null;

  const dataSource = localData;

  const filteredTasks = dataSource.filter((t) => {
    if (!t.assignees) return false;
    // For on-demand fetched data use isDone; for wrikeData prop fallback use original status check
    const done = t.isDone !== undefined
      ? t.isDone
      : (t.status === "Completed" || t.status === "Delivered");
    if (recentJobsFilter === "Active" && done) return false;
    if (recentJobsFilter === "Completed" && !done) return false;
    return wrikeUser?.firstName ? t.assignees.includes(wrikeUser.firstName) : true;
  });

  const topTasks = [...filteredTasks]
    .sort((a, b) => {
      const aIsMatrix = a.title?.toUpperCase().includes("MATRIX") ? 1 : 0;
      const bIsMatrix = b.title?.toUpperCase().includes("MATRIX") ? 1 : 0;
      if (aIsMatrix !== bIsMatrix) return aIsMatrix - bIsMatrix;
      if (recentJobsFilter === "Completed") {
        return new Date(b.completedDate || b.updatedDate || 0) - new Date(a.completedDate || a.updatedDate || 0);
      }
      return new Date(b.updatedDate || 0) - new Date(a.updatedDate || 0);
    })
    .slice(0, 30);

  // Group by campaign
  const grouped = topTasks.reduce((acc, t) => {
    const campaign = t.projectName || "Other Projects";
    if (!acc[campaign]) acc[campaign] = [];
    acc[campaign].push(t);
    return acc;
  }, {});

  const getRelevantDate = (tasks) =>
    recentJobsFilter === "Completed"
      ? Math.max(...tasks.map((t) => new Date(t.completedDate || t.updatedDate || 0).getTime()))
      : Math.max(...tasks.map((t) => new Date(t.updatedDate || 0).getTime()));

  const sortedCampaigns = Object.keys(grouped).sort((a, b) =>
    getRelevantDate(grouped[b]) - getRelevantDate(grouped[a])
  );

  const sortTasks = (tasks) =>
    [...tasks].sort((a, b) =>
      recentJobsFilter === "Completed"
        ? new Date(b.completedDate || b.updatedDate || 0) - new Date(a.completedDate || a.updatedDate || 0)
        : new Date(b.updatedDate || 0) - new Date(a.updatedDate || 0)
    );

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-[#122027]/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white rounded-3xl max-w-3xl w-full p-6 sm:p-8 shadow-2xl flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex justify-between items-center mb-6 pb-4 border-b border-[#dce4ec] shrink-0">
          <div className="flex items-center gap-3">
            <div className={`p-2.5 rounded-xl ${recentJobsFilter === "Active" ? "bg-[#12a0e1]/10 text-[#12a0e1]" : "bg-[#1cc1a5]/10 text-[#1cc1a5]"}`}>
              {recentJobsFilter === "Active" ? <Clock className="w-6 h-6" /> : <CheckSquare className="w-6 h-6" />}
            </div>
            <div>
              <h3 className="text-2xl font-black text-[#122027] tracking-tight">
                {recentJobsFilter === "Active" ? "Your Recent Jobs" : "Completed Jobs"}
              </h3>
              <p className="text-[#768994] text-sm mt-0.5">
                {recentJobsFilter === "Active" ? "Log your times directly from your active jobs!" : "Log final wrap-up times on your delivered work."}
              </p>
            </div>
          </div>
          <button
            onClick={() => { setShowRecentJobsModal(false); setRecentTaskDraft(null); }}
            className="p-2 bg-slate-100 hover:bg-[#dce4ec] text-[#768994] rounded-full transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Filter tabs */}
        <div className="flex gap-2 mb-4 shrink-0">
          {["Active", "Completed"].map((f) => (
            <button
              key={f}
              onClick={() => setRecentJobsFilter(f)}
              className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-colors ${recentJobsFilter === f ? "bg-[#12a0e1] text-white" : "bg-slate-100 text-[#768994] hover:bg-slate-200"}`}
            >
              {f}
            </button>
          ))}
        </div>

        {/* Task list */}
        <div className="overflow-y-auto pr-2 pb-2 space-y-3 flex-1 custom-scrollbar">
          {isFetching ? (
            <div className="text-center py-10 text-[#768994]">
              <div className="w-8 h-8 border-2 border-[#12a0e1] border-t-transparent rounded-full animate-spin mx-auto mb-3" />
              <p className="font-bold text-sm">Fetching your Wrike tasks…</p>
            </div>
          ) : filteredTasks.length === 0 ? (
            <div className="text-center py-10 text-[#768994]">
              <Layers className="w-10 h-10 mx-auto opacity-20 mb-3" />
              <p className="font-bold">
                {recentJobsFilter === "Active" ? "No active assigned Wrike tasks found." : "No completed Wrike tasks found."}
              </p>
              <p className="text-sm mt-1">Make sure your Wrike token is saved and you have tasks assigned to you.</p>
            </div>
          ) : (
            sortedCampaigns.map((campaign) => {
              const sortedTasks = sortTasks(grouped[campaign]);
              return (
                <div key={campaign} className="mb-6 last:mb-0">
                  <div className="text-xs font-black text-[#12a0e1] uppercase tracking-widest mb-3 flex items-center gap-2 border-b border-[#dce4ec] pb-2">
                    <Film className="w-4 h-4" /> {campaign}
                    <span className="bg-slate-100 text-[#768994] px-2 py-0.5 rounded-md text-[10px] ml-auto">
                      {sortedTasks.length} {sortedTasks.length === 1 ? "Job" : "Jobs"}
                    </span>
                  </div>

                  <div className="space-y-3">
                    {sortedTasks.map((task) => {
                      const isExpanded = recentTaskDraft?.taskId === task.id;
                      const statusName = task.customStatusName || task.status;
                      const borderColor = getBorderColorClass(statusName);
                      const isMatrix = task.title?.toUpperCase().includes("MATRIX");

                      const formattedDueDate = task.dueDate && task.dueDate !== "No Due Date"
                        ? new Date(task.dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })
                        : "No Due Date";
                      const formattedCompletedDate = task.completedDate
                        ? new Date(task.completedDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })
                        : null;
                      const formattedUpdatedDate = task.updatedDate
                        ? new Date(task.updatedDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })
                        : null;

                      return (
                        <div
                          key={task.id}
                          className={`p-4 border-y border-r border-l-4 rounded-2xl transition-all ${borderColor} ${
                            isExpanded ? "shadow-md bg-white border-y-[#12a0e1]/30 border-r-[#12a0e1]/30"
                            : isMatrix ? "border-y-[#dce4ec] border-r-[#dce4ec] hover:shadow-md bg-slate-200/50 opacity-60 hover:opacity-100 cursor-pointer group"
                            : "border-y-[#dce4ec] border-r-[#dce4ec] hover:shadow-md bg-slate-50 hover:bg-white cursor-pointer group"
                          }`}
                          onClick={() => { if (!isExpanded) handleExpandRecentJob(task); }}
                        >
                          <div className="flex justify-between items-start gap-4">
                            <div className="flex-1 min-w-0">
                              <div className="flex flex-wrap items-center gap-2 mb-1.5">
                                <span className={getTagStyle(statusName)}>{statusName}</span>
                                <div className="flex items-center gap-2 ml-auto sm:ml-2">
                                  {recentJobsFilter === "Completed" && formattedCompletedDate ? (
                                    <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 shadow-sm" title="Date Delivered">
                                      <CheckCircle className="w-3 h-3" /> Delivered {formattedCompletedDate}
                                    </span>
                                  ) : null}
                                  <span className="flex items-center gap-1 text-[10px] font-bold text-indigo-500 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-200 shadow-sm" title="Last Updated">
                                    <Activity className="w-3 h-3" /> Updated {formattedUpdatedDate || "Unknown"}
                                  </span>
                                  {task.dueDate && task.dueDate !== "No Due Date" && (
                                    <span className="flex items-center gap-1 text-[10px] font-bold text-[#768994] bg-white px-2 py-0.5 rounded border border-slate-200 shadow-sm">
                                      <Calendar className="w-3 h-3" /> Due {formattedDueDate}
                                    </span>
                                  )}
                                </div>
                              </div>
                              <div className={`text-sm font-bold transition-colors ${isExpanded ? "text-[#12a0e1]" : isMatrix ? "text-slate-500 group-hover:text-[#12a0e1]" : "text-[#122027] group-hover:text-[#12a0e1]"}`}>
                                {task.title}
                              </div>
                            </div>
                            {!isExpanded && (
                              <div className={`px-3 py-1.5 rounded-lg border text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 mt-1 sm:mt-0 ${
                                isMatrix ? "bg-transparent border-slate-300 text-slate-400 group-hover:bg-slate-200 group-hover:text-slate-600"
                                : "bg-white border-[#dce4ec] text-[#768994] group-hover:bg-[#12a0e1] group-hover:text-white group-hover:border-[#12a0e1]"
                              }`}>
                                <Plus className="w-3.5 h-3.5" /> Expand
                              </div>
                            )}
                          </div>

                          {isExpanded && (
                            <div className="mt-4 pt-4 border-t border-[#dce4ec] space-y-4 animate-in fade-in duration-200">
                              <div className="grid grid-cols-2 gap-3 text-xs bg-slate-50 p-3 rounded-xl border border-slate-100">
                                <div><span className="text-[#768994] font-black uppercase">Job:</span> {recentTaskDraft.jobNumber || "⚠️ Needed"}</div>
                                <div><span className="text-[#768994] font-black uppercase">Country:</span> {recentTaskDraft.territory || "⚠️ Needed"}</div>
                              </div>
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="relative z-50">
                                  <label className="text-[10px] font-black text-[#768994] uppercase tracking-widest flex items-center gap-1.5 mb-1.5">
                                    <Tag className="w-3.5 h-3.5" /> Set Category
                                  </label>
                                  <SearchableSelect
                                    options={CATEGORIES} value={recentTaskDraft.category}
                                    onChange={(val) => setRecentTaskDraft({ ...recentTaskDraft, category: val })}
                                    placeholder="Select a category..." isGrouped={true}
                                  />
                                </div>
                                <div>
                                  <label className="text-[10px] font-black text-[#768994] uppercase tracking-widest flex items-center gap-1.5 mb-1.5">
                                    <Clock className="w-3.5 h-3.5" /> Insta-Log Time (Optional)
                                  </label>
                                  <div className="flex gap-2">
                                    {[
                                      { field: "hours", placeholder: "Hrs", max: undefined },
                                      { field: "minutes", placeholder: "Mins", max: 59 },
                                    ].map(({ field, placeholder, max }) => (
                                      <input
                                        key={field} type="number" min="0" max={max}
                                        value={recentTaskDraft[field]}
                                        onChange={(e) => setRecentTaskDraft({ ...recentTaskDraft, [field]: e.target.value })}
                                        placeholder={placeholder}
                                        className="w-full bg-white border border-[#dce4ec] rounded-xl px-3 py-2.5 text-sm focus:border-[#12a0e1] focus:ring-2 focus:ring-[#12a0e1]/20 outline-none transition-all"
                                      />
                                    ))}
                                  </div>
                                </div>
                              </div>
                              <div className="flex justify-between items-center pt-2 mt-2">
                                <button onClick={(e) => { e.stopPropagation(); handleConfirmRecentJob(); }} className="px-4 py-2 text-xs font-bold text-[#12a0e1] hover:bg-[#12a0e1]/10 rounded-lg transition-colors">
                                  Load to Tracker
                                </button>
                                <div className="flex gap-2">
                                  <button onClick={(e) => { e.stopPropagation(); setRecentTaskDraft(null); }} className="px-4 py-2 text-xs font-bold text-[#768994] hover:bg-slate-200 rounded-lg transition-colors">
                                    Cancel
                                  </button>
                                  <button onClick={(e) => { e.stopPropagation(); handleInstaLogRecentJob(); }} className="px-5 py-2 text-xs font-bold bg-[#1cc1a5] hover:bg-[#15a38b] text-white rounded-lg shadow-sm shadow-[#1cc1a5]/20 transition-all flex items-center gap-1.5">
                                    <CheckCircle className="w-4 h-4" /> Insta-Log
                                  </button>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
