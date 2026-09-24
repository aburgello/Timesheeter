import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Check,
} from "lucide-react";
import FloatingCard from "../shared/FloatingCard";
import { fetchMyCommentsForDay } from "../../lib/wrikeComments";
import { fetchActivityForDay, historyStart } from "../../lib/taskActivity";
import {
  estimateFromActivity,
  activityToEvents,
  roundToQuarterHours,
  hoursLoggedFor,
  localMinuteOf,
  DAY_START_MIN,
  DAY_END_MIN,
} from "../../utils/commentActivity";
import { hmToHours, getCurrentWeekStart } from "../../hooks/useLegacyRows";
import { secondsToHM } from "../../utils/timeHelpers";
import { isoToday, toIsoDate } from "../../utils/dates";

// "What did I work on?" — suggests timesheet rows from your Wrike activity:
// the tasks you were handed (assigned, or moved into a new status by someone
// else) and the comments you posted. See utils/commentActivity.js for how that
// becomes time.
//
// Status history only exists from when the webhook started recording it
// (wrike_task_activity). For a day before that, the modal lists what you
// commented on and leaves the time for you to fill in.
//
// Reads only. Nothing is written — not a row, not a Job Book entry — until
// "Add rows" is pressed, and then only through the parent's onAddRows, which
// is the same addRows path Wrike Pull uses.

const LANE_COLOURS = ["#38bdf8", "#f59e0b", "#a78bfa", "#34d399", "#fb7185", "#facc15", "#2dd4bf", "#f472b6"];
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const hm = (hours) => secondsToHM(hours * 3600, "0:00");
const clock = (minute) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const plural = (n, word) => `${n} ${word}${n !== 1 ? "s" : ""}`;
// Minutes → hours on the 0.25 grid, zero allowed (roundToQuarterHours has a floor).
const quarters = (minutes) => Math.round((minutes || 0) / 15) / 4;
// How much of an estimate isn't on the sheet yet, on the 0.25 grid. Under
// half a step short counts as covered.
const shortfall = (estimate, logged) => {
  const short = estimate - logged;
  return short >= 0.125 ? Math.round(short * 4) / 4 : 0;
};

// Monday of this week through today — the days the timesheet grid can hold.
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

