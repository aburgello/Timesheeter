import { useEffect, useRef, useState } from "react";
import { RefreshCw, ChevronDown } from "lucide-react";

// "Pull Wrike Times", and for people granted it, a caret that pulls one chosen
// date instead of today and yesterday. The panel opens upward: this lives in
// the timesheet's bottom action bar.
export default function PullTimesButton({ isPulling, disabled, canPickDate, onPull }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().split("T")[0];
  });
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const tone = disabled
    ? "bg-slate-100 text-[#768994] border-[#dce4ec] cursor-not-allowed opacity-70"
    : "bg-white hover:bg-slate-50 text-[#122027] border-[#dce4ec] active:scale-95";

  return (
    <div ref={wrapRef} className="relative flex shadow-sm rounded-xl">
      <button
        onClick={() => onPull()}
        disabled={isPulling || disabled}
        title="Pulls your Wrike time for today and yesterday"
        className={`flex items-center gap-2 px-5 py-2.5 text-sm font-bold border transition-[background-color,color,border-color,transform] ${
          canPickDate ? "rounded-l-xl" : "rounded-xl"
        } ${tone}`}
      >
        <RefreshCw className={`w-4 h-4 ${isPulling ? "animate-spin text-[#12a0e1]" : ""}`} />
        {isPulling ? "Pulling..." : "Pull Wrike Times"}
      </button>
      {canPickDate && (
        <button
          onClick={() => setOpen((v) => !v)}
          disabled={isPulling}
          aria-expanded={open}
          aria-label="Pull a specific date"
          title="Pull a specific date"
          className="flex items-center px-2.5 -ml-px border rounded-r-xl bg-white hover:bg-slate-50 text-[#122027] border-[#dce4ec] disabled:opacity-60 transition-colors"
        >
          <ChevronDown className={`w-4 h-4 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      )}

      {/* z-[60] for the same reason as PasteNextSteps: the table's time cells
          are z-50. */}
      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-64 bg-white border border-[#dce4ec] rounded-2xl shadow-2xl p-4 z-[60] animate-in fade-in slide-in-from-bottom-1 duration-200">
          <p className="text-xs font-bold text-[#122027]">Pull a specific date</p>
          <p className="text-[11px] text-[#768994] mt-0.5">Your Wrike timelogs for that one day.</p>
          <div className="mt-3 flex items-center gap-2">
            <input
              type="date"
              value={date}
              max={new Date().toISOString().split("T")[0]}
              onChange={(e) => setDate(e.target.value)}
              aria-label="Date to pull"
              className="flex-1 min-w-0 text-xs font-mono text-[#122027] bg-slate-50 border border-[#dce4ec] focus:border-[#12a0e1] outline-none rounded-lg px-2 py-2"
            />
            <button
              onClick={() => {
                onPull(date);
                setOpen(false);
              }}
              disabled={isPulling || !date}
              className="px-3 py-2 text-xs font-bold rounded-lg bg-[#12a0e1] hover:bg-[#0d8bc4] text-white disabled:opacity-40 transition-colors"
            >
              Pull
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
