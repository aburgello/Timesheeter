import { useCallback, useEffect, useState } from "react";
import { CalendarDays, Check, Plus, RefreshCw, X } from "lucide-react";
import { calendarConnected, connectCalendar, fetchEventsForDay } from "../../lib/googleCalendar";
import { pickMeetings } from "../../lib/calendarEvents";

// One day of your Google Calendar, as "Where did my day go?" would read it:
// the meetings it counts, and what it leaves out and why. A meeting can be put
// on the timeline's "Something else" lane from here, as a mark to give a job
// to. Nothing goes on the timesheets from this window, and nothing is ever
// written to the calendar.

const clock = (minute) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const length = (minutes) => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;

const MESSAGES = {
  "not-configured": "Google sign-in isn't set up for this site.",
  offline: "Couldn't reach Google. Check your connection and try again.",
  denied: "Google didn't grant access to your calendar.",
  cancelled: "The Google sign-in window was closed before it finished.",
  popup: "The Google sign-in window was blocked. Allow popups for this site and try again.",
  "signed-out": "Your Google sign-in has lapsed. Connect again.",
  "no-access": "Google refused the request. The Calendar API may not be enabled for this app yet.",
  failed: "Google returned an error reading your calendar.",
};

export default function CalendarEventsModal({ day, onClose, canAdd, addedIds, onAdd }) {
  const [connected, setConnected] = useState(calendarConnected);
  // { status: "idle" | "loading" | "ready" | "error", meetings, leftOut, error }
  const [state, setState] = useState({ status: "idle" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", ...pickMeetings(await fetchEventsForDay(day.date), day.date) });
    } catch (err) {
      if (err.reason === "signed-out") setConnected(false);
      setState({ status: "error", error: MESSAGES[err.reason] || MESSAGES.failed });
    }
  }, [day]);

  useEffect(() => {
    if (connected) load();
  }, [connected, load]);

  // Captured, so Escape closes this and not the screen underneath as well.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const connect = async () => {
    setState({ status: "loading" });
    try {
      await connectCalendar();
      setConnected(true);
    } catch (err) {
      setState({ status: "error", error: MESSAGES[err.reason] || MESSAGES.failed });
    }
  };

  const total = state.status === "ready" ? state.meetings.reduce((sum, m) => sum + (m.to - m.from), 0) : 0;
  const toAdd = state.status === "ready" ? state.meetings.filter((m) => !addedIds.has(m.id) && m.to > m.from) : [];

  return (
    <div
      className="fixed inset-0 z-[100003] flex items-center justify-center p-4"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="calendar-events-title"
        className="relative w-full max-w-lg bg-gradient-to-b from-[#1c2333] to-[#141b28] border border-white/10 rounded-2xl shadow-2xl flex flex-col max-h-[80vh] text-slate-300 animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent" />
        <div className="px-6 pt-5 pb-4 border-b border-white/5 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-9 h-9 shrink-0 rounded-xl bg-[#12a0e1]/15 text-[#38bdf8] flex items-center justify-center">
              <CalendarDays className="w-[18px] h-[18px]" />
            </div>
            <div className="min-w-0">
              <h2 id="calendar-events-title" className="text-base font-bold text-white">
                Your calendar, {day.name}
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Read from your Google Calendar, which is never changed.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {connected && (
              <button
                onClick={load}
                disabled={state.status === "loading"}
                aria-label="Read again"
                className="p-2 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-400 hover:text-white rounded-xl transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${state.status === "loading" ? "animate-spin" : ""}`} />
              </button>
            )}
            <button
              onClick={onClose}
              aria-label="Close"
              className="p-2 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-400 hover:text-white rounded-xl transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar">
          {state.status === "error" && <p className="px-6 pt-4 text-xs text-rose-400">{state.error}</p>}

          {!connected && state.status !== "loading" && (
            <div className="px-6 py-10 flex flex-col items-center gap-3 text-center">
              <p className="text-sm text-slate-300 max-w-sm">
                Connect your Google account to see the meetings on your calendar for {day.name}. TimeHub can only read it.
              </p>
              <button
                onClick={connect}
                className="px-4 py-2 text-xs font-bold rounded-lg bg-[#12a0e1] hover:bg-[#0d8bc4] text-white shadow-md shadow-[#12a0e1]/20"
              >
                Connect Google Calendar
              </button>
            </div>
          )}

          {state.status === "loading" && (
            <div className="py-14 flex flex-col items-center gap-3 text-sm text-slate-400">
              <RefreshCw className="w-5 h-5 animate-spin text-[#38bdf8]" />
              Reading your calendar…
            </div>
          )}

          {state.status === "ready" && (
            <>
              <div className="px-6 pt-4 pb-1 flex items-center justify-between gap-3">
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  Meetings{state.meetings.length ? ` · ${length(total)}` : ""}
                </h3>
                {canAdd && toAdd.length > 1 && (
                  <button
                    onClick={() => toAdd.forEach(onAdd)}
                    className="text-[11px] font-bold text-[#38bdf8] hover:text-[#7dd3fc]"
                  >
                    Add all {toAdd.length} to the timeline
                  </button>
                )}
              </div>
              {state.meetings.length === 0 ? (
                <p className="px-6 pb-4 text-sm text-slate-400">No meetings with other people on {day.name}.</p>
              ) : (
                <ul className="pb-2">
                  {state.meetings.map((m) => (
                    <li key={m.id} className="px-6 py-2 flex items-center gap-3 border-b border-white/5 last:border-b-0">
                      <span className="font-mono text-xs text-[#38bdf8] shrink-0">{clock(m.from)}–{clock(m.to)}</span>
                      <span className="flex-1 min-w-0 text-sm font-semibold text-white break-words">{m.title}</span>
                      <span className="font-mono text-xs text-slate-500 shrink-0">{length(m.to - m.from)}</span>
                      {addedIds.has(m.id) ? (
                        <span className="flex items-center gap-1 w-[4.5rem] justify-end text-[11px] font-bold text-emerald-400 shrink-0 animate-in fade-in zoom-in-90 duration-200">
                          <Check className="w-3 h-3" strokeWidth={3} /> Added
                        </span>
                      ) : (
                        <button
                          onClick={() => onAdd(m)}
                          disabled={!canAdd}
                          aria-label={`Add ${m.title} to the timeline`}
                          className="flex items-center gap-1 w-[4.5rem] justify-center py-1 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-[11px] font-bold text-slate-200 shrink-0 disabled:opacity-40"
                        >
                          <Plus className="w-3 h-3" /> Add
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {state.meetings.length > 0 && (
                <p className="px-6 pb-3 text-[11px] text-slate-500">
                  Added meetings appear on the "Something else" line, where you pick the job for each.
                </p>
              )}

              {state.leftOut.length > 0 && (
                <>
                  <h3 className="px-6 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500 border-t border-white/5">
                    Left out
                  </h3>
                  <ul className="pb-3">
                    {state.leftOut.map((m) => (
                      <li key={m.id} className="px-6 py-1.5 flex items-baseline gap-3 text-slate-500">
                        <span className="font-mono text-xs shrink-0 w-[5.5rem]">{m.from == null ? "All day" : `${clock(m.from)}–${clock(m.to)}`}</span>
                        <span className="flex-1 min-w-0 text-xs break-words">{m.title}</span>
                        {m.reason !== "All day" && <span className="text-[11px] shrink-0">{m.reason}</span>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
