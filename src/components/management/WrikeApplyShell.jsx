// The frame every screen that writes to Wrike uses: show what
// would change first, write only after Apply, plus its checklist rows.
//
// Part of Administration. Split out of components/Management.jsx, which is
// still the entry point and re-exports what other screens import.
import { X, AlertTriangle, CheckCircle2 } from "lucide-react";

// ── Shared shell for the Wrike dry-run / apply modals ─────────────────────────
// Both Wrike-writing flows (film sync, push+propagate) follow the same shape:
// run a read-only plan on open, show what WOULD change, then write only on an
// explicit "Apply" click. This shell provides the frame; each flow supplies the
// preview body and the apply handler.
export function WrikeApplyShell({ title, subtitle, accent = "#12a0e1", onClose, children }) {
  return (
    <div className="fixed inset-0 z-[9999] bg-[#122027]/60 backdrop-blur-sm flex items-center justify-center p-4"
      onMouseDown={onClose}>
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg max-h-[92vh] flex flex-col overflow-hidden border border-[#dce4ec]"
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="px-6 pt-5 pb-4 border-b border-[#dce4ec] flex items-center justify-between shrink-0">
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest mb-0.5" style={{ color: accent }}>Wrike · dry run</p>
            <h2 className="text-xl font-black text-[#122027]">{title}</h2>
            {subtitle && <p className="text-xs text-[#768994] mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-xl text-slate-400 hover:text-slate-600 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
// Small ✓/✗ precondition row for the push preview.
export function CheckRow({ ok, label, value, warn }) {
  const Icon = ok ? CheckCircle2 : warn ? AlertTriangle : X;
  const color = ok ? "#1cc1a5" : warn ? "#f4b740" : "#f43f5e";
  return (
    <div className="flex items-start gap-2 py-1.5">
      <Icon className="w-4 h-4 shrink-0 mt-0.5" style={{ color }} />
      <div className="min-w-0">
        <p className="text-xs font-bold text-[#122027]">{label}</p>
        {value && <p className="text-[11px] text-[#768994] truncate">{value}</p>}
      </div>
    </div>
  );
}
