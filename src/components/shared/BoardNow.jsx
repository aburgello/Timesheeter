import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../lib/supabaseClient";
import { Pencil, Check, Square } from "lucide-react";

// The board sits under the app-wide `html { zoom: 1.1 }`. getBoundingClientRect
// returns already-zoomed visual pixels, but an inline style.top/left is a
// layout length the browser zooms AGAIN — so a fixed popover placed at a raw
// rect value lands ~10% off. Dividing by the zoom factor cancels it.
const zoomFactor = () => parseFloat(getComputedStyle(document.documentElement).zoom) || 1;

// "Working now" for the board, as a per-task dot instead of a bar.
//
// One row per person in board_now (their current task + note) over Supabase
// Postgres Changes: a real write is the only thing that fires an event, so
// this costs nothing until someone actually changes what they're on. Each row
// is self-contained (name + colour), so any viewer renders it with no join.
//
// useBoardNow owns the single board-wide subscription; every ActiveDot reads
// from it. One channel for the whole board, never one per task.
const keyOf = (uid, taskId) => `${uid}|${taskId}`;

export function useBoardNow(department) {
  const myId = useMemo(() => localStorage.getItem("wrike_user_id"), []);
  const [me, setMe] = useState(null); // { name, color }
  const [rows, setRows] = useState({}); // "uid|taskId" -> row
  // Per-mount channel suffix so a second board (or StrictMode's double-mount)
  // can't be handed the first's already-subscribed channel — .on() after
  // subscribe() throws.
  const chanIdRef = useRef(Math.random().toString(36).slice(2, 9));

  useEffect(() => {
    if (!myId) return;
    let alive = true;
    supabase
      .from("profiles")
      .select("first_name, canvas_color")
      .eq("wrike_user_id", myId)
      .maybeSingle()
      .then(({ data }) => {
        if (alive) setMe({ name: data?.first_name || "Someone", color: data?.canvas_color || "#12a0e1" });
      });
    return () => { alive = false; };
  }, [myId]);

  useEffect(() => {
    if (!department) return;
    let alive = true;
    supabase
      .from("board_now")
      .select("*")
      .eq("department", department)
      .then(({ data }) => {
        if (!alive) return;
        const m = {};
        (data || []).forEach((r) => { m[keyOf(r.wrike_user_id, r.task_id)] = r; });
        setRows(m);
      });

    const channel = supabase
      .channel(`board-now:${department}:${chanIdRef.current}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "board_now", filter: `department=eq.${department}` },
        (p) => {
          setRows((prev) => {
            const n = { ...prev };
            if (p.eventType === "DELETE") delete n[keyOf(p.old.wrike_user_id, p.old.task_id)];
            else n[keyOf(p.new.wrike_user_id, p.new.task_id)] = p.new;
            return n;
          });
        }
      )
      .subscribe();

    return () => { alive = false; supabase.removeChannel(channel); };
  }, [department]);

  // task_id -> the people ACTIVE on it right now (green dot). A saved note on a
  // task you're not active on stays in `rows` but isn't surfaced until you
  // reactivate that task — the note persists, the indicator doesn't.
  const activeByTask = useMemo(() => {
    const m = {};
    Object.values(rows).forEach((r) => { if (r.active && r.task_id) (m[r.task_id] ||= []).push(r); });
    return m;
  }, [rows]);

  // My single active row (the one green dot that's mine), if any.
  const myActive = useMemo(
    () => (myId ? Object.values(rows).find((r) => r.wrike_user_id === myId && r.active) : null),
    [rows, myId]
  );

  const base = (taskId, taskTitle) => ({
    wrike_user_id: myId,
    task_id: taskId,
    department,
    task_title: taskTitle,
    user_name: me.name,
    user_color: me.color,
    updated_at: new Date().toISOString(),
  });

  // Make `task` my active one. The previously-active task is just deactivated
  // (its note kept); the target is reactivated with whatever note it already
  // had — `note` is omitted from the upsert, so on conflict Postgres leaves the
  // stored note untouched, and on a first insert it defaults to null.
  const setActive = async (task) => {
    if (!myId || !me) return;
    const prev = myActive;
    const existing = rows[keyOf(myId, task.id)];
    setRows((cur) => {
      const n = { ...cur };
      if (prev && prev.task_id !== task.id) n[keyOf(myId, prev.task_id)] = { ...prev, active: false };
      n[keyOf(myId, task.id)] = { ...(existing || {}), ...base(task.id, task.title), active: true, note: existing?.note ?? null };
      return n;
    });
    if (prev && prev.task_id !== task.id) {
      await supabase.from("board_now").update({ active: false, updated_at: new Date().toISOString() })
        .eq("wrike_user_id", myId).eq("task_id", prev.task_id);
    }
    await supabase.from("board_now").upsert({ ...base(task.id, task.title), active: true }); // note omitted → preserved
  };

  const updateNote = async (note) => {
    if (!myActive) return;
    const value = (note || "").trim() || null;
    const row = { ...myActive, note: value, updated_at: new Date().toISOString() };
    setRows((cur) => ({ ...cur, [keyOf(myId, myActive.task_id)]: row }));
    await supabase.from("board_now").upsert(row);
  };

  // Stop being active on the current task. Keep the row (note preserved) so the
  // note restores when you come back; but a noteless status is just cleared.
  const stop = async () => {
    if (!myActive) return;
    const { task_id, note } = myActive;
    if (note) {
      setRows((cur) => ({ ...cur, [keyOf(myId, task_id)]: { ...myActive, active: false } }));
      await supabase.from("board_now").update({ active: false, updated_at: new Date().toISOString() })
        .eq("wrike_user_id", myId).eq("task_id", task_id);
    } else {
      setRows((cur) => { const n = { ...cur }; delete n[keyOf(myId, task_id)]; return n; });
      await supabase.from("board_now").delete().eq("wrike_user_id", myId).eq("task_id", task_id);
    }
  };

  return { myId, me, activeByTask, myActive, setActive, updateNote, stop, ready: !!me };
}

// Subtasks are fetched from Wrike (full task → subTaskIds → those tasks) and
// cached per task id so repeated hovers don't refetch. The checked state is
// the same personal, localStorage-backed checklist the task modal uses (same
// `subtask_checks_${id}` key), so ticking one here shows ticked there too.
const subtaskCache = new Map(); // taskId -> Promise<[{id,title}]>
function loadSubtasks(taskId) {
  if (subtaskCache.has(taskId)) return subtaskCache.get(taskId);
  const p = (async () => {
    try {
      const full = (await (await fetch(`/api/wrike/tasks/${taskId}`)).json()).data?.[0];
      const ids = full?.subTaskIds || [];
      if (!ids.length) return [];
      const subs = (await (await fetch(`/api/wrike/tasks/${ids.join(",")}`)).json()).data || [];
      return subs.map((s) => ({ id: s.id, title: s.title }));
    } catch {
      return [];
    }
  })();
  subtaskCache.set(taskId, p);
  return p;
}

// The dot itself. Green when someone's active on this task; hollow (revealed on
// chip hover) otherwise. Click a hollow dot to mark it as what you're on. Hover
// a green dot to read the note — and edit it, if it's yours.
//
// canActivate is whether this task is the current user's to claim — the dot is
// only clickable-to-activate on tasks in your own lane, so you can't mark
// someone else's task as what *you're* working on. Other people's active
// tasks still show a read-only green dot with their note.
export function ActiveDot({ task, now, canActivate = false }) {
  const rows = now.activeByTask[task.id] || [];
  const active = rows.length > 0;
  const mineHere = now.myActive?.task_id === task.id;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [pos, setPos] = useState(null);
  const [subtasks, setSubtasks] = useState([]);
  const [subLoading, setSubLoading] = useState(false);
  const [checkedIds, setCheckedIds] = useState(() => new Set());
  const dotRef = useRef(null);
  const closeTimer = useRef(null);

  const checkKey = `subtask_checks_${task.id}`;

  // Load the task's subtasks + this browser's checklist state the first time
  // the popover opens (lazy — no fetch until someone actually looks).
  useEffect(() => {
    if (!open) return;
    try { setCheckedIds(new Set(JSON.parse(localStorage.getItem(checkKey) || "[]"))); } catch { /* ignore */ }
    let alive = true;
    setSubLoading(true);
    loadSubtasks(task.id).then((list) => { if (alive) { setSubtasks(list); setSubLoading(false); } });
    return () => { alive = false; };
  }, [open, task.id]);

  const toggleCheck = (id) => {
    setCheckedIds((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      try { localStorage.setItem(checkKey, JSON.stringify([...n])); } catch { /* ignore */ }
      return n;
    });
  };

  const place = () => {
    const el = dotRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const z = zoomFactor();
    // Right edge of the popover pinned under the dot's right edge (transform
    // pulls it left by its own width); a hair below the dot.
    setPos({ top: r.bottom / z + 6, left: r.right / z });
  };
  const openNow = () => { clearTimeout(closeTimer.current); if (active) { place(); setOpen(true); } };
  const cancelClose = () => clearTimeout(closeTimer.current);
  const closeSoon = () => { if (editing) return; closeTimer.current = setTimeout(() => setOpen(false), 160); };
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  const beginEdit = () => { setDraft(now.myActive?.note || ""); setEditing(true); setOpen(true); };
  const commitEdit = async () => { await now.updateNote(draft); setEditing(false); };

  // Nothing to show: not active, and not the current user's task to claim.
  if (!active && !canActivate) return null;

  return (
    <span
      className="relative shrink-0 flex items-center"
      onMouseEnter={openNow}
      onMouseLeave={closeSoon}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        ref={dotRef}
        onClick={(e) => {
          e.stopPropagation();
          if (!active) { if (canActivate) now.setActive(task); } // hollow → go green (own task only)
          else { place(); setOpen((o) => !o); }                  // green → toggle the note
        }}
        title={active ? undefined : "Mark as what you're working on"}
        aria-label={active ? "Working-now status" : "Mark as working now"}
        className={`block w-2.5 h-2.5 rounded-full transition-all ${
          active
            ? "bg-emerald-500 shadow-[0_0_0_2px_rgba(16,185,129,0.25)]"
            : "border border-[#cbd5e1] opacity-0 group-hover/chip:opacity-100 hover:border-emerald-500 hover:bg-emerald-50"
        } ${mineHere ? "ring-2 ring-emerald-300 ring-offset-1 ring-offset-white" : ""}`}
      />

      {open && active && pos && createPortal(
        <div
          onMouseEnter={cancelClose}
          onMouseLeave={closeSoon}
          onClick={(e) => e.stopPropagation()}
          style={{ position: "fixed", top: pos.top, left: pos.left, transform: "translateX(-100%)", width: 300, zIndex: 60 }}
          className="rounded-xl border border-[#dce4ec] bg-white shadow-xl p-2 text-left cursor-default"
        >
          {rows.map((r) => {
            const isMe = r.wrike_user_id === now.myId;
            return (
              <div key={r.wrike_user_id} className="px-1 py-1">
                <div className="flex items-center gap-2">
                  <span
                    className="w-5 h-5 rounded-full grid place-items-center text-[9px] font-black text-white shrink-0"
                    style={{ backgroundColor: r.user_color || "#8a8073" }}
                  >
                    {(r.user_name || "?").charAt(0).toUpperCase()}
                  </span>
                  <span className="text-[12px] font-black text-[#122027] truncate flex-1">{r.user_name}</span>
                  {isMe && !editing && (
                    <>
                      <button onClick={beginEdit} title="Edit note" className="p-1 rounded text-[#94a3b8] hover:text-[#12a0e1]">
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button onClick={now.stop} title="Stop working on this" className="p-1 rounded text-[#94a3b8] hover:text-rose-500">
                        <Square className="w-3 h-3" />
                      </button>
                    </>
                  )}
                </div>

                {isMe && editing ? (
                  <div className="mt-1.5">
                    <textarea
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commitEdit();
                        if (e.key === "Escape") setEditing(false);
                      }}
                      rows={2}
                      placeholder="Add a note… e.g. 'waiting on feedback'"
                      className="w-full px-2 py-1.5 rounded-lg border border-[#dce4ec] text-[12px] outline-none focus:border-[#12a0e1]/40 resize-none"
                    />
                    <div className="flex items-center gap-1.5 mt-1">
                      <button onClick={commitEdit} className="flex items-center gap-1 px-2 py-1 rounded-md bg-[#12a0e1] hover:bg-[#0f88c0] text-white text-[11px] font-black">
                        <Check className="w-3 h-3" /> Save
                      </button>
                      <button onClick={() => setEditing(false)} className="px-2 py-1 rounded-md text-[11px] font-bold text-[#768994] hover:bg-slate-50">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : r.note ? (
                  <p className="mt-0.5 pl-7 text-[12px] text-[#3a4753] italic leading-snug [overflow-wrap:anywhere]">“{r.note}”</p>
                ) : isMe ? (
                  <button onClick={beginEdit} className="mt-0.5 pl-7 text-[11px] font-semibold text-[#94a3b8] hover:text-[#12a0e1]">
                    + Add a note
                  </button>
                ) : (
                  <p className="mt-0.5 pl-7 text-[11px] italic text-[#b0bcc6]">No note</p>
                )}
              </div>
            );
          })}

          {/* Subtask checklist — same personal, localStorage-backed checklist as
              the task modal (shared key), shown right below the note. */}
          {(subLoading || subtasks.length > 0) && (
            <div className="mt-1.5 pt-1.5 border-t border-[#eef1f5]">
              <div className="flex items-center gap-1.5 px-1 mb-1">
                <span className="text-[9px] font-black uppercase tracking-widest text-[#94a3b8]">
                  Subtasks{subtasks.length ? ` (${subtasks.length})` : ""}
                </span>
                {subtasks.length > 0 && (
                  <span className="ml-auto text-[10px] font-bold text-[#b0bcc6] tabular-nums">
                    {subtasks.filter((s) => checkedIds.has(s.id)).length}/{subtasks.length}
                  </span>
                )}
              </div>
              {subLoading && subtasks.length === 0 ? (
                <p className="px-1 py-1 text-[11px] text-[#b0bcc6] italic">Loading…</p>
              ) : (
                <div className="max-h-48 overflow-y-auto overflow-x-hidden flex flex-col gap-0.5">
                  {subtasks.map((s) => {
                    const done = checkedIds.has(s.id);
                    return (
                      <button
                        key={s.id}
                        onClick={() => toggleCheck(s.id)}
                        className="flex items-start gap-1.5 px-1 py-1 rounded-md hover:bg-slate-50 text-left w-full"
                      >
                        {done ? (
                          <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-px" />
                        ) : (
                          <Square className="w-3.5 h-3.5 text-slate-300 shrink-0 mt-px" />
                        )}
                        {/* Wrap long filenames instead of scrolling sideways —
                            overflow-wrap:anywhere breaks the unbroken PP3_… string
                            so the full name (incl. the trailing dimensions that
                            distinguish two subtasks) stays visible. */}
                        <span
                          className={`min-w-0 flex-1 text-[11.5px] leading-snug [overflow-wrap:anywhere] ${done ? "text-[#b0bcc6] line-through" : "text-[#3a4753]"}`}
                        >
                          {s.title}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* My own task, someone else is on it too — let me join. Only offered
              for tasks in my lane (canActivate). */}
          {canActivate && !mineHere && (
            <button
              onClick={() => now.setActive(task)}
              className="w-full mt-1.5 pt-1.5 border-t border-[#eef1f5] text-[11px] font-bold text-[#12a0e1] hover:text-[#0f88c0]"
            >
              I'm working on this too
            </button>
          )}
        </div>,
        document.body
      )}
    </span>
  );
}
