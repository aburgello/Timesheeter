// The editable list behind Films, Clients, Project descriptions,
// Departments, Job categories and Work categories.
//
// Part of Administration. Split out of components/Management.jsx, which is
// still the entry point and re-exports what other screens import.
import { useState, useEffect, useCallback, useMemo } from "react";
import { Plus, Pencil, Trash2, X, Check, Search, RefreshCw, ChevronLeft, ChevronRight, ArrowUpAZ, ArrowDownAZ, Download } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { confirmAction } from "../../lib/confirm";
import { SEED_CLIENTS, SEED_PROJECT_DESCRIPTIONS } from "../../data/seedData";
import { CATEGORIES } from "../../constants";
import { FilmSyncModal } from "./FilmSyncModal";
import { ROW_ENTER, rowEnterDelay } from "./rowEnter";

// ── Letter avatar colour palette ──────────────────────────────────────────────
const LETTER_PALETTES = [
  ["bg-blue-100 text-blue-700",    "border-blue-200"   ],
  ["bg-violet-100 text-violet-700","border-violet-200" ],
  ["bg-emerald-100 text-emerald-700","border-emerald-200"],
  ["bg-amber-100 text-amber-700",  "border-amber-200"  ],
  ["bg-rose-100 text-rose-700",    "border-rose-200"   ],
  ["bg-cyan-100 text-cyan-700",    "border-cyan-200"   ],
  ["bg-indigo-100 text-indigo-700","border-indigo-200" ],
  ["bg-orange-100 text-orange-700","border-orange-200" ],
  ["bg-teal-100 text-teal-700",    "border-teal-200"   ],
  ["bg-pink-100 text-pink-700",    "border-pink-200"   ],
];
const letterPalette = (l) => {
  const code = (l || "A").toUpperCase().charCodeAt(0);
  return LETTER_PALETTES[Math.abs(code) % LETTER_PALETTES.length];
};
// ── Generic reference-list section ───────────────────────────────────────────
// onItemClick (optional) makes each row's label a button rather than plain
// text — used by Films to open that film's bulk campaign. Left off elsewhere,
// so Clients/Categories/Descriptions stay plain editable lists.
// `renderRowExtra` puts a caller-supplied control on each row, between the
// label and the hover actions — so a list that also carries a value per item
// (a position and its rate) stays one list instead of the same names appearing
// twice on the page. It's handed the item and a patch function that updates
// this component's copy, so the control reflects its own edits without a
// refetch. Flat mode only; grouped rows are too tight for it.
export function SimpleListSection({ table, labelField = "name", label, placeholder, isLong = false, quickFilters = [], quickFilterLabel = "Quick filters", groups = [], wrikeFilmSync = false, onItemClick, renderRowExtra }) {
  const [items, setItems]               = useState([]);
  const [showFilmSync, setShowFilmSync] = useState(false);
  const [loading, setLoading]           = useState(true);
  const [search, setSearch]             = useState("");
  const [sort, setSort]                 = useState("asc");
  const [activeLetter, setLetter]       = useState(null);
  const [activeQuickFilter, setQFilter] = useState(null);
  const [adding, setAdding]             = useState(false);
  const [newVal, setNewVal]             = useState("");
  const [editId, setEditId]             = useState(null);
  const [editVal, setEditVal]           = useState("");
  const [saving, setSaving]             = useState(false);
  const [page, setPage]                 = useState(0);
  const PER_PAGE = isLong ? 60 : 300;

  // Editable group labels (persisted per-table in localStorage)
  const [groupLabels, setGroupLabels] = useState(() => {
    try {
      const saved = localStorage.getItem(`mgmt_grp_labels_${table}`);
      const base  = Object.fromEntries(groups.map(g => [g.label, g.label]));
      return saved ? { ...base, ...JSON.parse(saved) } : base;
    } catch { return Object.fromEntries(groups.map(g => [g.label, g.label])); }
  });
  const [editingGrp, setEditingGrp]       = useState(null);
  const [editingGrpVal, setEditingGrpVal] = useState("");

  // Handed to renderRowExtra so a control can write its own field back into
  // this list's copy of the row. The caller owns persisting it.
  const patchItem = useCallback((id, patch) => {
    setItems(prev => prev.map(it => (it.id === id ? { ...it, ...patch } : it)));
  }, []);

  const saveGroupLabel = (original) => {
    const trimmed = editingGrpVal.trim();
    if (!trimmed) { setEditingGrp(null); return; }
    const next = { ...groupLabels, [original]: trimmed };
    setGroupLabels(next);
    try { localStorage.setItem(`mgmt_grp_labels_${table}`, JSON.stringify(next)); } catch {}
    setEditingGrp(null);
  };

  // Collapsible group sections + per-group "show more" paging (keeps huge lists like
  // Project Descriptions from rendering as one giant scroll)
  const GROUP_PAGE_SIZE = 40;
  const [expandedGroups, setExpandedGroups] = useState({});
  const [groupShowCount, setGroupShowCount] = useState({});
  const toggleGroup = (label) => setExpandedGroups(prev => ({ ...prev, [label]: !prev[label] }));

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from(table).select("*").order(labelField);
    setItems(data || []);
    setLoading(false);
  }, [table, labelField]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(0); }, [search, activeLetter, sort, activeQuickFilter]);

  const add = async () => {
    if (!newVal.trim()) return;
    setSaving(true);
    await supabase.from(table).insert({ [labelField]: newVal.trim() });
    setNewVal(""); setAdding(false);
    await load();
    setSaving(false);
  };

  const saveEdit = async (id) => {
    if (!editVal.trim()) return;
    setSaving(true);
    await supabase.from(table).update({ [labelField]: editVal.trim() }).eq("id", id);
    setEditId(null);
    await load();
    setSaving(false);
  };

  const remove = async (id) => {
    const ok = await confirmAction({
      title: "Delete this item?",
      message: `It will be removed from the ${label.toLowerCase()} list for everyone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    await supabase.from(table).delete().eq("id", id);
    await load();
  };

  const seedData = async (seedArr) => {
    const ok = await confirmAction({
      title: `Seed ${seedArr.length} items?`,
      message: `The starter ${label.toLowerCase()} list will be inserted. Existing entries are left untouched.`,
      confirmLabel: "Seed list",
    });
    if (!ok) return;
    setSaving(true);
    const chunks = [];
    for (let i = 0; i < seedArr.length; i += 100) chunks.push(seedArr.slice(i, i + 100));
    for (const chunk of chunks)
      await supabase.from(table).upsert(chunk.map(v => ({ [labelField]: v })), { onConflict: labelField, ignoreDuplicates: true });
    await load();
    setSaving(false);
  };

  // job_categories uses the same CATEGORIES list used across Tracker / Legacy dropdowns
  const seedMap = { clients: SEED_CLIENTS, job_categories: CATEGORIES, project_descriptions: SEED_PROJECT_DESCRIPTIONS };
  const seedArr = seedMap[table];

  // sorted list
  const sorted = useMemo(() => {
    const arr = [...items];
    arr.sort((a, b) => {
      const av = (a[labelField] || "").toLowerCase();
      const bv = (b[labelField] || "").toLowerCase();
      return sort === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    });
    return arr;
  }, [items, sort, labelField]);

  // available letters from full sorted list
  const availableLetters = useMemo(() => {
    const s = new Set();
    sorted.forEach(it => {
      const c = (it[labelField] || "").charAt(0).toUpperCase();
      if (/[A-Z0-9]/.test(c)) s.add(c);
    });
    return [...s].sort();
  }, [sorted, labelField]);

  // filtered: quick-filter → search → letter
  const filtered = useMemo(() => {
    let arr = sorted;
    if (activeQuickFilter) arr = arr.filter(it => (it[labelField] || "").toLowerCase().includes(activeQuickFilter.toLowerCase()));
    if (search) arr = arr.filter(it => (it[labelField] || "").toLowerCase().includes(search.toLowerCase()));
    if (activeLetter) arr = arr.filter(it => (it[labelField] || "").charAt(0).toUpperCase() === activeLetter);
    return arr;
  }, [sorted, search, activeLetter, activeQuickFilter, labelField]);

  const totalPages = Math.ceil(filtered.length / PER_PAGE);
  const paginated  = filtered.slice(page * PER_PAGE, (page + 1) * PER_PAGE);

  const inputCls = "flex-1 text-sm border border-[#dce4ec] rounded-lg px-3 py-1.5 outline-none focus:border-[#12a0e1] focus:ring-2 focus:ring-[#12a0e1]/20";

  return (
    <div>
      {/* ── Top controls ── */}
      <div className="flex items-center gap-2.5 mb-4 flex-wrap">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#768994]" />
          <input
            value={search}
            onChange={e => { setSearch(e.target.value); setLetter(null); }}
            placeholder={`Search ${label.toLowerCase()}…`}
            className="w-full pl-9 pr-8 py-2.5 text-sm border border-[#dce4ec] rounded-xl outline-none focus:border-[#12a0e1] focus:ring-2 focus:ring-[#12a0e1]/20 bg-white placeholder-[#b0bec5] transition-colors"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-500">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Sort toggle */}
        <button
          onClick={() => setSort(s => s === "asc" ? "desc" : "asc")}
          className="flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-bold text-[#768994] bg-white border border-[#dce4ec] rounded-xl hover:border-slate-300 hover:text-[#122027] transition-[border-color,color] ease-[cubic-bezier(0.16,1,0.3,1)] shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#12a0e1]/40"
          title={sort === "asc" ? "Sorted A → Z" : "Sorted Z → A"}
        >
          {sort === "asc"
            ? <ArrowUpAZ className="w-3.5 h-3.5 text-[#12a0e1]" />
            : <ArrowDownAZ className="w-3.5 h-3.5 text-[#12a0e1]" />}
          {sort === "asc" ? "A → Z" : "Z → A"}
        </button>

        {/* Seed button (only when table is empty) */}
        {seedArr && items.length === 0 && !loading && (
          <button onClick={() => seedData(seedArr)} disabled={saving}
            className="flex items-center gap-1.5 px-3.5 py-2.5 bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold rounded-xl transition-[background-color] ease-[cubic-bezier(0.16,1,0.3,1)] shrink-0 disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${saving ? "animate-spin" : ""}`} />
            Seed ({seedArr.length})
          </button>
        )}

        {/* Sync from Wrike (films only) — pull Project items from a studio folder */}
        {wrikeFilmSync && (
          <button onClick={() => setShowFilmSync(true)}
            title="Pull film projects from a studio folder in Wrike into this list"
            className="flex items-center gap-1.5 px-3.5 py-2.5 bg-[#1cc1a5] hover:bg-[#17a892] text-white text-xs font-bold rounded-xl transition-[background-color] ease-[cubic-bezier(0.16,1,0.3,1)] shrink-0">
            <Download className="w-3.5 h-3.5" /> Sync from Wrike
          </button>
        )}

        {/* Add — the primary action on every one of these lists, so it carries
            real weight: wider, a size up, and the only control here that lifts
            on hover. It previously sat at the same px-3 py-2 text-xs as the
            sort toggle, leaving colour to do all the work of signalling
            "this is the thing you came to do" (and nothing at all for anyone
            who can't separate the blue from the grey). */}
        <button onClick={() => setAdding(a => !a)}
          className={`flex items-center gap-1.5 px-5 py-2.5 text-sm font-bold rounded-xl shrink-0
                      transition-[transform,box-shadow,background-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
            adding
              ? "bg-slate-100 text-[#768994] border border-[#dce4ec]"
              : "bg-[#12a0e1] hover:bg-[#0d8bc4] text-white shadow-sm hover:shadow-[0_6px_16px_-6px_rgba(18,160,225,0.7)] hover:-translate-y-px"
          }`}>
          <Plus className="w-4 h-4" /> Add
        </button>
      </div>

      {wrikeFilmSync && showFilmSync && (
        <FilmSyncModal existingFilms={items.map(i => i[labelField]).filter(Boolean)}
          onClose={() => setShowFilmSync(false)} onApplied={load} />
      )}

      {/* ── Add form ── */}
      {adding && (
        <div className="flex items-center gap-2 mb-4 p-3 bg-[#12a0e1]/5 border border-[#12a0e1]/20 rounded-2xl">
          <input autoFocus value={newVal} onChange={e => setNewVal(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") add(); if (e.key === "Escape") { setAdding(false); setNewVal(""); } }}
            placeholder={placeholder || `New ${label.toLowerCase()}…`}
            className={inputCls}
          />
          <button onClick={add} disabled={saving || !newVal.trim()}
            className="px-3 py-1.5 bg-[#12a0e1] text-white text-xs font-bold rounded-lg disabled:opacity-40 flex items-center gap-1">
            {saving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <><Check className="w-3.5 h-3.5" /> Save</>}
          </button>
          <button onClick={() => { setAdding(false); setNewVal(""); }} className="p-1.5 text-slate-400 hover:text-slate-600">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* ── Quick-filter studio cards ── */}
      {quickFilters.length > 0 && (
        <div className="mb-5 pb-5 border-b border-[#dce4ec]">
          <p className="text-[9px] font-black uppercase tracking-widest text-[#768994] mb-2.5">{quickFilterLabel}</p>
          <div className="flex flex-wrap gap-2">
            {quickFilters.map(qf => {
              const isActive = activeQuickFilter === qf.keyword;
              const count = sorted.filter(it => (it[labelField] || "").toLowerCase().includes(qf.keyword.toLowerCase())).length;
              if (count === 0) return null;
              return (
                <button key={qf.label}
                  onClick={() => { setQFilter(isActive ? null : qf.keyword); setSearch(""); setLetter(null); }}
                  className={`group/chip relative flex flex-col items-start gap-0.5 px-4 py-3 min-w-[72px] rounded-2xl overflow-hidden border transition-[border-color,box-shadow,color] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#12a0e1]/40 ${
                    isActive ? "border-transparent shadow-md text-white" : "border-[#dce4ec] text-[#122027] hover:border-transparent hover:text-white hover:shadow-sm"
                  }`}>
                  {/* gradient fill — faint by default, full on hover/active */}
                  <div className={`absolute inset-0 bg-gradient-to-br ${qf.gradient ?? "from-slate-600 to-slate-800"} transition-opacity duration-200 ${
                    isActive ? "opacity-100" : "opacity-15 group-hover/chip:opacity-100"
                  }`} />
                  <span className="relative z-10 text-[11px] font-black leading-tight whitespace-nowrap">{qf.label}</span>
                  <span className={`relative z-10 text-[9px] font-bold px-1.5 py-0.5 rounded-full transition-colors duration-200 ${
                    isActive ? "bg-white/25 text-white" : "bg-slate-100 text-slate-500 group-hover/chip:bg-white/25 group-hover/chip:text-white"
                  }`}>{count}</span>
                </button>
              );
            })}
            {activeQuickFilter && (
              <button onClick={() => setQFilter(null)}
                className="flex items-center gap-1 self-center px-2 py-1 text-[10px] font-bold text-slate-400 hover:text-rose-500 transition-colors">
                <X className="w-3 h-3" /> Clear
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Alphabet bar (hidden when grouped mode is active) ── */}
      {!search && !activeQuickFilter && !groups.length && availableLetters.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-4 pb-4 border-b border-[#dce4ec]">
          <button onClick={() => setLetter(null)}
            className={`px-2.5 py-1 text-[11px] font-black rounded-lg transition-[background-color,color] ease-[cubic-bezier(0.16,1,0.3,1)] ${
              !activeLetter ? "bg-[#122027] text-white shadow-sm" : "bg-slate-100 text-[#768994] hover:bg-slate-200 hover:text-[#122027]"
            }`}>All</button>
          {availableLetters.map(l => {
            const [bg] = letterPalette(l);
            const isActive = activeLetter === l;
            return (
              <button key={l} onClick={() => setLetter(isActive ? null : l)}
                className={`px-2.5 py-1 text-[11px] font-black rounded-lg transition-[background-color,color] ease-[cubic-bezier(0.16,1,0.3,1)] ${
                  isActive ? `${bg} shadow-sm ring-1 ring-current/30` : "bg-slate-100 text-[#768994] hover:bg-slate-200 hover:text-[#122027]"
                }`}>{l}</button>
            );
          })}
        </div>
      )}

      {/* ── Stats ── */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-[10px] font-black text-[#768994] uppercase tracking-widest">
          {filtered.length} {filtered.length !== items.length ? `of ${items.length} ` : ""}{label.toLowerCase()}
          {activeQuickFilter && <span className="ml-1.5 text-[#12a0e1]">· {quickFilters.find(q => q.keyword === activeQuickFilter)?.label ?? activeQuickFilter}</span>}
          {activeLetter && <span className="ml-1.5 text-[#12a0e1]">· "{activeLetter}"</span>}
        </p>
        {totalPages > 1 && !groups.length && (
          <div className="flex items-center gap-1.5">
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
              className="p-1 disabled:opacity-30 hover:bg-slate-100 rounded-lg text-[#768994]">
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="text-[11px] font-bold text-[#768994]">{page + 1} / {totalPages}</span>
            <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page === totalPages - 1}
              className="p-1 disabled:opacity-30 hover:bg-slate-100 rounded-lg text-[#768994]">
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {groups.length > 0 && !search && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setExpandedGroups(Object.fromEntries(groups.map(g => [g.label, true])))}
              className="text-[10px] font-bold text-[#768994] hover:text-[#12a0e1] px-1.5 py-0.5 rounded transition-colors">
              Expand all
            </button>
            <span className="text-[10px] text-slate-300">·</span>
            <button
              onClick={() => setExpandedGroups({})}
              className="text-[10px] font-bold text-[#768994] hover:text-[#12a0e1] px-1.5 py-0.5 rounded transition-colors">
              Collapse all
            </button>
          </div>
        )}
      </div>

      {/* ── Item rendering ── */}
      {loading ? (
        <div className="flex items-center justify-center py-20 gap-2.5 text-[#768994]">
          <RefreshCw className="w-4 h-4 animate-spin text-[#12a0e1]" />
          <span className="text-sm font-bold">Loading…</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-[#768994]">
          <Search className="w-9 h-9 opacity-20" />
          <p className="font-display text-base font-bold text-[#122027]">No {label.toLowerCase()} found</p>
          <p className="text-xs">Try a different search, or clear the filters above.</p>
        </div>
      ) : groups.length > 0 ? (
        /* ── Grouped mode (first-match-wins) ── */
        (() => {
          // Assign each item to its first matching group only
          const buckets = Object.fromEntries(groups.map(g => [g.label, []]));
          for (const item of filtered) {
            const text  = item[labelField] || "";
            const group = groups.find(g => g.match(text));
            if (group) buckets[group.label].push(item);
          }
          return (
            <div className="space-y-6">
              {groups.map(group => {
                const groupItems  = buckets[group.label] || [];
                if (groupItems.length === 0) return null;
                const displayLabel = groupLabels[group.label] ?? group.label;
                const isOpen      = search ? true : !!expandedGroups[group.label];
                const showCount   = groupShowCount[group.label] || GROUP_PAGE_SIZE;
                const visibleItems = groupItems.slice(0, showCount);
                const remaining    = groupItems.length - visibleItems.length;
                return (
                  <div key={group.label}>
                    {/* Editable, collapsible group header */}
                    <div role="button" tabIndex={0} onClick={() => toggleGroup(group.label)}
                      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") toggleGroup(group.label); }}
                      className={`flex items-center gap-2.5 mb-3 px-3.5 py-2.5 rounded-xl border cursor-pointer select-none transition-colors ${group.color}`}>
                      {editingGrp === group.label ? (
                        <>
                          <input autoFocus value={editingGrpVal} onClick={e => e.stopPropagation()}
                            onChange={e => setEditingGrpVal(e.target.value)}
                            onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") saveGroupLabel(group.label); if (e.key === "Escape") setEditingGrp(null); }}
                            className="text-[11px] font-black uppercase tracking-widest bg-transparent border-b border-current/50 outline-none w-28" />
                          <button onClick={e => { e.stopPropagation(); saveGroupLabel(group.label); }} className="p-0.5 hover:opacity-70">
                            <Check className="w-3 h-3" />
                          </button>
                          <button onClick={e => { e.stopPropagation(); setEditingGrp(null); }} className="p-0.5 hover:opacity-70">
                            <X className="w-3 h-3" />
                          </button>
                        </>
                      ) : (
                        <>
                          <ChevronRight className={`w-3.5 h-3.5 shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                          <span className="text-xs font-black uppercase tracking-[0.14em]">{displayLabel}</span>
                          <span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-black/10 tabular-nums">{groupItems.length}</span>
                          <button onClick={e => { e.stopPropagation(); setEditingGrp(group.label); setEditingGrpVal(displayLabel); }}
                            className="ml-auto p-1 rounded hover:bg-black/10 opacity-40 hover:opacity-100 transition-opacity">
                            <Pencil className="w-2.5 h-2.5" />
                          </button>
                        </>
                      )}
                    </div>
                    {!isOpen ? null : (<>
                    <div className={isLong ? "space-y-2" : "grid grid-cols-2 xl:grid-cols-3 gap-2.5"}>
                      {visibleItems.map((item, i) => {
                        const text        = item[labelField] || "";
                        const displayText = group.stripPrefix ? text.replace(group.stripPrefix, "") : text;
                        const isEditing   = editId === item.id;
                        return (
                          <div key={item.id} style={rowEnterDelay(i)}
                            className={`${ROW_ENTER} group/item flex items-center gap-2.5 px-3.5 py-3 bg-white border rounded-2xl
                                        transition-[transform,box-shadow,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                              isEditing
                                ? "border-[#12a0e1] ring-2 ring-[#12a0e1]/15"
                                : "border-[#dce4ec] hover:border-slate-300 hover:-translate-y-px hover:shadow-[0_6px_18px_-8px_rgba(18,32,39,0.18)]"
                            }`}>
                            {isEditing ? (
                              <>
                                <input autoFocus value={editVal} onChange={e => setEditVal(e.target.value)}
                                  onKeyDown={e => { if (e.key === "Enter") saveEdit(item.id); if (e.key === "Escape") setEditId(null); }}
                                  className={`${inputCls} text-xs`} />
                                <button onClick={() => saveEdit(item.id)} disabled={saving}
                                  className="shrink-0 p-1.5 bg-[#12a0e1] text-white rounded-lg hover:bg-[#0d8bc4] disabled:opacity-40">
                                  <Check className="w-3 h-3" />
                                </button>
                                <button onClick={() => setEditId(null)}
                                  className="shrink-0 p-1 text-slate-400 hover:text-slate-600">
                                  <X className="w-3 h-3" />
                                </button>
                              </>
                            ) : (
                              <>
                                <span className={`flex-1 min-w-0 text-sm font-semibold text-[#122027] ${isLong ? "leading-snug" : "truncate"}`}>{displayText}</span>
                                <div className="flex items-center gap-0.5 opacity-0 group-hover/item:opacity-100 transition-opacity shrink-0">
                                  <button onClick={() => { setEditId(item.id); setEditVal(text); }}
                                    className="p-1 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-[#122027] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#12a0e1]/40">
                                    <Pencil className="w-3 h-3" />
                                  </button>
                                  <button onClick={() => remove(item.id)}
                                    className="p-1 hover:bg-rose-50 rounded-lg text-slate-400 hover:text-rose-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#12a0e1]/40">
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {remaining > 0 && (
                      <button onClick={() => setGroupShowCount(prev => ({ ...prev, [group.label]: showCount + GROUP_PAGE_SIZE }))}
                        className="mt-2 w-full text-center text-[11px] font-bold text-[#12a0e1] hover:text-[#0d8bc4] py-2 rounded-lg hover:bg-[#12a0e1]/5 transition-colors">
                        Show {Math.min(GROUP_PAGE_SIZE, remaining)} more · {remaining} left
                      </button>
                    )}
                    </>)}
                  </div>
                );
              })}
            </div>
          );
        })()
      ) : (
        /* ── Flat mode ── */
        <div className={isLong ? "space-y-2" : "grid grid-cols-2 xl:grid-cols-3 gap-2.5"}>
          {paginated.map((item, i) => {
            const text   = item[labelField] || "";
            const first  = text.charAt(0).toUpperCase() || "?";
            const [avatarCls, borderCls] = letterPalette(first);
            const isEditing = editId === item.id;
            return (
              <div key={item.id} style={rowEnterDelay(i)}
                className={`${ROW_ENTER} group flex items-center gap-3 p-3.5 bg-white border rounded-2xl
                            transition-[transform,box-shadow,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                  isEditing
                    ? "border-[#12a0e1] ring-2 ring-[#12a0e1]/15"
                    : "border-[#dce4ec] hover:border-slate-300 hover:-translate-y-px hover:shadow-[0_6px_18px_-8px_rgba(18,32,39,0.18)]"
                }`}>
                {!isEditing && (
                  <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 font-display text-xs font-black border ${avatarCls} ${borderCls}`}>
                    {first}
                  </div>
                )}
                {isEditing ? (
                  <>
                    <input autoFocus value={editVal} onChange={e => setEditVal(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") saveEdit(item.id); if (e.key === "Escape") setEditId(null); }}
                      className={`${inputCls} text-xs`} />
                    <button onClick={() => saveEdit(item.id)} disabled={saving}
                      className="shrink-0 p-1.5 bg-[#12a0e1] text-white rounded-lg hover:bg-[#0d8bc4] disabled:opacity-40">
                      <Check className="w-3 h-3" />
                    </button>
                    <button onClick={() => setEditId(null)}
                      className="shrink-0 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
                      <X className="w-3 h-3" />
                    </button>
                  </>
                ) : (
                  <>
                    {onItemClick ? (
                      <button
                        onClick={() => onItemClick(text)}
                        title={`Open “${text}”`}
                        className={`flex-1 min-w-0 text-left text-[15px] font-semibold text-[#122027] hover:text-[#12a0e1] transition-colors ${isLong ? "leading-snug" : "truncate"}`}
                      >
                        {text}
                      </button>
                    ) : (
                      <span className={`flex-1 min-w-0 text-[15px] font-semibold text-[#122027] ${isLong ? "leading-snug" : "truncate"}`}>
                        {text}
                      </span>
                    )}
                    {renderRowExtra?.(item, patchItem)}
                    {/* Takes no width until the row is hovered or focused, so
                        whatever sits before it rests against the row's edge. */}
                    <div className="flex items-center gap-0.5 shrink-0 overflow-hidden max-w-0 -ml-3 opacity-0 transition-[max-width,margin,opacity] duration-200 ease-out group-hover:max-w-[4rem] group-hover:ml-0 group-hover:opacity-100 group-focus-within:max-w-[4rem] group-focus-within:ml-0 group-focus-within:opacity-100">
                      <button onClick={() => { setEditId(item.id); setEditVal(text); }}
                        className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-[#122027] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#12a0e1]/40">
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button onClick={() => remove(item.id)}
                        className="p-1.5 hover:bg-rose-50 rounded-lg text-slate-400 hover:text-rose-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#12a0e1]/40">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
