// People: departments, positions, Administration access and leavers.
//
// Part of Administration. Split out of components/Management.jsx, which is
// still the entry point and re-exports what other screens import.
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Users, Pencil, X, Check, Search, RefreshCw } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { isServiceAccount, DEPT_GROUPS, departmentForGroup, hasLeft } from "../../lib/people";
import { confirmAction } from "../../lib/confirm";
import { cleanNamePart } from "../../lib/formatName";
import HubRow from "../shared/HubRow";
import { StrictSelect } from "./fields";

// Leavers sit in their own group at the bottom, after the departments.
const LEFT_GROUP = { label: "Left the company", gradient: "from-slate-300 to-slate-500" };
const GROUPS = [...DEPT_GROUPS, LEFT_GROUP];

export function PeopleSection() {
  const [people, setPeople]         = useState([]);
  const [positions, setPositions]   = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading]       = useState(true);
  const [syncing, setSyncing]       = useState(false);
  const [syncMsg, setSyncMsg]       = useState("");
  // One department open at a time, matching the Administration hub above it:
  // opening one closes the last. Holds a label, or null for all closed.
  const [openGroup, setOpenGroup]   = useState(null);
  const [search, setSearch]         = useState("");
  // Per-department: has its expand/collapse animation finished? Still keyed by
  // label rather than a single flag, because a search shows several groups
  // open at once (see isGroupOpen).
  const [settled, setSettled]       = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: profiles }, { data: pos }, { data: depts }] = await Promise.all([
      supabase.from("profiles").select("*").order("first_name"),
      supabase.from("positions").select("*").order("title"),
      supabase.from("job_departments").select("name").order("name"),
    ]);
    // Wrike's own service accounts (AM Team, Magic Wrike, All proofreaders)
    // sync into profiles like any real contact but aren't people — never
    // show them here.
    setPeople((profiles || []).filter((p) => !isServiceAccount(p.wrike_user_id)));
    setPositions(pos || []);
    setDepartments((depts || []).map(d => d.name));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const updateField = async (wrikeUserId, patch) => {
    setPeople(prev => prev.map(p => p.wrike_user_id === wrikeUserId ? { ...p, ...patch } : p));
    await supabase.from("profiles").update(patch).eq("wrike_user_id", wrikeUserId);
  };

  const [editingNameFor, setEditingNameFor] = useState(null);
  const nameDraft = useRef({ first: null, last: null });
  const saveName = (p) => {
    const first = (nameDraft.current.first?.value || "").trim();
    const last = (nameDraft.current.last?.value || "").trim();
    setEditingNameFor(null);
    // Empty both fields and it falls back to Wrike's name on the next sign-in,
    // which is a reasonable way to undo a rename.
    updateField(p.wrike_user_id, { first_name: first || null, last_name: last || null });
  };

  // Adds people from Wrike, fills in departments from Wrike groups, and marks
  // people whose Wrike account has been deleted as having left. It never
  // overrides anything set here: names, departments and "left" all stick.
  const syncFromWrike = async () => {
    if (!localStorage.getItem("wrike_user_id")) { setSyncMsg("Wrike not connected — connect it in Profile → Settings first."); return; }
    setSyncing(true);
    setSyncMsg("");
    try {
      const [contactsRes, groupsRes] = await Promise.all([
        fetch("/api/wrike/contacts"),
        fetch("/api/wrike/groups"),
      ]);
      if (!contactsRes.ok) throw new Error(`Wrike contacts error ${contactsRes.status}`);
      const contacts = ((await contactsRes.json()).data || []).filter((c) => c.type === "Person");

      // Department per Wrike group, matched exactly (departmentForGroup). Someone
      // in groups for two different departments is left for a person to decide.
      const deptMap = {};
      const conflicted = new Set();
      const unmatchedGroups = [];
      if (groupsRes.ok) {
        for (const group of (await groupsRes.json()).data || []) {
          const dept = departmentForGroup(group.title, departments);
          if (!dept) { if (group.title) unmatchedGroups.push(group.title); continue; }
          for (const memberId of group.memberIds || []) {
            if (deptMap[memberId] && deptMap[memberId] !== dept) conflicted.add(memberId);
            deptMap[memberId] = dept;
          }
        }
      }
      conflicted.forEach((id) => delete deptMap[id]);

      const { data: existingRows } = await supabase.from("profiles").select("*");
      const existing = new Map((existingRows || []).map((r) => [r.wrike_user_id, r]));

      let added = 0, departmentsFilled = 0, markedLeft = 0;
      for (const c of contacts) {
        const row = existing.get(c.id);
        if (c.deleted) {
          // Deleted in Wrike: never add them, and mark an existing profile as left.
          if (row && !hasLeft(row)) {
            const { error } = await supabase.from("profiles")
              .update({ left_at: new Date().toISOString() }).eq("wrike_user_id", c.id);
            if (!error) markedLeft++;
          }
          continue;
        }
        const payload = {
          wrike_user_id: c.id,
          email: c.profiles?.[0]?.email || null,
          avatar_url: c.avatarUrl || null,
        };
        // A name tidied up here (Wrike is where "Trott ⚡️" comes from) survives.
        if (!row || !(row.first_name || row.last_name)) {
          payload.first_name = c.firstName || null;
          payload.last_name = c.lastName || null;
        }
        // Departments from Wrike only fill a blank; one set here is kept.
        if (deptMap[c.id] && !row?.department) {
          payload.department = deptMap[c.id];
          departmentsFilled++;
        }
        const { error } = await supabase.from("profiles").upsert(payload, { onConflict: "wrike_user_id" });
        if (!error && !row) added++;
      }

      const parts = [`Synced ${contacts.filter((c) => !c.deleted).length} people from Wrike`];
      if (added) parts.push(`${added} new`);
      if (departmentsFilled) parts.push(`${departmentsFilled} department${departmentsFilled === 1 ? "" : "s"} filled in from Wrike groups`);
      if (markedLeft) parts.push(`${markedLeft} marked as left (deleted in Wrike)`);
      if (conflicted.size) parts.push(`${conflicted.size} in groups for two departments, left as they were`);
      let msg = parts.join(" · ") + ".";
      if (unmatchedGroups.length) msg += ` Groups matching no department: ${unmatchedGroups.join(", ")}.`;
      setSyncMsg(msg);
      await load();
    } catch (err) {
      setSyncMsg(`Sync failed: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  // Checked by the database: only an administrator can change it, and the last
  // one can't be removed. A refused change is put back.
  const toggleAdmin = async (p) => {
    const is_admin = !p.is_admin;
    setPeople(prev => prev.map(x => x.wrike_user_id === p.wrike_user_id ? { ...x, is_admin } : x));
    const { error } = await supabase.from("profiles").update({ is_admin }).eq("wrike_user_id", p.wrike_user_id);
    if (error) {
      setPeople(prev => prev.map(x => x.wrike_user_id === p.wrike_user_id ? { ...x, is_admin: !is_admin } : x));
      setSyncMsg(`Couldn't change Administration access: ${error.message}`);
    }
  };

  const markLeft = async (p) => {
    const ok = await confirmAction({
      title: "Mark as left the company?",
      message: `${cleanNamePart(p.first_name) || "This person"} will drop off team boards and out of the People list. Their timesheet history is kept, and you can restore them from "Left the company".`,
      confirmLabel: "Mark as left",
      danger: true,
    });
    if (ok) updateField(p.wrike_user_id, { left_at: new Date().toISOString() });
  };

  // Bucket people into department groups. Keyed against DEPT_GROUPS (the
  // hardcoded visual-identity list), not the editable departments list — a
  // brand-new department with no bucket colour yet lands in "—" instead of
  // being silently dropped, until a developer gives it a DEPT_GROUPS entry.
  const filteredPeople = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return people;
    return people.filter(p => {
      const fullName = `${p.first_name || ""} ${p.last_name || ""}`.toLowerCase();
      return fullName.includes(q) || (p.email || "").toLowerCase().includes(q);
    });
  }, [people, search]);

  const buckets = useMemo(() => {
    const out = Object.fromEntries(GROUPS.map(g => [g.label, []]));
    for (const p of filteredPeople) {
      const key = hasLeft(p)
        ? LEFT_GROUP.label
        : p.department && DEPT_GROUPS.some(g => g.label === p.department) ? p.department : "—";
      out[key].push(p);
    }
    return out;
  }, [filteredPeople]);
  const currentCount = people.filter((p) => !hasLeft(p)).length;

  // Searching suspends the accordion. A search that could only ever reveal
  // one department's matches would hide most of its own results, so while
  // there's a query every department holding a match shows open; the
  // one-at-a-time rule returns as soon as the box is cleared.
  const searching = !!search.trim();
  const isGroupOpen = (label) =>
    searching ? (buckets[label] || []).length > 0 : openGroup === label;

  const toggleGroup = (label) => {
    // Any toggle (opening or closing) starts a height transition, so the
    // clipping needs to be hidden again until it finishes — otherwise a
    // dropdown left open from before the animation started would render
    // past the box's edge mid-transition. The outgoing group needs the same
    // treatment, since opening one now collapses another.
    setSettled(prev => ({ ...prev, [label]: false, ...(openGroup ? { [openGroup]: false } : {}) }));
    setOpenGroup(prev => (prev === label ? null : label));
  };

  const PersonCard = ({ p }) => {
    // Cleaned first, then initialed — an emoji leading a raw Wrike name
    // (e.g. "🌸 Jov") would otherwise become the initial instead of the
    // actual first letter.
    const cleanFirst = cleanNamePart(p.first_name);
    const cleanLast = cleanNamePart(p.last_name);
    const initials = `${cleanFirst[0] || ""}${cleanLast[0] || ""}`.toUpperCase() || "?";
    const fullName = [cleanFirst, cleanLast].filter(Boolean).join(" ") || "Unknown";
    return (
      // A directory row, not a profile card. The previous version gave each
      // person a full-height portrait strip and stacked the two dropdowns,
      // which put a department of a dozen people well past a screenful. The
      // portrait is now a thumbnail and the dropdowns sit side by side, which
      // roughly halves the height without losing anything on it.
      <div className="flex items-center gap-3 bg-white border border-[#dce4ec] rounded-xl px-3 py-2
                      hover:border-slate-300 hover:shadow-[0_6px_16px_-10px_rgba(18,32,39,0.25)]
                      transition-[box-shadow,border-color] duration-200">
        {p.avatar_url ? (
          <img src={p.avatar_url} alt={fullName} className="w-10 h-10 rounded-lg shrink-0 object-cover" />
        ) : (
          <div className="w-10 h-10 rounded-lg shrink-0 bg-gradient-to-br from-[#12a0e1] to-[#1cc1a5] text-white flex items-center justify-center font-display font-bold text-sm tracking-tight">
            {initials}
          </div>
        )}
        <div className="flex-1 min-w-0 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            {/* The display name is editable here because Wrike is the only
                other source of it, and Wrike is where the emoji and dropped
                surnames come from. Sign-in seeds a name once and then leaves
                it alone (see stampIdentity), so whatever is set here sticks.
                Inputs are UNCONTROLLED and save on Enter/blur: PersonCard is
                redefined on every render of this section, so a keystroke that
                set state would remount it and steal focus mid-word. */}
            {editingNameFor === p.wrike_user_id ? (
              <div className="flex items-center gap-1.5">
                <input
                  autoFocus
                  defaultValue={cleanFirst}
                  ref={(el) => (nameDraft.current.first = el)}
                  placeholder="First"
                  onKeyDown={(e) => { if (e.key === "Enter") saveName(p); if (e.key === "Escape") setEditingNameFor(null); }}
                  className="w-full min-w-0 px-2 py-1 text-sm font-bold rounded-lg border border-[#12a0e1] outline-none bg-white text-[#122027]"
                />
                <input
                  defaultValue={cleanLast}
                  ref={(el) => (nameDraft.current.last = el)}
                  placeholder="Last"
                  onKeyDown={(e) => { if (e.key === "Enter") saveName(p); if (e.key === "Escape") setEditingNameFor(null); }}
                  className="w-full min-w-0 px-2 py-1 text-sm font-bold rounded-lg border border-[#12a0e1] outline-none bg-white text-[#122027]"
                />
                <button onClick={() => saveName(p)} title="Save name"
                  className="shrink-0 p-1.5 bg-[#12a0e1] text-white rounded-lg hover:bg-[#0d8bc4]">
                  <Check className="w-3 h-3" />
                </button>
                <button onClick={() => setEditingNameFor(null)} title="Cancel"
                  className="shrink-0 p-1 text-slate-400 hover:text-slate-600">
                  <X className="w-3 h-3" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setEditingNameFor(p.wrike_user_id)}
                title="Rename"
                className="group/name flex items-center gap-1.5 max-w-full text-left"
              >
                <span className="font-display text-[14px] font-bold text-[#122027] tracking-tight truncate">{fullName}</span>
                <Pencil className="w-3 h-3 shrink-0 text-slate-300 opacity-0 group-hover/name:opacity-100 transition-opacity" />
              </button>
            )}
            <p className="text-[11px] leading-tight text-[#768994] truncate">{p.email || p.wrike_user_id}</p>
          </div>
          {/* Same searchable dropdown Job Book uses for its pickers, instead
              of a bare native <select> — the app's one dropdown style. "No
              department"/"No position" are plain entries in the option list
              (StrictSelect is selection-only, no separate clear affordance),
              translated back to null on the way out. */}
          {/* Side by side rather than stacked — this is the single biggest
              saving in the row's height, and both fields still get a usable
              width at two columns. */}
          <div className="flex items-center gap-1.5 shrink-0 [&>*]:w-32 sm:[&>*]:w-36">
            <StrictSelect
              value={p.department || "No department"}
              onChange={(v) => updateField(p.wrike_user_id, { department: v === "No department" ? null : v })}
              options={["No department", ...departments]}
            />
            <StrictSelect
              value={positions.find(pos => pos.id === p.position_id)?.title || "No position"}
              onChange={(v) => {
                if (v === "No position") { updateField(p.wrike_user_id, { position_id: null }); return; }
                const pos = positions.find(pos => pos.title === v);
                updateField(p.wrike_user_id, { position_id: pos?.id ?? null });
              }}
              options={["No position", ...positions.map(pos => pos.title)]}
            />
          </div>
          {"is_admin" in p && !hasLeft(p) && (
            <button onClick={() => toggleAdmin(p)}
              aria-pressed={!!p.is_admin}
              title={p.is_admin ? "Can open Administration. Click to remove." : "Give access to Administration"}
              className={`shrink-0 text-[11px] font-bold px-2.5 py-1.5 rounded-lg border ${p.is_admin
                ? "border-[#12a0e1] bg-[#12a0e1] text-white hover:bg-[#0d8bc4]"
                : "border-[#dce4ec] text-[#768994] hover:border-[#12a0e1] hover:text-[#122027]"}`}>
              Admin
            </button>
          )}
          {/* Only once the database has profiles.left_at (see its migration). */}
          {"left_at" in p && (hasLeft(p) ? (
            <button onClick={() => updateField(p.wrike_user_id, { left_at: null })}
              title="Back at the company"
              className="shrink-0 text-[11px] font-bold px-2.5 py-1.5 rounded-lg border border-[#dce4ec] text-[#122027] hover:border-[#12a0e1]">
              Restore
            </button>
          ) : (
            <button onClick={() => markLeft(p)}
              title="Left the company"
              className="shrink-0 text-[11px] font-bold px-2.5 py-1.5 rounded-lg border border-[#dce4ec] text-[#768994] hover:text-red-600 hover:border-red-200">
              Left
            </button>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-1">
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          {!loading && (
            <span className="text-[10px] font-black text-[#768994] uppercase tracking-widest shrink-0 tabular-nums">
              {search.trim() ? `${filteredPeople.length} of ${people.length}` : currentCount} people
            </span>
          )}
          {/* Search — same input treatment as SimpleListSection's list search */}
          <div className="relative w-56">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#768994]" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search people…"
              className="w-full pl-9 pr-8 py-2.5 text-sm border border-[#dce4ec] rounded-xl outline-none focus:border-[#12a0e1] focus:ring-2 focus:ring-[#12a0e1]/20 bg-white placeholder-[#b0bec5] transition-colors"
            />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-500">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {syncMsg && <span className="text-[11px] font-medium text-[#768994] bg-slate-50 border border-[#dce4ec] rounded-lg px-2.5 py-1.5 max-w-md">{syncMsg}</span>}
          <button onClick={syncFromWrike} disabled={syncing}
            className="flex items-center gap-1.5 px-3.5 py-2.5 bg-white border border-[#dce4ec] hover:border-slate-300 text-[#122027] text-xs font-bold rounded-xl transition-[border-color] ease-[cubic-bezier(0.16,1,0.3,1)] disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing…" : "Sync from Wrike"}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 gap-2.5 text-[#768994]">
          <RefreshCw className="w-4 h-4 animate-spin text-[#12a0e1]" />
          <span className="text-sm font-bold">Loading…</span>
        </div>
      ) : people.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-[#768994]">
          <Users className="w-9 h-9 opacity-20" />
          <p className="font-display text-base font-bold text-[#122027]">No people yet</p>
          <p className="text-xs">Use “Sync from Wrike” above to pull everyone in the workspace.</p>
        </div>
      ) : filteredPeople.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-[#768994]">
          <Search className="w-9 h-9 opacity-20" />
          <p className="font-display text-base font-bold text-[#122027]">No one matches “{search}”</p>
          <p className="text-xs">Try a shorter search, or clear it to see everyone.</p>
        </div>
      ) : (
        // Gap tightens while a department is open, for the same reason its
        // siblings condense: every pixel above the open group pushes its
        // people further down the page.
        <div className={`flex flex-col ${openGroup && !searching ? "gap-2" : "gap-3"}`}>
          {/* Same HubRow accordion as Administration's own hub, one level
              down — a department header behaves exactly like a group row
              (gradient sweep, chevron rotates open) instead of the small
              colour-pill toggle this used to be. */}
          {GROUPS.map(group => {
            const items = buckets[group.label] || [];
            if (items.length === 0) return null;
            const isOpen = isGroupOpen(group.label);
            // Siblings of an open group shrink and drop their description,
            // exactly as the Administration hub's rows do — the point is to
            // keep the open group's people on screen rather than pushed off
            // the bottom by full-height rows above them.
            const isCondensed = !searching && !!openGroup && !isOpen;
            return (
              // No overflow-hidden on this outer card — its rounded corners
              // come from the two children below clipping themselves
              // (header, body), so the body can go overflow-visible once
              // settled without square-cornering the header along with it.
              <div key={group.label} className="bg-white rounded-2xl border border-[#dce4ec] shadow-sm">
                <div className={`overflow-hidden ${isOpen ? "rounded-t-2xl" : "rounded-2xl"}`}>
                  <HubRow
                    section={{
                      label: group.label,
                      desc: `${items.length} ${items.length === 1 ? "person" : "people"}`,
                      icon: Users,
                      gradient: group.gradient,
                    }}
                    onClick={() => toggleGroup(group.label)}
                    open={isOpen}
                    condensed={isCondensed}
                  />
                </div>
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                      onAnimationComplete={() => setSettled(prev => ({ ...prev, [group.label]: true }))}
                      // While searching, groups can render already-open on
                      // mount, where AnimatePresence's initial={false} means
                      // no animation runs and onAnimationComplete never
                      // fires — without this they'd clip their dropdowns
                      // forever.
                      style={{ overflow: searching || settled[group.label] ? "visible" : "hidden" }}
                      className="bg-slate-50 border-t border-[#dce4ec] rounded-b-2xl"
                    >
                      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 p-3.5">
                        {items.map(p => <PersonCard key={p.wrike_user_id} p={p} />)}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
