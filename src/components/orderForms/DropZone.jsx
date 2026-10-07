import React, { useRef } from "react";
import { FileSpreadsheet, Loader2, Upload } from "lucide-react";

// The page's empty state: where the first order form goes in. Dragging is
// handled by the page (the whole page is the target); this is what it looks
// like when nothing is loaded, plus the file picker for anyone who doesn't drag.
export default function DropZone({ onFile, busy, dragging, error }) {
  const inputRef = useRef(null);

  return (
    <div
      className={`flex flex-col items-center justify-center text-center rounded-2xl border-2 border-dashed px-6 py-20 transition-colors duration-200 ${
        dragging ? "border-[#12a0e1] bg-[#12a0e1]/5" : "border-[#c5d2dc] bg-white"
      }`}
    >
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-600 to-sky-600 text-white flex items-center justify-center mb-5">
        {busy ? <Loader2 className="w-7 h-7 animate-spin" /> : <FileSpreadsheet className="w-7 h-7" strokeWidth={1.75} />}
      </div>
      <h2 className="font-display text-2xl font-bold tracking-tight text-[#122027]">
        {busy ? "Reading the order form…" : dragging ? "Drop it here" : "Drop an order form"}
      </h2>
      <p className="text-sm text-[#768994] mt-2 max-w-md">
        In Google Sheets, choose File, Download, Microsoft Excel (.xlsx), then drop the file here.
        It stays in this browser and isn't uploaded anywhere.
      </p>

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
        className="mt-6 flex items-center gap-2 px-5 py-2.5 bg-[#122027] hover:bg-[#25373c] text-white text-sm font-bold rounded-xl transition-colors disabled:opacity-50"
      >
        <Upload className="w-4 h-4" />
        Choose file
      </button>

      {error && <p role="alert" className="mt-5 text-sm font-medium text-rose-600">{error}</p>}
    </div>
  );
}
