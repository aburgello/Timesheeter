// People: departments, positions and per-person access such as
// Debug Pull.
//
// Part of Administration. Split out of components/Management.jsx, which is
// still the entry point and re-exports what other screens import.
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Users, Pencil, X, Check, Search, RefreshCw } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { isServiceAccount, DEPT_GROUPS } from "../../lib/people";
import { cleanNamePart } from "../../lib/formatName";
import HubRow from "../shared/HubRow";
import { StrictSelect } from "./fields";

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

  const syncFromWrike = async () => {
    if (!localStorage.getItem("wrike_user_id")) { setSyncMsg("Wrike not connected — connect it in Profile → Settings first."); return; }
    setSyncing(true);
    setSyncMsg("");
    try {
      // Fetch contacts and groups in parallel
      const [contactsRes, groupsRes] = await Promise.all([
        fetch("/api/wrike/contacts"),
        fetch("/api/wrike/groups"),
      ]);
      if (!contactsRes.ok) throw new Error(`Wrike contacts error ${contactsRes.status}`);

      const contacts = ((await contactsRes.json()).data || []).filter(c => c.type === "Person" && !c.deleted);

      // Build wrikeUserId → department map from group membership.
      // Match group title against the editable job_departments list
      // (case-insensitive substring).
      const deptMap = {};
      if (groupsRes.ok) {
        const groups = (await groupsRes.json()).data || [];
        for (const group of groups) {
          const title = group.title || "";
          const dept = departments.find(d =>
            title.toLowerCase() === d.toLowerCase() ||
            title.toLowerCase().includes(d.toLowerCase()) ||
            d.toLowerCase().includes(title.toLowerCase())
          );
          if (dept) {
            for (const memberId of (group.memberIds || [])) deptMap[memberId] = dept;
          }
        }
      }

      // Which people we already hold a name for. This sync exists to ADD people
      // and keep contact details fresh, not to re-impose Wrike's spelling — a
      // name tidied up here (Wrike is where "Trott ⚡️" and dropped surnames
      // come from) must survive the next run.
      const { data: existingRows } = await supabase
        .from("profiles")
        .select("wrike_user_id, first_name, last_name");
      const alreadyNamed = new Set(
        (existingRows || [])
          .filter((r) => r.first_name || r.last_name)
          .map((r) => r.wrike_user_id)
      );

      let added = 0;
      let keptNames = 0;
      for (const c of contacts) {
        const payload = {
          wrike_user_id: c.id,
          email: c.profiles?.[0]?.email || null,
          avatar_url: c.avatarUrl || null,
        };
        if (alreadyNamed.has(c.id)) {
          keptNames++;
        } else {
          payload.first_name = c.firstName || null;
          payload.last_name = c.lastName || null;
        }
        // Only overwrite department when Wrike groups give us a clear answer
        if (deptMap[c.id]) payload.department = deptMap[c.id];
        const { error } = await supabase.from("profiles").upsert(payload, { onConflict: "wrike_user_id" });
        if (!error) added++;
      }
      const deptCount = Object.keys(deptMap).length;
      setSyncMsg(
        `Synced ${added} members · ${deptCount} department assignments from Wrike groups.` +
          (keptNames ? ` Kept ${keptNames} existing name${keptNames === 1 ? "" : "s"}.` : "")
      );
      await load();
    } catch (err) {
      setSyncMsg(`Sync failed: ${err.message}`);
    } finally {
      setSyncing(false);
    }
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
    const out = Object.fromEntries(DEPT_GROUPS.map(g => [g.label, []]));
    for (const p of filteredPeople) {
      const key = p.department && DEPT_GROUPS.some(g => g.label === p.department) ? p.department : "—";
      out[key].push(p);
    }
    return out;
  }, [filteredPeople]);

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
              {search.trim() ? `${filteredPeople.length} of ${people.length}` : people.length} people
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
          {DEPT_GROUPS.map(group => {
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
