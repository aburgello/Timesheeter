import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  X,
  MessagesSquare,
  RefreshCw,
  Minus,
  Plus,
  Lock,
  ChevronRight,
  CheckCircle,
  AlertCircle,
} from "lucide-react";
import { fetchMyCommentsForDay } from "../../lib/wrikeComments";
import {
  estimateCommentTime,
  roundToQuarterHours,
  hoursLoggedFor,
  localMinuteOf,
} from "../../utils/commentActivity";
import { hmToHours, getCurrentWeekStart } from "../../hooks/useLegacyRows";
import { secondsToHM } from "../../utils/timeHelpers";
import { isoToday, toIsoDate } from "../../utils/dates";

// "What did I work on?" — suggests Legacy rows from the comments you posted in
// Wrike that day. See utils/commentActivity.js for how comments become time.
//
// Reads only. Nothing is written — not a row, not a Job Book entry — until
// "Add rows" is pressed, and then only through the parent's onAddRows, which
// is the same addRows path Wrike Pull uses.

const METHOD_KEY = "xyi_comment_trail_method";
const LANE_COLOURS = ["#38bdf8", "#f59e0b", "#a78bfa", "#34d399", "#fb7185", "#facc15", "#2dd4bf", "#f472b6"];
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const hm = (hours) => secondsToHM(hours * 3600, "0:00");
const clock = (minute) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

// Monday of this week through today — the days the Legacy grid can hold.
function daysSoFar() {
  const [y, m, d] = getCurrentWeekStart().split("-").map(Number);
  const today = isoToday();
  const out = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(y, m - 1, d + i);
    const iso = isoToday(date);
    if (iso > today) break;
    out.push({ name: WEEKDAYS[i], date, iso });
  }
  return out;
}

const METHODS = {
  lead: {
    label: "Since last comment",
    help: "Each comment covers the time since your previous one on any task, up to 90 min. The first of the day counts back to 09:30. Best if you comment when you finish something.",
  },
  span: {
    label: "First to last",
    help: "From your first to your last comment on a task, plus 20 min before the first. A gap of more than 75 min counts as a separate stretch. Best if you comment when you start and when you finish.",
  },
};

