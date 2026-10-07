// Feedback: the "Report a problem" messages people send from the
// timesheet page, newest first, with a way to mark each one done.
//
// Part of Administration (components/Management.jsx is the entry point).
import { useState, useEffect, useCallback } from "react";
import { Check, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { confirmAction } from "../../lib/confirm";

const when = (iso) =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function FeedbackSection() {
  // null while loading
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [showDone, setShowDone] = useState(false);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase
      .from("feedback")
      .select("*")
      .order("created_at", { ascending: false });
    if (err) {
      setError(`Couldn't load feedback (${err.message}).`);
      setItems([]);
      return;
    }
    setError("");
    setItems(data);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setResolved = async (item, done) => {
    const resolved_at = done ? new Date().toISOString() : null;
    const { error: err } = await supabase.from("feedback").update({ resolved_at }).eq("id", item.id);
    if (err) return setError(`Couldn't update it (${err.message}).`);
    setItems((list) => list.map((x) => (x.id === item.id ? { ...x, resolved_at } : x)));
  };

  const remove = async (item) => {
    const ok = await confirmAction({
      title: "Delete this report?",
      message: `From ${item.user_name || "someone"}, ${when(item.created_at)}. This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    const { error: err } = await supabase.from("feedback").delete().eq("id", item.id);
    if (err) return setError(`Couldn't delete it (${err.message}).`);
    setItems((list) => list.filter((x) => x.id !== item.id));
  };

  if (!items) {
    return (
      <div className="py-16 flex justify-center text-[#768994]">
        <RefreshCw className="w-5 h-5 animate-spin" />
      </div>
    );
  }

  const open = items.filter((x) => !x.resolved_at);
  const done = items.filter((x) => x.resolved_at);
  const shown = showDone ? items : open;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <p className="text-sm text-[#768994]">
          <b className="text-[#122027]">{open.length}</b> open
          {done.length > 0 && <>, {done.length} done</>}
        </p>
        {done.length > 0 && (
          <button
            onClick={() => setShowDone((v) => !v)}
            className="text-xs font-bold text-[#768994] hover:text-[#122027] bg-white border border-[#dce4ec] hover:border-slate-300 rounded-xl px-3 py-2 transition-colors"
          >
            {showDone ? "Hide done" : "Show done"}
          </button>
        )}
      </div>

      {error && (
        <p className="mb-4 text-xs font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</p>
      )}

      {shown.length === 0 ? (
        <p className="py-12 text-center text-sm text-[#768994]">
          {items.length === 0 ? "Nothing has been reported yet." : "Nothing open. Everything reported has been dealt with."}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {shown.map((item) => (
            <li
              key={item.id}
              className={`border border-[#dce4ec] rounded-2xl px-4 py-3 flex flex-wrap items-start gap-x-4 gap-y-2 ${
                item.resolved_at ? "bg-slate-50 opacity-70" : "bg-white"
              }`}
            >
              <div className="min-w-0 flex-1 basis-64">
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-[#768994]">
                  <span className="font-bold text-[#122027]">{item.user_name || item.wrike_user_id}</span>
                  <span>{when(item.created_at)}</span>
                  {item.page && <span>from {item.page}</span>}
                  {item.resolved_at && <span className="font-bold text-emerald-600">Done {when(item.resolved_at)}</span>}
                </div>
                <p className="mt-1.5 text-sm text-[#122027] whitespace-pre-wrap break-words">{item.message}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => setResolved(item, !item.resolved_at)}
                  className="flex items-center gap-1.5 text-xs font-bold text-[#122027] bg-white border border-[#dce4ec] hover:border-slate-300 rounded-xl px-3 py-2 transition-colors"
                >
                  {item.resolved_at ? <RotateCcw className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
                  {item.resolved_at ? "Reopen" : "Mark done"}
                </button>
                <button
                  onClick={() => remove(item)}
                  aria-label="Delete report"
                  title="Delete"
                  className="p-2 text-[#768994] hover:text-rose-600 bg-white border border-[#dce4ec] hover:border-rose-200 rounded-xl transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
