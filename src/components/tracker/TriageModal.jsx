import React from "react";
import { Tag, Film, Globe } from "lucide-react";
import SearchableSelect from "../shared/SearchableSelect";
import { CATEGORIES } from "../../constants";

export default function TriageModal({
  triageQueue, setTriageQueue,
  triageCategory, setTriageCategory,
  setTasks, updateTasks, triggerToast,
}) {
  if (triageQueue.length === 0) return null;

  const current = triageQueue[0];

  const handleSkip = () => {
    setTriageQueue((prev) => prev.slice(1));
    setTriageCategory("");
  };

  const handleSave = () => {
    if (!triageCategory) {
      triggerToast("Please select a category or hit Skip.");
      return;
    }
    setTasks((prev) =>
      prev.map((t) =>
        current.taskIds.includes(t.id) ? { ...t, category: triageCategory } : t
      )
    );
    updateTasks(current.taskIds, { category: triageCategory });
    setTriageQueue((prev) => prev.slice(1));
    setTriageCategory("");
    triggerToast("Category assigned!", "success");
  };

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-[#122027]/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl space-y-5">
        <div className="flex items-center gap-3 border-b border-[#dce4ec] pb-4">
          <div className="bg-amber-100 p-2.5 rounded-xl text-amber-600">
            <Tag className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-xl font-black text-[#122027]">Missing Category</h3>
            <p className="text-[#768994] text-xs font-medium">
              Please assign a category for this pulled task
            </p>
          </div>
        </div>

        <div className="bg-slate-50 p-4 rounded-2xl border border-[#dce4ec] shadow-inner space-y-2">
          <div className="text-sm font-bold text-[#122027] flex items-center gap-2">
            <Film className="w-4 h-4 text-[#12a0e1]" /> {current.jobNumber}
          </div>
          <div className="text-xs text-[#768994] flex items-center gap-2">
            <Globe className="w-4 h-4 text-[#1cc1a5]" /> {current.territory}
          </div>
          <div className="text-xs italic text-slate-500 mt-2 truncate opacity-70">
            "{current.sampleTitle}"
          </div>
        </div>

        <div className="relative z-50">
          <SearchableSelect
            options={CATEGORIES}
            value={triageCategory}
            onChange={setTriageCategory}
            placeholder="Select Category..."
            icon={Tag}
            isGrouped={true}
          />
        </div>

        <div className="flex justify-end pt-4 border-t border-[#dce4ec]">
          <button
            onClick={handleSkip}
            className="px-4 py-2 text-sm font-bold text-[#768994] hover:bg-slate-100 rounded-xl transition-colors mr-2"
          >
            Skip
          </button>
          <button
            onClick={handleSave}
            className="px-6 py-2.5 text-sm font-black text-white bg-[#12a0e1] hover:bg-[#0f88c0] rounded-xl shadow-md transition-[background-color,transform] active:scale-95"
          >
            {triageQueue.length > 1 ? "Save & Next" : "Save & Close"}
          </button>
        </div>
      </div>
    </div>
  );
}
