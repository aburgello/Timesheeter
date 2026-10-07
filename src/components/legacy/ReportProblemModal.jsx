import { useEffect, useRef, useState } from "react";
import { X, MessageSquareWarning, RefreshCw } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";

// "Report a problem": a note to the TimeHub administrators, saved to the
// feedback table with the sender's name and the page it came from. Read in
// Administration › Feedback.

const MAX_LENGTH = 4000;

export default function ReportProblemModal({ wrikeUserId, userName, page, onClose, onSent }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const boxRef = useRef(null);

  useEffect(() => {
    boxRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const text = message.trim();

  const send = async () => {
    if (!text || busy) return;
    setBusy(true);
    setError("");
    const { error: err } = await supabase.from("feedback").insert({
      wrike_user_id: wrikeUserId,
      user_name: userName || null,
      page,
      message: text,
    });
    setBusy(false);
    if (err) {
      console.error("[report a problem]", err);
      setError(`Couldn't send it (${err.message}). Your message is still here, so try again.`);
      return;
    }
    onSent?.();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[100001] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-problem-title"
        className="relative w-full max-w-lg bg-gradient-to-b from-[#1c2333] to-[#141b28] border border-white/10 rounded-2xl shadow-2xl flex flex-col text-slate-300 animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent" />

        <div className="px-6 pt-5 pb-4 border-b border-white/5 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-9 h-9 shrink-0 rounded-xl bg-[#12a0e1]/15 text-[#38bdf8] flex items-center justify-center">
              <MessageSquareWarning className="w-[18px] h-[18px]" />
            </div>
            <div className="min-w-0">
              <h2 id="report-problem-title" className="text-base font-bold text-white">
                Report a problem
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Something wrong, confusing or missing?
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-2 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-400 hover:text-white rounded-xl transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-4">
          <textarea
            ref={boxRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
            }}
            maxLength={MAX_LENGTH}
            rows={6}
            aria-label="What went wrong"
            placeholder="What happened, and what did you expect instead?"
            className="w-full resize-y rounded-xl bg-black/20 border border-white/10 focus:border-[#12a0e1] focus:ring-2 focus:ring-[#12a0e1]/20 outline-none px-3 py-2.5 text-sm text-white placeholder:text-slate-500 custom-scrollbar"
          />
          {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
        </div>

        <div className="px-6 py-3.5 border-t border-white/5 bg-black/20 rounded-b-2xl flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-bold rounded-lg text-slate-400 hover:text-white border border-white/10 hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            onClick={send}
            disabled={!text || busy}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold rounded-lg bg-[#12a0e1] hover:bg-[#0d8bc4] text-white shadow-md shadow-[#12a0e1]/20 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-[#12a0e1]"
          >
            {busy && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
