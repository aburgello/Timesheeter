import React, { useEffect } from "react";
import { StickyNote, X, ExternalLink } from "lucide-react";
import { NotesCanvasCard } from "../Canvas";

// ── Quick-access Notes modal ─────────────────────────────────────────────────
// Pops the real Notes Canvas over whatever page you're on, so a note can be
// read or edited without leaving your current context. It renders the SAME
// NotesCanvasCard the Canvas page uses (in `bare` mode — no CollapsibleCard
// chrome), so there's one source of truth for notes: folders, boards, collab
// and sketches are all identical to the full page, not a parallel lite copy.
//
// z-index sits at 120 deliberately: above the Rail (40) and the QuickActions
// bubble (100) so it takes the foreground, but BELOW the note editor's own
// floating menus (bubble/slash/drag, which portal to <body> at 139–150) so
// those stay usable inside the modal instead of being trapped under it.
export default function NotesModal({ department, onClose, onOpenFull }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[120] flex items-stretch justify-center p-3 sm:p-6 bg-[#122027]/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl border border-[#dce4ec] w-full max-w-[1120px] max-h-[92vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Slim neutral header — the card body carries its own board accent, so
            this stays quiet rather than competing with it. */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-[#dce4ec] bg-slate-50/60 shrink-0">
          <div className="p-2 bg-[#c2410d]/10 rounded-xl">
            <StickyNote className="w-4 h-4 text-[#c2410d]" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-black uppercase tracking-widest text-[#c2410d]">Notes</p>
            <p className="text-[11px] text-slate-400 font-medium truncate">Quick access · {department}</p>
          </div>
          <div className="ml-auto flex items-center gap-2 shrink-0">
            {onOpenFull && (
              <button
                onClick={onOpenFull}
                title="Open the full Notes Canvas page (with campaigns alongside)"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-[#dce4ec] hover:border-[#c2410d]/40 hover:bg-[#c2410d]/5 text-[#5a5147] hover:text-[#c2410d] text-[10px] font-black uppercase tracking-widest transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5" /> Full page
              </button>
            )}
            <button
              onClick={onClose}
              title="Close (Esc)"
              className="p-1.5 rounded-xl hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body scrolls; the card sizes itself. onToggle is a no-op — there's
            no CollapsibleCard to collapse in bare mode. */}
        <div className="overflow-auto flex-1 min-h-0">
          <NotesCanvasCard bare isOpen onToggle={() => {}} department={department} />
        </div>
      </div>
    </div>
  );
}
