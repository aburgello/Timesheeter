import React from "react";
import { X, FileSpreadsheet, Monitor, Ruler, Clock, Volume2, HardDrive, Zap, Film, Download } from "lucide-react";

const COL_META = [
  { key: "mediaSiteName", label: "Media Site",                      icon: Monitor },
  { key: "pixelWidth",    label: "Pixel Width",                     icon: Ruler },
  { key: "pixelHeight",   label: "Pixel Height",                    icon: Ruler },
  { key: "duration",      label: "Duration",                        icon: Clock },
  { key: "soundReq",      label: "Sound Req.",                      icon: Volume2 },
  { key: "fileSize",      label: "File Size",                       icon: HardDrive },
  { key: "bitRate",       label: "Bit Rate",                        icon: Zap },
  { key: "specificVideo", label: "Specific Video Req. (if not MOV)", icon: Film },
];

// Only show columns that have at least one non-empty value in the data
function activeColumns(rows) {
  return COL_META.filter((col) => rows.some((r) => r[col.key]?.trim()));
}

export default function DeliverySpecsModal({ specs, pdfName, onClose, onExportCsv }) {
  if (!specs) return null;

  const cols = activeColumns(specs);

  return (
    <div
      className="fixed inset-0 z-[10001] flex items-center justify-center p-4 bg-[#122027]/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl border border-[#dce4ec] w-full max-w-[95vw] max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-[#dce4ec] bg-slate-50/60 shrink-0">
          <div className="p-2 bg-[#12a0e1]/10 rounded-xl">
            <FileSpreadsheet className="w-4 h-4 text-[#12a0e1]" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-black uppercase tracking-widest text-[#12a0e1]">Delivery Checklist</p>
            <p className="text-[11px] text-slate-400 font-medium truncate">{pdfName}</p>
          </div>
          <div className="ml-auto flex items-center gap-3 shrink-0">
            <span className="text-[10px] font-bold text-slate-400">
              {specs.length} {specs.length === 1 ? "format" : "formats"}
            </span>
            {onExportCsv && (
              <button
                onClick={onExportCsv}
                title="Reshape into a batch-delivery CSV (Artwork/Campaign/Size/Duration/Country) — same export the task modal's attachments use"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-[10px] font-black uppercase tracking-widest transition-colors shadow-sm"
              >
                <Download className="w-3.5 h-3.5" /> Export CSV
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 rounded-xl hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-auto flex-1 min-h-0">
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="sticky top-0 bg-slate-50 z-10">
                {cols.map((col) => {
                  const Icon = col.icon;
                  return (
                    <th
                      key={col.key}
                      className="px-3 py-2.5 text-left font-black uppercase tracking-widest text-[9px] text-slate-400 border-b border-[#dce4ec] whitespace-nowrap"
                    >
                      <div className="flex items-center gap-1.5">
                        {Icon && <Icon className="w-3 h-3 text-slate-300 shrink-0" />}
                        {col.label}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {specs.map((row, i) => (
                <tr
                  key={i}
                  className={`border-b border-[#dce4ec]/60 transition-colors hover:bg-[#12a0e1]/5 ${
                    i % 2 === 0 ? "bg-white" : "bg-slate-50/40"
                  }`}
                >
                  {cols.map((col) => (
                    <td
                      key={col.key}
                      className={`px-3 py-2 text-[#122027] align-top ${
                        col.key === "mediaSiteName" ? "font-bold whitespace-nowrap" : "text-slate-600"
                      }`}
                    >
                      {row[col.key] || <span className="text-slate-300">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