export default function CommentTrailModal({
  onClose,
  wrikeUserId,
  rows,
  frozenDays,
  initialDay,
  resolveTasks,
  rowFieldsFromTask,
  onAddRows,
  prepare,
  statusName,
  statusGroup,
}) {
  const days = useMemo(daysSoFar, []);
  const [dayIso, setDayIso] = useState(
    () => (days.find((d) => d.name === initialDay) || days[days.length - 1]).iso
  );
  const day = days.find((d) => d.iso === dayIso);

  // Read through a ref so a re-render of the grid behind (new arrays, new
  // callbacks) doesn't make a loaded day look stale and fetch it again.
  const live = useRef();
  live.current = { resolveTasks, prepare, statusName, statusGroup };

  // Per day: { status: "loading"|"ready"|"error", comments, truncated, activity,
  // tasks, hasHistory, since, error }
  const [byDay, setByDay] = useState({});
  // Per "iso:taskId": what the member changed — { on, hours, extra }.
  const [edits, setEdits] = useState({});
  const [added, setAdded] = useState(null);
  // The row a timeline mark was clicked for: { key, itemId, n }. n makes a
  // second click on the same mark jump again.
  const [jump, setJump] = useState(null);

  const load = useCallback(
    async (d) => {
      setByDay((p) => ({ ...p, [d.iso]: { status: "loading" } }));
      try {
        const [{ comments, others, truncated }, since, myTaskIds] = await Promise.all([
          fetchMyCommentsForDay(d.date, wrikeUserId),
          // History is a bonus: if it can't be read, fall back to comments
          // only rather than showing nothing.
          historyStart().catch((err) => {
            console.warn("[what did I work on] status history unavailable:", err.message);
            return null;
          }),
          // Your tasks and the status groups, once the page's sync has them.
          live.current.prepare(),
        ]);
        const hasHistory = !!since && since <= d.date;
        const mine = new Set(myTaskIds);
        const commented = [...new Set(comments.map((c) => c.taskId).filter(Boolean))];

        const activity = hasHistory
          ? await fetchActivityForDay(d.date, wrikeUserId, [...new Set([...commented, ...mine])])
          : [];
        // Only tasks something happened on that concerns you: ones you
        // commented on, were handed, or changed yourself.
        const involved = new Set(commented);
        for (const a of activity) {
          if (a.event_type === "TaskResponsiblesAdded" || a.author_id === wrikeUserId || mine.has(a.task_id)) {
            involved.add(a.task_id);
          }
        }
        const tasks = involved.size ? await live.current.resolveTasks([...involved]) : [];
        setByDay((p) => ({
          ...p,
          [d.iso]: {
            status: "ready",
            comments,
            // Only on tasks that concern you; the rest of the account's
            // comments aren't kept.
            others: others.filter((c) => involved.has(c.taskId)),
            truncated,
            activity,
            hasHistory,
            since,
            myTaskIds,
            tasks: new Map(tasks.map((t) => [t.id, t])),
          },
        }));
      } catch (err) {
        console.error("[what did I work on]", err);
        setByDay((p) => ({
          ...p,
          [d.iso]: {
            status: "error",
            error:
              err.status === 401
                ? "Your Wrike connection has expired. Reconnect Wrike in Profile → Settings, then try again."
                : `Couldn't read your Wrike activity (${err.message}).`,
          },
        }));
      }
    },
    [wrikeUserId]
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
    const { statusName: nameOf, statusGroup: groupOf } = live.current;
    const myIds = state.myTaskIds;
    const me = wrikeUserId;
    const taskComments = state.comments.filter((c) => c.taskId);
    const assignedToday = new Set(
      state.activity
        .filter((a) => a.event_type === "TaskResponsiblesAdded" && a.user_ids?.includes(me))
        .map((a) => a.task_id)
    );
    const mineSet = new Set(myIds);
    const isMyTask = (id) =>
      mineSet.has(id) || assignedToday.has(id) || !!state.tasks.get(id)?.responsibleIds?.includes(me);

    // What each task's lane and thread show: your comments, plus the changes
    // that count as hand-offs or closes.
    const describe = (a) => {
      const minute = localMinuteOf(a.occurred_at);
      const id = `${a.task_id}:${a.event_type}:${a.occurred_at}`;
      const name = nameOf(a.custom_status_id) || a.status || "a new status";
      if (a.event_type === "TaskResponsiblesAdded" && a.user_ids?.includes(me))
        return { id, minute, type: "cue", text: "You were assigned" };
      if (a.event_type === "TaskResponsiblesRemoved" && a.user_ids?.includes(me))
        return { id, minute, type: "closed", text: "You were taken off it" };
      if (a.event_type !== "TaskStatusChanged") return null;
      if (a.author_id === me) return { id, minute, type: "mine", text: `You moved it to ${name}` };
      if (!isMyTask(a.task_id)) return null;
      const group = groupOf(a.custom_status_id);
      return group && group !== "Active"
        ? { id, minute, type: "closed", text: `Moved to ${name}` }
        : { id, minute, type: "cue", text: `Moved to ${name}` };
    };

    const now = new Date();
    const dayEnd =
      day.iso === isoToday()
        ? Math.max(DAY_START_MIN, Math.min(DAY_END_MIN, now.getHours() * 60 + now.getMinutes()))
        : DAY_END_MIN;

    let byTask = {};
    let overtimeByTask = {};
    let intervals = [];
    let taskOrder;
    if (state.hasHistory) {
      const events = activityToEvents({
        comments: taskComments,
        others: state.others,
        activity: state.activity,
        me,
        isMyTask,
        statusGroup: groupOf,
      });
      ({ byTask, overtimeByTask, intervals } = estimateFromActivity(events, { dayEnd }));
      // Listed for your own action or a hand-off to you. A task whose only
      // events are someone closing it or commenting on it wasn't worked on.
      taskOrder = [
        ...new Set(
          events
            .filter((e) => e.kind === "mine" || e.kind === "start")
            .sort((a, b) => a.minute - b.minute)
            .map((e) => e.taskId)
        ),
      ];
    } else {
      taskOrder = [...new Set(taskComments.map((c) => c.taskId))];
    }

    const dayRows = (rows || []).filter(
      (r) => r.dayOfWeek === day.name && (!r.date || toIsoDate(r.date) === day.iso)
    );
    const suggestions = taskOrder.map((taskId, i) => {
      const task = state.tasks.get(taskId);
      const { guessed, client, filmTitle } = rowFieldsFromTask(task);
      const logged = hoursLoggedFor(dayRows, { taskId, jobNumber: guessed.jobNumber, territory: guessed.territory }, hmToHours);
      // Time before 18:00 goes in Time Spent; after it is overtime, for the
      // Add. Time column. Each is compared with its own column on the sheet.
      let est = null;
      let estRegular = 0;
      let estExtra = 0;
      let gapRegular = 0;
      let gapExtra = 0;
      let gap = null;
      let standing;
      if (state.hasHistory) {
        estExtra = quarters(overtimeByTask[taskId]);
        estRegular = quarters(byTask[taskId] - overtimeByTask[taskId]);
        // Something happened on it, so never nothing — the same one-step floor
        // roundToQuarterHours gives.
        if (estRegular + estExtra === 0) estRegular = roundToQuarterHours(0);
        est = estRegular + estExtra;
        // The total decides whether anything is missing; the columns only
        // decide where a real shortfall goes. Otherwise overtime already
        // logged as regular time would be suggested again as add. time.
        gap = shortfall(est, logged.hours);
        gapExtra = Math.min(shortfall(estExtra, logged.extra), gap);
        gapRegular = gap - gapExtra;
        standing = gap === 0 ? "covered" : logged.hours > 0 ? "short" : "missing";
      } else {
        standing = logged.hours > 0 ? "covered" : "missing";
      }
      const items = [
        ...taskComments
          .filter((c) => c.taskId === taskId)
          .map((c) => ({ id: c.id, minute: localMinuteOf(c.createdDate), type: "comment", text: c.text })),
        ...state.others
          .filter((c) => c.taskId === taskId)
          .map((c) => ({ id: c.id, minute: localMinuteOf(c.createdDate), type: "theirs", text: c.text })),
        ...state.activity.filter((a) => a.task_id === taskId).map(describe).filter(Boolean),
      ].sort((a, b) => a.minute - b.minute);
      const key = `${day.iso}:${taskId}`;
      const e = edits[key] || {};
      // With an estimate, a covered task can't be ticked. Without one, nothing
      // says the logged time is enough, so everything stays tickable.
      const locked = est !== null && standing === "covered";
      return {
        key,
        taskId,
        task,
        colour: LANE_COLOURS[i % LANE_COLOURS.length],
        title: task?.title || "A task you can no longer open",
        fields: { guessed, client, filmTitle },
        items,
        commentCount: items.filter((x) => x.type === "comment").length,
        est,
        estExtra,
        logged,
        gap,
        standing,
        locked,
        // Never ticked for you: an estimate is a suggestion, and a pre-ticked
        // one is logged by anyone who presses Add without reading every row.
        // Changing its time ticks it, since that's you deciding.
        on: !locked && (e.on ?? false),
        hours: e.hours ?? gapRegular,
        extra: e.extra ?? gapExtra,
        // Not shown or edited here: rows carry the task's title as their note.
        notes: task?.title || "",
      };
    });

    const loggedTotal = dayRows.reduce(
      (s, r) => s + hmToHours(r.timeSpent) + hmToHours(r.additionalTime),
      0
    );
    return {
      suggestions,
      intervals,
      hasHistory: state.hasHistory,
      since: state.since,
      commentCount: taskComments.length,
      folderOnly: state.comments.length - taskComments.length,
      estTotal: suggestions.reduce((s, x) => s + (x.est || 0), 0),
      loggedTotal,
      missing: suggestions.filter((s) => s.standing !== "covered"),
    };
  }, [state, rows, day, edits, rowFieldsFromTask, wrikeUserId]);

  const edit = (key, patch) => setEdits((p) => ({ ...p, [key]: { ...p[key], ...patch } }));

  const picked = view ? view.suggestions.filter((s) => s.on && s.hours + s.extra > 0) : [];
  const pickedTotal = picked.reduce((s, x) => s + x.hours + x.extra, 0);

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
      additionalTime: secondsToHM(s.extra * 3600),
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
              <p className="text-xs text-slate-400 mt-0.5 max-w-xl">
                Suggestions from your Wrike activity: the tasks you were handed and the comments you posted.
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
              Reading your Wrike activity for {day.name}…
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
              {view.hasHistory
                ? `No Wrike activity from you on ${day.name}: no tasks handed to you and no comments.`
                : `You didn't comment on any Wrike tasks on ${day.name}.`}
              {view.folderOnly > 0 && (
                <div className="text-xs text-slate-500 mt-1">
                  {plural(view.folderOnly, "comment")} on folders or projects, which don't map to a job.
                </div>
              )}
            </div>
          )}

          {view && view.suggestions.length > 0 && (
            <>
              {/* Summary */}
              <div className="grid grid-cols-2 md:grid-cols-4 border-b border-white/5">
                {view.hasHistory ? (
                  <>
                    <Stat value={view.suggestions.length} label="tasks you worked on" />
                    <Stat value={hm(view.estTotal)} label="estimated from your activity" />
                  </>
                ) : (
                  <>
                    <Stat value={view.commentCount} label="comments on tasks" />
                    <Stat value={view.suggestions.length} label="tasks you commented on" />
                  </>
                )}
                <Stat value={hm(view.loggedTotal)} label={`on the timesheets for ${day.name}`} />
                {view.hasHistory ? (
                  <Stat
                    value={view.missing.length ? hm(view.missing.reduce((s, x) => s + x.gap, 0)) : "—"}
                    label={view.missing.length ? `${plural(view.missing.length, "task")} short or missing` : "nothing missing"}
                    warn={view.missing.length > 0}
                  />
                ) : (
                  <Stat
                    value={view.missing.length || "—"}
                    label={view.missing.length ? "not on the timesheets yet" : "all on the timesheets"}
                    warn={view.missing.length > 0}
                  />
                )}
              </div>

              <Timeline
                view={view}
                activeItemId={jump?.itemId}
                onPick={(s, item) => setJump({ key: s.key, itemId: item.id, n: Date.now() })}
              />

              {(state.truncated || view.folderOnly > 0) && (
                <div className="px-6 pb-3 -mt-1 text-[11px] text-slate-500 flex flex-col gap-0.5">
                  {state.truncated && (
                    <span className="text-amber-400/90">
                      Wrike sent its maximum number of comments for part of this day, so some of yours may be missing.
                    </span>
                  )}
                  {view.folderOnly > 0 && (
                    <span>
                      {plural(view.folderOnly, "comment")} on folders or projects aren't listed, because they don't map to a job.
                    </span>
                  )}
                </div>
              )}

              {/* Suggestions */}
              <ul className="border-t border-white/5">
                {view.suggestions.map((s) => (
                  <Suggestion key={s.key} s={s} frozen={isFrozen} edit={edit} jump={jump?.key === s.key ? jump : null} />
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
                Added {plural(added.n, "row")} ({hm(added.hours)}) to {added.day}
              </span>
            ) : isFrozen ? (
              <span className="flex items-center gap-1.5 text-amber-400">
                <Lock className="w-3.5 h-3.5" />
                {day.name} is locked. Unlock the day to add rows.
              </span>
            ) : view && picked.length ? (
              <span>
                <b className="text-white">{plural(picked.length, "row")}</b> ·{" "}
                <b className="text-white font-mono">{hm(pickedTotal)}</b> to add to {day.name}
              </span>
            ) : view && view.suggestions.length && !view.missing.length ? (
              <span>Everything you worked on is already on the timesheets for {day.name}.</span>
            ) : view && !view.hasHistory && view.suggestions.length ? (
              <span>Set a time on a task to add it.</span>
            ) : view && view.missing.length ? (
              <span>Tick the tasks you want to add.</span>
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
              {picked.length ? `Add ${plural(picked.length, "row")} to ${day.name}` : "Add rows"}
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

// Your comment on the timeline: a ring in the task's colour, filled once it's
// the one you clicked. A task with nothing on the timesheets glows (see
// .mark-glow in tailwind.css).
function Mark({ colour, active, glow, className = "", style, ...rest }) {
  return (
    <button
      {...rest}
      className={`w-3 h-3 -ml-1.5 rounded-full border-[2.5px] ${glow ? "mark-glow" : ""} ${className}`}
      style={{ ...style, "--glow": colour, background: active ? colour : "#141b28", borderColor: colour }}
    />
  );
}

// One lane per task: a bar for each stretch of work, your comments as rings on
// top. Status changes aren't drawn one by one (a busy task turned into a pile
// of diamonds that hid the comments underneath); a stretch a hand-off opened
// gets a solid cap at its start instead, and the changes behind a stretch are
// in its hover card. Every one is still listed under the task's Activity.
// Clicking a comment or a bar takes you to that task's row, to set its time.
function Timeline({ view, activeItemId, onPick }) {
  // { s, item } for a comment or lane name, { s, bar } for a stretch, + rect.
  const [hover, setHover] = useState(null);

  const minutes = [
    ...view.intervals.flatMap((b) => [b.from, b.to]),
    ...view.suggestions.flatMap((s) => s.items.map((x) => x.minute)),
  ];
  const start = Math.min(9 * 60, Math.floor(Math.min(...minutes) / 60) * 60);
  const end = Math.max(18 * 60, Math.ceil(Math.max(...minutes) / 60) * 60);
  const pct = (m) => `${(((m - start) / (end - start)) * 100).toFixed(2)}%`;
  const hours = [];
  for (let h = start; h <= end; h += 60) hours.push(h);
  // Past 18:00 is overtime; shade it so the Add. Time suggestion reads at a
  // glance. Only on days with estimates: without history nothing is
  // suggested, and the band claimed otherwise.
  const hasOvertime = view.hasHistory && end > DAY_END_MIN;

  const show = (payload) => (e) => setHover({ ...payload, rect: e.currentTarget.getBoundingClientRect() });
  const hide = () => setHover(null);
  // What happened inside a stretch, for its card: the hand-off that opened it,
  // the comments and changes along it, the action that closed it.
  const within = (s, b) => s.items.filter((x) => x.minute >= b.from - 1 && x.minute <= b.to + 1);
  const openedBy = (s, b) => s.items.find((x) => x.type === "cue" && Math.abs(x.minute - b.from) <= 1);

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
        {view.suggestions.map((s) => {
          const comments = s.items.filter((x) => x.type === "comment");
          const bars = view.intervals.filter((b) => b.taskId === s.taskId);
          // The glow goes on the comments, or on the bars of a task you were
          // handed but haven't commented on, so every unlogged task shows it.
          const missing = s.standing === "missing";
          return (
            <div key={s.key} className="grid grid-cols-[180px_1fr] items-center h-8 border-t border-dashed border-white/5">
              <div
                className="flex items-center gap-2 pr-3 text-[11px] font-semibold text-slate-300 truncate"
                onMouseEnter={show({ s, item: null })}
                onMouseLeave={hide}
              >
                <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: s.colour }} />
                <span className="truncate">{s.title}</span>
              </div>
              <div className="relative h-full">
                {hasOvertime && (
                  <div className="absolute inset-y-0 right-0 bg-amber-400/[0.06]" style={{ left: pct(DAY_END_MIN) }} />
                )}
                {hours.map((h) => (
                  <div key={h} className="absolute inset-y-0 w-px bg-white/5" style={{ left: pct(h) }} />
                ))}
                {bars.map((b, i) => {
                  const cue = openedBy(s, b);
                  return (
                    <button
                      key={i}
                      onMouseEnter={show({ s, bar: b })}
                      onMouseLeave={hide}
                      onFocus={show({ s, bar: b })}
                      onBlur={hide}
                      onClick={() => {
                        hide();
                        onPick(s, within(s, b).find((x) => x.type === "comment") || within(s, b)[0] || { id: null });
                      }}
                      aria-label={`${s.title}, ${clock(b.from)} to ${clock(b.to)}. Go to it to set its time`}
                      className={`absolute top-[11px] h-2.5 rounded bg-[color-mix(in_srgb,var(--c)_28%,transparent)] hover:bg-[color-mix(in_srgb,var(--c)_48%,transparent)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
                        missing && !comments.length ? "mark-glow" : ""
                      }`}
                      style={{ "--c": s.colour, "--glow": s.colour, left: pct(b.from), width: `calc(${pct(b.to)} - ${pct(b.from)})` }}
                    >
                      {cue && <span className="absolute inset-y-0 left-0 w-1 rounded-l" style={{ background: s.colour }} />}
                    </button>
                  );
                })}
                {comments.map((item) => {
                  const isActive = activeItemId === item.id;
                  return (
                    <Mark
                      key={item.id}
                      colour={s.colour}
                      active={isActive}
                      glow={missing}
                      onMouseEnter={show({ s, item })}
                      onMouseLeave={hide}
                      onFocus={show({ s, item })}
                      onBlur={hide}
                      onClick={() => {
                        hide();
                        onPick(s, item);
                      }}
                      aria-label={`${clock(item.minute)}: ${item.text || "attachment"}. Go to ${s.title} to set its time`}
                      className={`absolute top-1/2 -translate-y-1/2 transition-transform hover:scale-125 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
                        isActive ? "scale-125" : ""
                      }`}
                      style={{ left: pct(item.minute) }}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
        <div className="flex flex-wrap gap-x-5 gap-y-1 mt-2 text-[11px] text-slate-500">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full border-2 border-slate-400" /> Your comment
          </span>
          {view.hasHistory && (
            <span className="flex items-center gap-1.5">
              <span className="relative w-5 h-2 rounded bg-slate-400/30 overflow-hidden">
                <span className="absolute inset-y-0 left-0 w-1 bg-slate-400" />
              </span>{" "}
              Time it probably covers, solid where it was handed to you
            </span>
          )}
          {view.suggestions.some((s) => s.standing === "missing") && (
            <span className="flex items-center gap-1.5">
              <span
                className="w-2.5 h-2.5 rounded-full border-2 border-slate-300 mark-glow"
                style={{ "--glow": "#cbd5e1" }}
              />{" "}
              Not on the timesheets yet
            </span>
          )}
          {hasOvertime && (
            <span className="flex items-center gap-1.5">
              <span className="w-4 h-2 rounded bg-amber-400/25" /> After 18:00, suggested as add. time
            </span>
          )}
          <span>Hover a comment or a bar for details, click it to set that task's time.</span>
        </div>
      </div>

      {hover && (
        <FloatingCard rect={hover.rect} className="p-3 w-80 pointer-events-none">
          <div className="flex items-center gap-2 text-[11px] font-semibold text-slate-400">
            <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: hover.s.colour }} />
            <span className="truncate">{hover.s.title}</span>
          </div>
          {hover.item && (
            <p className="mt-1.5 text-xs text-slate-100 leading-relaxed line-clamp-5 break-words">
              <span className="font-mono text-[#38bdf8] mr-2">{clock(hover.item.minute)}</span>
              <ItemText item={hover.item} />
            </p>
          )}
          {hover.bar && <BarDetails s={hover.s} bar={hover.bar} items={within(hover.s, hover.bar)} intervals={view.intervals} />}
        </FloatingCard>
      )}
    </div>
  );
}

// A stretch's hover card: how long, why it started, what happened along it.
function BarDetails({ s, bar, items, intervals }) {
  const shared = intervals.some((o) => o.taskId !== s.taskId && o.from < bar.to && o.to > bar.from);
  const opened = items.some((x) => x.type === "cue" && Math.abs(x.minute - bar.from) <= 1);
  return (
    <div className="mt-1.5 text-xs">
      <p className="font-mono text-slate-100">
        {clock(bar.from)}–{clock(bar.to)} <span className="text-slate-500">· {hm((bar.to - bar.from) / 60)}</span>
      </p>
      {!opened && !items.some((x) => x.minute <= bar.from + 1) && (
        <p className="mt-1 text-slate-400">No hand-off that day, so it counts from the start of the day.</p>
      )}
      {items.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-1">
          {items.slice(0, 6).map((x) => (
            <li key={x.id} className="line-clamp-2 break-words text-slate-300">
              <span className="font-mono text-slate-500 mr-2">{clock(x.minute)}</span>
              <ItemText item={x} />
            </li>
          ))}
          {items.length > 6 && <li className="text-slate-500">and {items.length - 6} more in its Activity</li>}
        </ul>
      )}
      {shared && <p className="mt-1.5 text-slate-500">Other tasks were open at the same time, so this time is split with them.</p>}
    </div>
  );
}

function ItemText({ item }) {
  if (item.type === "comment") return item.text || <span className="italic text-slate-500">Attachment only</span>;
  if (item.type === "theirs")
    return (
      <>
        <span className="text-slate-500">Someone else: </span>
        {item.text || <span className="italic text-slate-500">attachment only</span>}
      </>
    );
  return <span className="italic text-slate-300">{item.text}</span>;
}

function Suggestion({ s, frozen, edit, jump }) {
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState(false);
  const rowRef = useRef(null);
  const plusRef = useRef(null);

  // Clicked on the timeline: bring this row into view, show the clicked
  // comment in its activity, and put the time control under the keyboard.
  useEffect(() => {
    if (!jump) return;
    setOpen(true);
    setFlash(true);
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    rowRef.current?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    (plusRef.current && !plusRef.current.disabled ? plusRef.current : rowRef.current)?.focus({ preventScroll: true });
    const t = setTimeout(() => setFlash(false), 1600);
    return () => clearTimeout(t);
  }, [jump?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const jobCode = (s.fields.guessed.jobNumber || "").match(/XY\d{5,6}/i)?.[0];
  const pill =
    s.standing === "covered" ? (
      <Pill cls="text-emerald-400 bg-emerald-400/10">On the timesheets · {hm(s.logged.hours)}</Pill>
    ) : s.standing === "short" ? (
      <Pill cls="text-amber-400 bg-amber-400/10">Short by {hm(s.gap)}</Pill>
    ) : (
      <Pill cls="text-[#38bdf8] bg-[#38bdf8]/10">Not on the timesheets</Pill>
    );
  // Where the logged figure came from, when it isn't this exact task.
  const where =
    s.logged.match === "market"
      ? ` for ${s.fields.guessed.territory}`
      : s.logged.match === "job"
      ? " on this job"
      : "";
  const hint =
    s.est === null
      ? s.logged.hours > 0
        ? `${hm(s.logged.hours)} logged${where}. Add more if needed`
        : "Set the time you spent"
      : s.standing === "covered"
      ? `Your activity suggests ${hm(s.est)}`
      : s.standing === "short"
      ? `${hm(s.est)} suggested, ${hm(s.logged.hours)} logged${where}`
      : `${hm(s.est)} suggested`;
  // Show the Add. Time control when overtime is suggested or already set;
  // otherwise it's one click away.
  const showExtra = s.estExtra > 0 || s.extra > 0;

  return (
    <li
      ref={rowRef}
      tabIndex={-1}
      className={`grid grid-cols-[24px_minmax(0,1fr)_auto] gap-x-4 gap-y-1 px-6 py-4 border-b border-white/5 last:border-b-0 outline-none transition-colors duration-700 ${
        flash ? "bg-[#12a0e1]/10" : ""
      } ${s.locked ? "opacity-55" : ""}`}
    >
      <Tick
        id={`ct-${s.key}`}
        checked={s.on}
        disabled={s.locked || frozen}
        onChange={(e) => edit(s.key, { on: e.target.checked })}
        label={`Include ${s.title}`}
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
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="mt-2 flex items-center gap-1 text-[11px] font-bold text-[#38bdf8] hover:text-[#7dd3fc]"
        >
          <ChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
          {s.items.length === s.commentCount ? plural(s.commentCount, "comment") : `Activity (${s.items.length})`}
        </button>
        {open && (
          <ul className="mt-2 -mx-2 flex flex-col gap-0.5">
            {s.items.map((item) => {
              const picked = jump?.itemId === item.id;
              return (
                <li
                  key={item.id}
                  className={`px-2 py-1 rounded-md text-xs break-words ${picked ? "bg-white/[0.07] text-slate-100" : "text-slate-300"}`}
                >
                  <span className={`font-mono mr-2 ${picked ? "text-[#38bdf8]" : "text-slate-500"}`}>{clock(item.minute)}</span>
                  <ItemText item={item} />
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="flex flex-col items-end gap-1 col-start-2 sm:col-start-auto max-sm:items-start max-sm:mt-2">
        {s.locked ? (
          <span className="font-mono text-sm font-bold text-slate-300">{hm(s.logged.hours)}</span>
        ) : (
          <>
            <Stepper
              label={showExtra ? "Time" : null}
              value={s.hours}
              frozen={frozen}
              plusRef={plusRef}
              onChange={(hours) => edit(s.key, { hours, on: hours + s.extra > 0 })}
            />
            {showExtra ? (
              <Stepper
                label="Add. time"
                value={s.extra}
                frozen={frozen}
                onChange={(extra) => edit(s.key, { extra, on: s.hours + extra > 0 })}
              />
            ) : (
              <button
                onClick={() => edit(s.key, { extra: 0.25, on: true })}
                disabled={frozen}
                className="text-[10px] font-bold text-slate-500 hover:text-[#38bdf8] disabled:opacity-40"
              >
                + Add. time
              </button>
            )}
          </>
        )}
        <span className="max-w-[15rem] text-[10px] text-slate-500 text-right max-sm:text-left">{hint}</span>
        {s.estExtra > 0 && (
          <span className="max-w-[15rem] text-[10px] text-amber-400/80 text-right max-sm:text-left">
            {hm(s.estExtra)} of it after 18:00, as add. time
          </span>
        )}
      </div>
    </li>
  );
}

// A time in 0:15 steps. The empty value reads 0:00, greyed: a dash next to
// the minus button looked like a second minus.
function Stepper({ label, value, frozen, onChange, plusRef }) {
  return (
    <div className="flex items-center gap-2">
      {label && <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</span>}
      <div className="flex items-center rounded-lg border border-white/10 bg-black/20 overflow-hidden">
        <button
          onClick={() => onChange(Math.max(0, value - 0.25))}
          disabled={frozen || value <= 0}
          aria-label={`Less ${(label || "time").toLowerCase()}`}
          className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/5 disabled:opacity-40"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <output className={`min-w-[3.25rem] text-center font-mono text-sm font-bold ${value > 0 ? "text-white" : "text-slate-500"}`}>
          {hm(value)}
        </output>
        <button
          ref={plusRef}
          onClick={() => onChange(Math.min(12, value + 0.25))}
          disabled={frozen}
          aria-label={`More ${(label || "time").toLowerCase()}`}
          className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/5 disabled:opacity-40"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

// The site's own tick box (the one on Legacy's row selection), over a real
// checkbox so the label, keyboard and screen readers still work.
function Tick({ id, checked, disabled, onChange, label }) {
  return (
    <span className="relative mt-0.5 w-4 h-4 shrink-0">
      <input
        type="checkbox"
        id={id}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        aria-label={label}
        className="peer absolute inset-0 m-0 opacity-0 cursor-pointer disabled:cursor-default"
      />
      <span
        aria-hidden="true"
        className={`pointer-events-none w-4 h-4 rounded-[4px] border flex items-center justify-center transition-[background-color,border-color] duration-150 peer-focus-visible:ring-2 peer-focus-visible:ring-[#12a0e1]/60 ${
          checked ? "bg-[#12a0e1] border-[#12a0e1]" : "bg-black/20 border-white/30 peer-hover:border-white/60"
        } ${disabled ? "opacity-40" : ""}`}
      >
        {checked && <Check className="w-3 h-3 text-white" strokeWidth={4} />}
      </span>
    </span>
  );
}

function Pill({ cls, children }) {
  return <span className={`text-[10px] font-bold tracking-wide px-2 py-0.5 rounded-full whitespace-nowrap ${cls}`}>{children}</span>;
}
