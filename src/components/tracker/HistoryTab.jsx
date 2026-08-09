import React from "react";
import {
  CheckSquare, Film, Globe, Tag, Edit2, Trash2,
  Clock, FolderInput, FileText, Check, X, Save, Plus,
} from "lucide-react";
import SearchableSelect from "../shared/SearchableSelect";
import MultiCountrySelect from "../shared/MultiCountrySelect";
import { territoryFlags } from "../../utils/territories";
import { CATEGORIES } from "../../constants";
import { formatTimerDisplay, getTimesheetValue } from "../../utils/timeHelpers";
import { getBorderColorClass } from "../../utils/tagStyles";

export default function HistoryTab({
  loading,
  currentFilteredTasks, consolidatedGroups,
  editingGroupId, setEditingGroupId, editGroupForm, setEditGroupForm,
  editingTaskId, editTaskForm, setEditTaskForm,
  editingTimeId, setEditingTimeId, editTimeForm, setEditTimeForm,
  editingNoteId, setEditingNoteId, editNoteText, setEditNoteText,
  jobOptions, updateTask,
  startGroupEdit, handleSaveGroupEdit,
  startTaskEdit, handleSaveTaskEdit,
  startEditingTime, saveEditedTime,
  startEditingNote, saveEditedNote,
  setItemToDelete,
}) {
  const [activeDropdown, setActiveDropdown] = React.useState(null);
  const [addingTimeId, setAddingTimeId] = React.useState(null);
  const [addH, setAddH] = React.useState("");
  const [addM, setAddM] = React.useState("");

  const openAddTime = (taskId) => { setAddingTimeId(taskId); setAddH(""); setAddM(""); };
  const closeAddTime = () => { setAddingTimeId(null); setAddH(""); setAddM(""); };
  const commitAddTime = (task) => {
    const extra = (parseInt(addH || 0) * 3600) + (parseInt(addM || 0) * 60);
    if (extra > 0) updateTask(task.id, { additionalSeconds: (task.additionalSeconds || 0) + extra });
    closeAddTime();
  };
  if (loading) {
    return (
      <div className="py-24 flex flex-col items-center justify-center text-[#768994] text-center">
        <div className="w-8 h-8 border-4 border-[#12a0e1]/30 border-t-[#12a0e1] rounded-full animate-spin mb-4" />
        <p className="font-bold text-[#768994]">Loading from database...</p>
      </div>
    );
  }

  if (currentFilteredTasks.length === 0) {
    return (
      <div className="py-24 flex flex-col items-center justify-center text-[#768994] text-center">
        <div className="bg-white p-5 rounded-3xl shadow-sm border border-slate-100 mb-4">
          <CheckSquare className="w-8 h-8 text-slate-300" />
        </div>
        <p className="font-bold text-[#768994] text-lg">No rows logged yet.</p>
        <p className="text-sm mt-1">Start tracking to populate the timesheet.</p>
      </div>
    );
  }

  // Group batches by filmTitle for campaign-level headers
  const byFilm = Object.entries(consolidatedGroups).reduce((acc, [key, group]) => {
    const film = group.filmTitle || "";
    if (!acc[film]) acc[film] = [];
    acc[film].push([key, group]);
    return acc;
  }, {});

  return (
    <div className="space-y-6 relative">
      {Object.entries(byFilm).map(([film, groups]) => (
        <div key={film}>
          {film && (
            <div className="flex items-center gap-2 px-1 mb-3 mt-2">
              <Film className="w-4 h-4 text-[#12a0e1] shrink-0" />
              <span className="text-sm font-black text-[#122027] tracking-tight">{film}</span>
              <div className="flex-1 h-px bg-[#dce4ec]" />
              <span className="text-xs font-bold text-[#768994]">
                {groups.reduce((s, [, g]) => s + g.totalRaw + g.totalAdd, 0) > 0 &&
                  (() => { const s = groups.reduce((sum, [, g]) => sum + g.totalRaw + g.totalAdd, 0); const h = Math.floor(s/3600); const m = Math.floor((s%3600)/60); return `${h}h ${m}m`; })()
                }
              </span>
            </div>
          )}
          <div className="space-y-4">
          {groups.map(([key, group]) => (
        <div
          key={key}
          className={`bg-white border border-[#dce4ec] rounded-2xl shadow-sm transition-shadow relative ${
            group.jobNumber === "⚠️ Unassigned" || group.territory === "⚠️ Unassigned" || group.category === "⚠️ Unassigned"
              ? "ring-2 ring-rose-400" : ""
          } ${editingGroupId === key ? "z-40 ring-2 ring-[#12a0e1] shadow-lg shadow-[#12a0e1]/10" : "z-20"}`}
        >
          {/* Group header */}
          <div className="bg-[#122027] text-white px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-t-2xl">
            <div className="text-sm font-semibold tracking-tight flex items-center gap-2">
              <Film className="w-4 h-4 text-[#1cc1a5] shrink-0" />
              <span className={`truncate max-w-[300px] ${group.jobNumber === "⚠️ Unassigned" ? "text-rose-400" : ""}`}>
                {group.jobNumber}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-3 text-xs font-mono bg-[#25373c] px-3 py-1.5 rounded-lg border border-[#323b43]">
                <span className="text-[#12a0e1]">Base Export: {getTimesheetValue(group.totalRaw)}h</span>
                <span className="text-[#1cc1a5]">Add. Export: {getTimesheetValue(group.totalAdd)}h</span>
              </div>
              <button onClick={() => startGroupEdit(group, key)} className="p-1.5 text-[#768994] hover:text-[#12a0e1] hover:bg-[#12a0e1]/20 transition-colors rounded-lg" title="Edit Entire Batch">
                <Edit2 className="w-4 h-4" />
              </button>
              <button onClick={() => setItemToDelete({ type: "group", ids: group.tasks.map((t) => t.id) })} className="p-1.5 text-[#768994] hover:text-rose-400 hover:bg-rose-500/20 transition-colors rounded-lg" title="Delete Entire Batch">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Batch editor */}
          {editingGroupId === key && (
            <div className="bg-slate-50 px-5 py-4 border-b border-[#dce4ec] space-y-3 relative z-30">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <SearchableSelect options={jobOptions} value={editGroupForm.jobNumber} onChange={(v) => setEditGroupForm({ ...editGroupForm, jobNumber: v })} placeholder="Search Job String..." icon={Film} isGrouped={true} dropdownId="hist-job" activeDropdown={activeDropdown} setActiveDropdown={setActiveDropdown} />
                <MultiCountrySelect value={editGroupForm.territory} onChange={(v) => setEditGroupForm({ ...editGroupForm, territory: v })} placeholder="Pick countries..." variant="form" dropdownId="hist-territory" activeDropdown={activeDropdown} setActiveDropdown={setActiveDropdown} needsAttention />
                <SearchableSelect options={CATEGORIES} value={editGroupForm.category} onChange={(v) => setEditGroupForm({ ...editGroupForm, category: v })} placeholder="Search Category..." icon={Tag} isGrouped={true} alignRight={true} dropdownId="hist-category" activeDropdown={activeDropdown} setActiveDropdown={setActiveDropdown} />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => setEditingGroupId(null)} className="px-4 py-2 text-xs font-bold text-[#768994] hover:bg-slate-200 rounded-lg transition-colors">Cancel</button>
                <button onClick={() => handleSaveGroupEdit(group.tasks)} className="px-4 py-2 text-xs font-bold bg-[#1cc1a5] hover:bg-[#15a38b] text-white rounded-lg shadow-sm shadow-[#1cc1a5]/20 transition-colors flex items-center gap-1.5">
                  <Save className="w-3.5 h-3.5" /> Save Batch
                </button>
              </div>
            </div>
          )}

          {/* Group metadata row */}
          <div className="bg-[#f8fafc] px-5 py-2.5 border-b border-[#dce4ec] flex flex-wrap items-center gap-2 text-[10px] font-black text-[#12a0e1] uppercase tracking-widest">
            <span className={`flex items-center gap-1.5 bg-[#12a0e1]/10 px-2.5 py-1 rounded-lg ${group.territory === "⚠️ Unassigned" ? "text-rose-500 bg-rose-50" : ""}`}>
              {territoryFlags(group.territory, 6) ? <span className="text-[12px] leading-none">{territoryFlags(group.territory, 6)}</span> : <Globe className="w-3.5 h-3.5" />}
              <span className="truncate max-w-[260px]" title={group.territory}>{group.territory}</span>
            </span>
            <span className={`flex items-center gap-1 bg-[#12a0e1]/10 px-2 py-1 rounded-lg truncate max-w-[300px] ${group.category === "⚠️ Unassigned" ? "text-rose-500 bg-rose-50" : ""}`}>
              <Tag className="w-3 h-3" /> {group.category}
            </span>
          </div>

          {/* Subtasks */}
          <div className="divide-y divide-[#dce4ec] flex flex-col">
            {group.tasks.map((task, index) => (
              <div key={task.id} className={`flex flex-col relative ${index === group.tasks.length - 1 ? "rounded-b-2xl" : ""}`}>
                <div className={`p-4 hover:bg-slate-50 transition-colors flex flex-col xl:flex-row justify-between gap-4 items-start xl:items-center group/row ${editingTaskId === task.id ? "bg-[#12a0e1]/10" : ""}`}>
                  <div className="flex-1 min-w-0">
                    {editingNoteId === task.id ? (
                      <div className="flex gap-2 items-start w-full">
                        <textarea value={editNoteText} onChange={(e) => setEditNoteText(e.target.value)} rows="4"
                          className="w-full bg-white text-[#323b43] border border-[#dce4ec] rounded-xl p-3 text-sm leading-relaxed resize-y min-h-[100px] outline-none focus:ring-2 focus:ring-[#12a0e1]/20 focus:border-[#12a0e1] shadow-inner transition-[border-color,box-shadow]"
                        />
                        <div className="flex flex-col gap-2 shrink-0">
                          <button onClick={() => saveEditedNote(task.id)} className="p-2.5 bg-[#1cc1a5] text-white rounded-lg hover:bg-[#15a38b] shadow-sm shadow-[#1cc1a5]/20 transition-[background-color,transform] active:scale-95" title="Save Note"><Check className="w-4 h-4" /></button>
                          <button onClick={() => setEditingNoteId(null)} className="p-2.5 bg-slate-100 text-[#768994] rounded-lg hover:bg-slate-200 transition-colors" title="Cancel"><X className="w-4 h-4" /></button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start gap-1.5 text-sm text-[#323b43] group/note">
                        <FileText className="w-4 h-4 mt-0.5 text-[#12a0e1] shrink-0" />
                        <span className="truncate">{task.notes || <span className="italic opacity-50">No notes provided</span>}</span>
                        <button onClick={() => startEditingNote(task)} className="text-slate-400 hover:text-[#12a0e1] ml-1 opacity-0 group-hover/note:opacity-100 transition-opacity"><Edit2 className="w-3.5 h-3.5" /></button>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {/* Time display */}
                    <div className="flex flex-col items-end justify-center mr-1">
                      <div className="text-xs font-mono bg-slate-50 border border-[#dce4ec] px-2 py-1 rounded text-[#768994]">
                        Base: {formatTimerDisplay(task.rawSeconds)}
                      </div>
                      {task.additionalSeconds > 0 && (
                        <div className="text-[10px] font-mono text-[#1cc1a5] mt-1 pr-1 font-bold">
                          + Add: {formatTimerDisplay(task.additionalSeconds)}
                        </div>
                      )}
                    </div>

                    {/* Inline additional time input */}
                    {addingTimeId === task.id ? (
                      <div className="flex items-center gap-1 bg-[#1cc1a5]/10 border border-[#1cc1a5]/30 rounded-xl px-2 py-1">
                        <input
                          autoFocus
                          type="number" min="0" max="23" placeholder="h"
                          value={addH} onChange={(e) => setAddH(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") commitAddTime(task); if (e.key === "Escape") closeAddTime(); }}
                          className="w-8 text-center text-xs font-mono bg-transparent outline-none text-[#122027]"
                        />
                        <span className="text-[#1cc1a5] font-bold text-xs">h</span>
                        <input
                          type="number" min="0" max="59" placeholder="m"
                          value={addM} onChange={(e) => setAddM(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") commitAddTime(task); if (e.key === "Escape") closeAddTime(); }}
                          className="w-8 text-center text-xs font-mono bg-transparent outline-none text-[#122027]"
                        />
                        <span className="text-[#1cc1a5] font-bold text-xs">m</span>
                        <button onClick={() => commitAddTime(task)} className="p-0.5 text-[#1cc1a5] hover:text-[#15a38b] transition-colors"><Check className="w-3.5 h-3.5" /></button>
                        <button onClick={closeAddTime} className="p-0.5 text-[#768994] hover:text-rose-400 transition-colors"><X className="w-3.5 h-3.5" /></button>
                      </div>
                    ) : (
                      <button onClick={() => openAddTime(task.id)} className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold text-[#768994] hover:text-[#1cc1a5] hover:bg-[#1cc1a5]/10 rounded-lg transition-colors opacity-40 group-hover/row:opacity-100 focus-visible:opacity-100" title="Add Additional Time">
                        <Plus className="w-3 h-3" /> Add time
                      </button>
                    )}

                    <button onClick={() => startEditingTime(task)} className="p-2 text-[#768994] hover:text-emerald-600 hover:bg-emerald-100 transition-colors rounded-xl mx-0.5 opacity-40 group-hover/row:opacity-100 focus-visible:opacity-100" title="Edit Logged Time"><Clock className="w-4 h-4" /></button>
                    <button onClick={() => startTaskEdit(task)} className="p-2 text-[#768994] hover:text-indigo-600 hover:bg-indigo-100 transition-colors rounded-xl mx-0.5 opacity-40 group-hover/row:opacity-100 focus-visible:opacity-100" title="Reassign / Move Task"><FolderInput className="w-4 h-4" /></button>
                    <button onClick={() => setItemToDelete({ type: "single", ids: [task.id] })} className="p-2 text-[#768994] hover:text-rose-600 hover:bg-rose-100 transition-colors rounded-xl mx-0.5 opacity-40 group-hover/row:opacity-100 focus-visible:opacity-100" title="Delete Subtask"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>

                {/* Time editor */}
                {editingTimeId === task.id && (
                  <div className="bg-emerald-50/50 px-5 py-4 border-t border-[#dce4ec] space-y-3 relative z-30 shadow-inner">
                    <div className="text-xs font-bold text-emerald-900/60 uppercase tracking-wider mb-3">Edit Logged Time:</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {[
                        { label: "Base Time", fields: [["rawHours","Hr"], ["rawMins","Min"], ["rawSecs","Sec"]] },
                        { label: "Additional Time", fields: [["addHours","Hr"], ["addMins","Min"], ["addSecs","Sec"]] },
                      ].map(({ label, fields }) => (
                        <div key={label}>
                          <label className="text-[10px] font-black text-[#768994] uppercase tracking-widest flex items-center gap-1.5 mb-1.5">{label}</label>
                          <div className="flex gap-2">
                            {fields.map(([key, ph], i) => (
                              <React.Fragment key={key}>
                                {i > 0 && <span className="text-[#dce4ec] font-black mt-1">:</span>}
                                <input type="number" min="0" max={i > 0 ? 59 : undefined}
                                  value={editTimeForm[key]}
                                  onChange={(e) => setEditTimeForm({ ...editTimeForm, [key]: e.target.value })}
                                  className="w-full bg-white border border-[#dce4ec] rounded-lg px-2 py-1.5 text-sm focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 outline-none transition-[border-color,box-shadow] text-center font-mono"
                                  placeholder={ph}
                                />
                              </React.Fragment>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="flex justify-end gap-2 pt-3 mt-2 border-t border-emerald-500/10">
                      <button onClick={() => setEditingTimeId(null)} className="px-4 py-2 text-xs font-bold text-[#768994] hover:bg-white rounded-lg transition-colors">Cancel</button>
                      <button onClick={() => saveEditedTime(task.id)} className="px-4 py-2 text-xs font-bold bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg shadow-sm shadow-emerald-500/20 transition-colors flex items-center gap-1.5">
                        <Save className="w-3.5 h-3.5" /> Save Time
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
          ))}
          </div>
        </div>
      ))}
    </div>
  );
}