export default function CommentTrailModal({
  onClose,
  wrikeUserId,
  rows,
  frozenDays,
  initialDay,
  resolveTasks,
  rowFieldsFromTask,
  onAddRows,
}) {
  const days = useMemo(daysSoFar, []);
  const [dayIso, setDayIso] = useState(
    () => (days.find((d) => d.name === initialDay) || days[days.length - 1]).iso
  );
  const day = days.find((d) => d.iso === dayIso);

  const [method, setMethod] = useState(() => {
    try {
      const m = localStorage.getItem(METHOD_KEY);
      if (METHODS[m]) return m;
    } catch {}
    return "lead";
  });
  useEffect(() => {
    try {
      localStorage.setItem(METHOD_KEY, method);
    } catch {}
  }, [method]);

  // Per day: { status: "loading"|"ready"|"error", comments, tasks, truncated, error }
  const [byDay, setByDay] = useState({});
  // Per "iso:taskId": what the member changed — { on, hours, notes }.
  const [edits, setEdits] = useState({});
  const [added, setAdded] = useState(null);

  const load = useCallback(
    async (d) => {
      setByDay((p) => ({ ...p, [d.iso]: { status: "loading" } }));
      try {
        const { comments, truncated } = await fetchMyCommentsForDay(d.date, wrikeUserId);
        const taskIds = [...new Set(comments.map((c) => c.taskId).filter(Boolean))];
        const tasks = taskIds.length ? await resolveTasks(taskIds) : [];
        setByDay((p) => ({
          ...p,
          [d.iso]: { status: "ready", comments, truncated, tasks: new Map(tasks.map((t) => [t.id, t])) },
        }));
      } catch (err) {
        console.error("[comment trail]", err);
        setByDay((p) => ({
          ...p,
          [d.iso]: {
            status: "error",
            error:
              err.status === 401
                ? "Your Wrike connection has expired. Reconnect Wrike in Profile → Settings, then try again."
                : `Couldn't read your Wrike comments (${err.message}).`,
          },
        }));
      }
    },
    [wrikeUserId, resolveTasks]
  );

  useEffect(() => {
    if (day && !byDay[day.iso]) load(day);
  }, [day, byDay, load]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const state = byDay[dayIso];
  const isFrozen = !!frozenDays?.[day?.name];

  // Everything the screen shows for the selected day, derived fresh each
  // render so a row added (or deleted in the grid behind) is reflected at once.
  const view = useMemo(() => {
    if (state?.status !== "ready") return null;
    const taskComments = state.comments.filter((c) => c.taskId);
    const { byTask, blocks } = estimateCommentTime(
      taskComments.map((c) => ({ taskId: c.taskId, minute: localMinuteOf(c.createdDate) })),
      method
    );
    const dayRows = (rows || []).filter(
      (r) => r.dayOfWeek === day.name && (!r.date || toIsoDate(r.date) === day.iso)
    );
    const order = [...new Set(taskComments.map((c) => c.taskId))];
    const suggestions = order.map((taskId, i) => {
      const task = state.tasks.get(taskId);
      const { guessed, client, filmTitle } = rowFieldsFromTask(task);
      const est = roundToQuarterHours(byTask[taskId]);
      const logged = hoursLoggedFor(dayRows, { taskId, jobNumber: guessed.jobNumber }, hmToHours);
      const short = est - logged.hours;
      const gap = short >= 0.125 ? roundToQuarterHours(short * 60) : 0;
      const key = `${day.iso}:${taskId}`;
      const e = edits[key] || {};
      return {
        key,
        taskId,
        task,
        colour: LANE_COLOURS[i % LANE_COLOURS.length],
        title: task?.title || "A task you can no longer open",
        fields: { guessed, client, filmTitle },
        comments: taskComments.filter((c) => c.taskId === taskId),
        est,
        logged,
        gap,
        on: gap > 0 && (e.on ?? true),
        hours: e.hours ?? (gap || est),
        notes: e.notes ?? (task?.title || ""),
      };
    });
    const loggedTotal = dayRows.reduce(
      (s, r) => s + hmToHours(r.timeSpent) + hmToHours(r.additionalTime),
      0
    );
    return {
      suggestions,
      blocks,
      taskComments,
      folderOnly: state.comments.length - taskComments.length,
      estTotal: suggestions.reduce((s, x) => s + x.est, 0),
      loggedTotal,
      missing: suggestions.filter((s) => s.gap > 0),
    };
  }, [state, method, rows, day, edits, rowFieldsFromTask]);

  const edit = (key, patch) => setEdits((p) => ({ ...p, [key]: { ...p[key], ...patch } }));

  const picked = view ? view.suggestions.filter((s) => s.on) : [];
  const pickedTotal = picked.reduce((s, x) => s + x.hours, 0);

  const handleAdd = () => {
    if (!picked.length || isFrozen) return;
    const date = day.date.toLocaleDateString("en-GB");
    const newRows = picked.map((s) => ({
      id: Date.now() + Math.floor(Math.random() * 100000),
      taskId: s.taskId,
      dayOfWeek: day.name,
      date,
      jobNumber: s.fields.guessed.jobNumber,
      client: s.fields.client,
      filmTitle: s.fields.filmTitle,
      projectDescription: s.fields.guessed.notes,
      territory: s.fields.guessed.territory,
      category: s.fields.guessed.category,
      clientAmends: false,
      notes: s.notes,
      is3D: false,
      timeSpent: secondsToHM(s.hours * 3600),
      additionalTime: "none",
      _countrySource: s.fields.guessed.countrySource,
      _categorySource: s.fields.guessed.categorySource,
    }));
    onAddRows(newRows, day.name);
    // The suggestions recompute against the new rows; drop what was typed for
    // them so a leftover shortfall starts from the fresh figure.
    setEdits((p) => {
      const next = { ...p };
      picked.forEach((s) => delete next[s.key]);
      return next;
    });
    setAdded({ n: newRows.length, hours: pickedTotal, day: day.name });
  };

  useEffect(() => {
    if (!added) return;
    const t = setTimeout(() => setAdded(null), 5000);
    return () => clearTimeout(t);
  }, [added]);

  return (
    <div className="fixed inset-0 z-[100001] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="comment-trail-title"
        className="relative w-full max-w-5xl bg-gradient-to-b from-[#1c2333] to-[#141b28] border border-white/10 rounded-2xl shadow-2xl flex flex-col max-h-[90vh] text-slate-300 animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent" />

        {/* Header */}
        <div className="px-6 pt-5 pb-4 border-b border-white/5 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-9 h-9 shrink-0 rounded-xl bg-[#12a0e1]/15 text-[#38bdf8] flex items-center justify-center">
              <MessagesSquare className="w-[18px] h-[18px]" />
            </div>
            <div className="min-w-0">
              <h2 id="comment-trail-title" className="text-base font-bold text-white">
                What did I work on?
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Suggestions from the comments you posted in Wrike. Tick what's right, adjust the time, add it to Legacy.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex gap-1 p-1 bg-[#0b0f17] rounded-xl border border-white/5" role="group" aria-label="Day">
              {days.map((d) => (
                <button
                  key={d.iso}
                  onClick={() => setDayIso(d.iso)}
                  aria-pressed={d.iso === dayIso}
                  className={`px-3 py-1 rounded-lg text-xs font-bold leading-tight flex flex-col items-center transition-colors ${
                    d.iso === dayIso ? "bg-[#12a0e1] text-white" : "text-slate-500 hover:text-slate-200"
                  }`}
                >
                  {d.name.slice(0, 3)}
                  <span className="text-[10px] font-medium opacity-70">{d.date.getDate()}</span>
                </button>
              ))}
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="p-2 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-400 hover:text-white rounded-xl transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto custom-scrollbar">
          {(!state || state.status === "loading") && (
            <div className="py-20 flex flex-col items-center gap-3 text-sm text-slate-400">
              <RefreshCw className="w-5 h-5 animate-spin text-[#38bdf8]" />
              Reading your Wrike comments for {day.name}…
            </div>
          )}

          {state?.status === "error" && (
            <div className="py-16 px-6 flex flex-col items-center gap-3 text-center">
              <AlertCircle className="w-6 h-6 text-rose-400" />
              <p className="text-sm text-slate-300 max-w-md">{state.error}</p>
              <button
                onClick={() => load(day)}
                className="px-4 py-2 text-xs font-bold rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-white"
              >
                Try again
              </button>
            </div>
          )}

          {view && view.suggestions.length === 0 && (
            <div className="py-20 px-6 text-center text-sm text-slate-400">
              You didn't comment on any Wrike tasks on {day.name}.
              {view.folderOnly > 0 && (
                <div className="text-xs text-slate-500 mt-1">
                  {view.folderOnly} comment{view.folderOnly !== 1 ? "s" : ""} on folders or projects, which don't map to a job.
                </div>
              )}
            </div>
          )}

          {view && view.suggestions.length > 0 && (
            <>
              {/* Summary */}
              <div className="grid grid-cols-2 md:grid-cols-4 border-b border-white/5">
                <Stat value={view.taskComments.length} label="comments on tasks" />
                <Stat value={hm(view.estTotal)} label="estimated from comments" />
                <Stat value={hm(view.loggedTotal)} label={`on Legacy for ${day.name}`} />
                <Stat
                  value={view.missing.length ? hm(view.missing.reduce((s, x) => s + x.gap, 0)) : "—"}
                  label={
                    view.missing.length
                      ? `${view.missing.length} job${view.missing.length !== 1 ? "s" : ""} short or missing`
                      : "nothing missing"
                  }
                  warn={view.missing.length > 0}
                />
              </div>

              {/* Method */}
              <div className="px-6 py-3 border-b border-white/5 bg-black/10 flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="flex rounded-lg border border-white/10 overflow-hidden" role="group" aria-label="Estimate method">
                  {Object.entries(METHODS).map(([k, m]) => (
                    <button
                      key={k}
                      onClick={() => setMethod(k)}
                      aria-pressed={method === k}
                      className={`px-3 py-1.5 text-xs font-bold transition-colors ${
                        method === k ? "bg-[#12a0e1]/20 text-[#38bdf8]" : "text-slate-500 hover:text-slate-200"
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-slate-400 flex-1 min-w-[16rem]">{METHODS[method].help}</p>
              </div>

              <Timeline view={view} />

              {(state.truncated || view.folderOnly > 0) && (
                <div className="px-6 pb-3 -mt-1 text-[11px] text-slate-500 flex flex-col gap-0.5">
                  {state.truncated && (
                    <span className="text-amber-400/90">
                      Wrike sent its maximum number of comments for part of this day, so some of yours may be missing.
                    </span>
                  )}
                  {view.folderOnly > 0 && (
                    <span>
                      {view.folderOnly} comment{view.folderOnly !== 1 ? "s" : ""} on folders or projects aren't listed, because they don't map to a job.
                    </span>
                  )}
                </div>
              )}

              {/* Suggestions */}
              <ul className="border-t border-white/5">
                {view.suggestions.map((s) => (
                  <Suggestion key={s.key} s={s} frozen={isFrozen} edit={edit} />
                ))}
              </ul>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-white/5 bg-black/20 rounded-b-2xl flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-slate-400 min-h-[1.25rem] flex items-center gap-2">
            {added ? (
              <span className="flex items-center gap-1.5 text-emerald-400 font-bold">
                <CheckCircle className="w-4 h-4" />
                Added {added.n} row{added.n !== 1 ? "s" : ""} ({hm(added.hours)}) to {added.day}
              </span>
            ) : isFrozen ? (
              <span className="flex items-center gap-1.5 text-amber-400">
                <Lock className="w-3.5 h-3.5" />
                {day.name} is locked. Unlock it in Legacy to add rows.
              </span>
            ) : view && picked.length ? (
              <span>
                <b className="text-white">{picked.length} row{picked.length !== 1 ? "s" : ""}</b> ·{" "}
                <b className="text-white font-mono">{hm(pickedTotal)}</b> to add to {day.name}
              </span>
            ) : view && view.suggestions.length && !view.missing.length ? (
              <span>Everything you commented on is already on Legacy for {day.name}.</span>
            ) : null}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-xs font-bold rounded-lg text-slate-400 hover:text-white border border-white/10 hover:bg-white/5"
            >
              Close
            </button>
            <button
              onClick={handleAdd}
              disabled={!picked.length || isFrozen}
              className="px-4 py-2 text-xs font-bold rounded-lg bg-[#12a0e1] hover:bg-[#0d8bc4] text-white shadow-md shadow-[#12a0e1]/20 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-[#12a0e1]"
            >
              {picked.length ? `Add ${picked.length} row${picked.length !== 1 ? "s" : ""} to ${day.name}` : "Add rows"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ value, label, warn }) {
  return (
    <div className="px-6 py-3">
      <div className={`text-xl font-bold font-mono tabular-nums ${warn ? "text-amber-400" : "text-white"}`}>{value}</div>
      <div className="text-[11px] text-slate-500">{label}</div>
    </div>
  );
}

// One lane per task: a dot per comment, and a faint bar for the stretch of the
// day each estimate covers.
function Timeline({ view }) {
  const minutes = [
    ...view.blocks.flatMap((b) => [b.from, b.to]),
    ...view.taskComments.map((c) => localMinuteOf(c.createdDate)),
  ];
  const start = Math.min(9 * 60, Math.floor(Math.min(...minutes) / 60) * 60);
  const end = Math.max(18 * 60, Math.ceil(Math.max(...minutes) / 60) * 60);
  const pct = (m) => `${(((m - start) / (end - start)) * 100).toFixed(2)}%`;
  const hours = [];
  for (let h = start; h <= end; h += 60) hours.push(h);

  return (
    <div className="px-6 py-4 overflow-x-auto custom-scrollbar">
      <div className="min-w-[640px]">
        <div className="relative h-4 ml-[180px] mb-1">
          {hours.map((h) => (
            <span key={h} className="absolute -translate-x-1/2 text-[10px] font-mono text-slate-500" style={{ left: pct(h) }}>
              {clock(h)}
            </span>
          ))}
        </div>
        {view.suggestions.map((s) => (
          <div key={s.key} className="grid grid-cols-[180px_1fr] items-center h-8 border-t border-dashed border-white/5">
            <div className="flex items-center gap-2 pr-3 text-[11px] font-semibold text-slate-300 truncate" title={s.title}>
              <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: s.colour }} />
              <span className="truncate">{s.title}</span>
            </div>
            <div className="relative h-full">
              {hours.map((h) => (
                <div key={h} className="absolute inset-y-0 w-px bg-white/5" style={{ left: pct(h) }} />
              ))}
              {view.blocks
                .filter((b) => b.taskId === s.taskId)
                .map((b, i) => (
                  <div
                    key={i}
                    className="absolute top-[11px] h-2.5 rounded"
                    style={{ left: pct(b.from), width: `calc(${pct(b.to)} - ${pct(b.from)})`, background: s.colour, opacity: 0.25 }}
                  />
                ))}
              {s.comments.map((c) => (
                <span
                  key={c.id}
                  title={`${clock(localMinuteOf(c.createdDate))}  ${c.text}`}
                  className="absolute top-[10px] w-3 h-3 -ml-1.5 rounded-full bg-[#141b28] border-[2.5px] hover:scale-125 transition-transform cursor-default"
                  style={{ left: pct(localMinuteOf(c.createdDate)), borderColor: s.colour }}
                />
              ))}
            </div>
          </div>
        ))}
        <div className="flex flex-wrap gap-x-5 gap-y-1 mt-2 text-[11px] text-slate-500">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full border-2 border-slate-400" /> A comment you posted (hover to read it)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-4 h-2 rounded bg-slate-400/30" /> Time it probably covers
          </span>
        </div>
      </div>
    </div>
  );
}

function Suggestion({ s, frozen, edit }) {
  const [open, setOpen] = useState(false);
  const covered = s.gap === 0;
  const jobCode = (s.fields.guessed.jobNumber || "").match(/XY\d{5,6}/i)?.[0];
  const pill = covered ? (
    <Pill cls="text-emerald-400 bg-emerald-400/10">On Legacy · {hm(s.logged.hours)}</Pill>
  ) : s.logged.hours > 0 ? (
    <Pill cls="text-amber-400 bg-amber-400/10">Short by {hm(s.gap)}</Pill>
  ) : (
    <Pill cls="text-[#38bdf8] bg-[#38bdf8]/10">Not logged</Pill>
  );
  const hint = covered
    ? `Comments suggest ${hm(s.est)}`
    : s.logged.hours > 0
    ? `${hm(s.est)} suggested, ${hm(s.logged.hours)} logged${s.logged.match === "job" ? " on this job" : ""}`
    : `${hm(s.est)} suggested`;

  return (
    <li className={`grid grid-cols-[24px_minmax(0,1fr)_auto] gap-x-4 gap-y-1 px-6 py-4 border-b border-white/5 last:border-b-0 ${covered ? "opacity-55" : ""}`}>
      <input
        type="checkbox"
        id={`ct-${s.key}`}
        checked={s.on}
        disabled={covered || frozen}
        onChange={(e) => edit(s.key, { on: e.target.checked })}
        aria-label={`Include ${s.title}`}
        className="mt-1 w-4 h-4 accent-[#12a0e1] cursor-pointer disabled:cursor-default"
      />
      <div className="min-w-0">
        <label htmlFor={`ct-${s.key}`} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm font-bold text-white cursor-pointer">
          <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: s.colour }} />
          <span className="min-w-0 break-words">{s.title}</span>
          {pill}
        </label>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[11px] text-slate-400">
          {jobCode ? <span className="font-mono text-slate-200">{jobCode}</span> : <span className="italic">No job number found</span>}
          {s.fields.filmTitle && <span>{s.fields.filmTitle}</span>}
          {s.fields.client && <span>{s.fields.client}</span>}
          {s.fields.guessed.territory && <span>{s.fields.guessed.territory}</span>}
          {s.fields.guessed.category && <span>{s.fields.guessed.category}</span>}
        </div>
        {!covered && (
          <div className="mt-2.5 flex items-center gap-2">
            <label htmlFor={`ctn-${s.key}`} className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Notes
            </label>
            <input
              id={`ctn-${s.key}`}
              value={s.notes}
              disabled={frozen}
              onChange={(e) => edit(s.key, { notes: e.target.value })}
              className="flex-1 min-w-0 text-xs bg-black/20 border border-white/10 rounded-lg px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-[#12a0e1]/60"
            />
          </div>
        )}
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="mt-2 flex items-center gap-1 text-[11px] font-bold text-[#38bdf8] hover:text-[#7dd3fc]"
        >
          <ChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
          {s.comments.length} comment{s.comments.length !== 1 ? "s" : ""}
        </button>
        {open && (
          <ul className="mt-2 pl-3 border-l-2 flex flex-col gap-1.5" style={{ borderColor: s.colour }}>
            {s.comments.map((c) => (
              <li key={c.id} className="text-xs text-slate-300 break-words">
                <span className="font-mono text-slate-500 mr-2">{clock(localMinuteOf(c.createdDate))}</span>
                {c.text || <span className="italic text-slate-500">(attachment only)</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col items-end gap-1 col-start-2 sm:col-start-auto max-sm:items-start max-sm:mt-2">
        {covered ? (
          <span className="font-mono text-sm font-bold text-slate-300">{hm(s.logged.hours)}</span>
        ) : (
          <div className="flex items-center rounded-lg border border-white/10 bg-black/20 overflow-hidden">
            <button
              onClick={() => edit(s.key, { hours: Math.max(0.25, s.hours - 0.25), on: true })}
              disabled={frozen}
              aria-label="Less time"
              className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/5 disabled:opacity-40"
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
            <output className="min-w-[3.25rem] text-center font-mono text-sm font-bold text-white">{hm(s.hours)}</output>
            <button
              onClick={() => edit(s.key, { hours: Math.min(12, s.hours + 0.25), on: true })}
              disabled={frozen}
              aria-label="More time"
              className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/5 disabled:opacity-40"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        <span className="text-[10px] text-slate-500 whitespace-nowrap">{hint}</span>
      </div>
    </li>
  );
}

function Pill({ cls, children }) {
  return <span className={`text-[10px] font-bold tracking-wide px-2 py-0.5 rounded-full whitespace-nowrap ${cls}`}>{children}</span>;
}
