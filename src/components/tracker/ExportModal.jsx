import React from "react";
import { X, Play, Copy, Check, Upload, FileSpreadsheet } from "lucide-react";
import PasteNextSteps from "../shared/PasteNextSteps";

function formatSeconds(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function handleExportCSV(tasks) {
  if (!tasks || tasks.length === 0) return;

  const headers = ["Day", "Date", "Job", "Territory", "Category", "Time", "Notes"];
  const rows = tasks.map((t) => [
    t.dayOfWeek ?? "",
    t.date ?? "",
    t.jobNumber ?? "",
    t.territory ?? "",
    t.category ?? "",
    formatSeconds((t.rawSeconds ?? 0) + (t.additionalSeconds ?? 0)),
    (t.notes ?? "").replace(/"/g, '""'),
  ]);

  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${cell}"`).join(","))
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `Timesheet_${new Date().toISOString().split("T")[0]}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default function ExportModal({
  showExportModal, setShowExportModal,
  jsonCopied, pastedJson, setPastedJson,
  handleCopyJSONToClipboard, handlePasteImport,
  tasks,
}) {
  if (!showExportModal) return null;

  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center p-4 bg-[#122027]/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white rounded-3xl max-w-xl w-full p-8 shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex justify-between items-start mb-6">
          <div>
            <h3 className="text-2xl font-black text-[#122027] tracking-tight">Manage Data</h3>
            <p className="text-[#768994] text-sm mt-1">Export for automation or merge JSON backups</p>
          </div>
          <button
            onClick={() => setShowExportModal(false)}
            className="p-2 bg-slate-100 hover:bg-[#dce4ec] text-[#768994] rounded-full transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-6 overflow-y-auto pr-2 pb-2">
          {/* Unlike the Legacy button, the steps sit here permanently rather
              than appearing on copy: this panel is somewhere you go on purpose,
              with room to read, so it can answer "how does this work?" before
              the click as well as "what now?" after it. */}
          <div className="bg-[#12a0e1]/5 p-5 rounded-2xl border border-[#12a0e1]/20">
            <h4 className="text-sm font-bold text-[#122027] mb-1 flex items-center gap-2">
              <Play className="w-4 h-4 text-[#12a0e1]" /> Send this week to your timesheet
            </h4>
            <p className="text-xs text-[#323b43] mb-4 leading-relaxed">
              Copy your week here, then paste it into the bookmark you saved in
              your browser's favourites. It fills the rows in for you.
            </p>
            <PasteNextSteps />
            <button
              onClick={handleCopyJSONToClipboard}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 mt-4 text-white rounded-xl font-bold transition-[background-color,box-shadow,transform] shadow-lg w-full ${
                jsonCopied
                  ? "bg-[#1cc1a5] shadow-[#1cc1a5]/30"
                  : "bg-[#12a0e1] hover:bg-[#12a0e1]/90 shadow-[#12a0e1]/30 active:scale-[0.98]"
              }`}
            >
              {jsonCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {jsonCopied ? "Copied! Now go and paste it" : "Copy Me!"}
            </button>
          </div>

          <div className="bg-emerald-50 p-5 rounded-2xl border border-emerald-200">
            <h4 className="text-sm font-bold text-[#122027] mb-2 flex items-center gap-2">
              <FileSpreadsheet className="w-4 h-4 text-emerald-600" /> CSV Export
            </h4>
            <p className="text-xs text-[#323b43] mb-4 leading-relaxed">
              Download all logged tasks as a CSV file, ready to open in Excel or Google Sheets.
            </p>
            <button
              onClick={() => handleExportCSV(tasks)}
              disabled={!tasks || tasks.length === 0}
              className="flex items-center justify-center gap-2 px-4 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold transition-[background-color,transform] shadow-lg shadow-emerald-600/20 active:scale-[0.98] w-full disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <FileSpreadsheet className="w-4 h-4" />
              Download CSV
            </button>
          </div>

          <div className="space-y-3">
            <h4 className="text-sm font-bold text-[#122027]">Manual JSON Merge</h4>
            <textarea
              value={pastedJson}
              onChange={(e) => setPastedJson(e.target.value)}
              placeholder='Paste a previous {"tasks": [...]} export here to merge it...'
              className="w-full h-32 bg-slate-50 border border-[#dce4ec] rounded-xl p-3 text-xs font-mono text-[#323b43] focus:ring-2 focus:ring-[#12a0e1]/20 focus:border-[#12a0e1] outline-none resize-none transition-[border-color,box-shadow]"
            />
            <button
              onClick={handlePasteImport}
              disabled={!pastedJson.trim()}
              className="w-full flex items-center justify-center gap-2 py-2.5 bg-[#122027] hover:bg-[#25373c] text-white rounded-xl text-sm font-bold disabled:opacity-50 transition-colors"
            >
              <Upload className="w-4 h-4" /> Merge Pasted JSON
            </button>
          </div>
        </div>

        <div className="flex justify-end pt-6 mt-auto border-t border-[#dce4ec]">
          <button
            onClick={() => setShowExportModal(false)}
            className="px-6 py-2.5 bg-slate-100 hover:bg-[#dce4ec] text-[#122027] font-bold rounded-xl transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
