import React, { useRef } from "react";
import { FileSpreadsheet, Plus, X } from "lucide-react";
import { loadedAgo } from "./format";

// The loaded order forms as a row of chips: pick one, remove one, add another.
// Each says when it was loaded, because a file is a snapshot of the sheet.
export default function FileSwitcher({ files, selectedId, onSelect, onRemove, onFile, busy }) {
  const inputRef = useRef(null);

  return (
    <div className="flex flex-wrap items-stretch gap-2">
      {files.map((file) => {
        const active = file.id === selectedId;
        return (
          <div
            key={file.id}
            className={`group flex items-center rounded-xl border transition-colors ${
              active ? "bg-[#122027] border-[#122027] text-white" : "bg-white border-[#dce4ec] text-[#122027] hover:border-[#12a0e1]"
            }`}
          >
            <button onClick={() => onSelect(file.id)} className="flex items-center gap-2.5 pl-3 pr-2 py-2 text-left min-w-0">
              <FileSpreadsheet className={`w-4 h-4 shrink-0 ${active ? "text-white/70" : "text-[#768994]"}`} />
              <span className="min-w-0">
                <span className="block text-sm font-bold truncate max-w-[260px]">{file.name.replace(/\.xlsx$/i, "")}</span>
                <span className={`block text-[11px] ${active ? "text-white/60" : "text-[#768994]"}`}>
                  {file.kind === "print" ? "Print" : "Motion"} · {file.source ? "from Google" : "dropped file"} · {loadedAgo(file.loadedAt)}
                </span>
              </span>
            </button>
            <button
              onClick={() => onRemove(file)}
              aria-label={`Remove ${file.name}`}
              className={`mr-1.5 p-1 rounded-lg transition-colors ${active ? "text-white/60 hover:text-white hover:bg-white/15" : "text-[#9aabb5] hover:text-rose-600 hover:bg-rose-50"}`}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}

      <input
        ref={inputRef}
        type="file"
        accept=".xlsx"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) onFile(file);
        }}
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="flex items-center gap-1.5 px-3.5 rounded-xl border border-dashed border-[#c5d2dc] text-sm font-bold text-[#768994] hover:border-[#12a0e1] hover:text-[#12a0e1] transition-colors disabled:opacity-50 min-h-[52px]"
      >
        <Plus className="w-4 h-4" />
        Add file
      </button>
    </div>
  );
}
