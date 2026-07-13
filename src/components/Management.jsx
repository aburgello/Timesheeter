import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Briefcase, Film, Users, Tag, AlignLeft, Building2,
  Plus, Pencil, Trash2, X, Check, Search,
  RefreshCw, Shield, AlertTriangle, ChevronLeft, ChevronRight,
  ArrowUpAZ, ArrowDownAZ, CheckCircle2, UserCog,
  FolderPlus, Folder, FolderOpen, Sparkles, Loader2,
  FileBarChart, ClipboardList, Globe, Layers, Download, Network, TrendingUp,
} from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { confirmAction } from "../lib/confirm";
import { notify } from "../lib/toast";
import { isServiceAccount, DEPT_GROUPS } from "../lib/people";
import { SEED_CLIENTS, SEED_PROJECT_DESCRIPTIONS } from "../data/seedData";
import { DEFAULT_JOBS, CATEGORIES } from "../constants";
import { fullName as cleanFullName, cleanNamePart } from "../lib/formatName";
import PageHeader from "./shared/PageHeader";
import HubRow from "./shared/HubRow";
import DateField from "./shared/DateField";
import OrgChart from "./OrgChart";
import StudioAnalytics from "./StudioAnalytics";

// Film titles extracted from DEFAULT_JOBS (everything before " : XY")
const SEED_FILMS = [...new Set(
  DEFAULT_JOBS.map(j => j.split(" : ")[0]?.trim()).filter(f => f && !f.startsWith("XYi "))
)].sort();

// Access control lives in lib/access.js (App and the Rail read it at startup;
// importing it from this lazy-loaded chunk would drag Administration into the
// main bundle). Re-exported here for compatibility.
export { MANAGEMENT_IDS } from "../lib/access";
import { MANAGEMENT_IDS } from "../lib/access";

const OFFICES = ["LDN", "LA"];
const PRINT_DIGITAL = ["Digital", "Print", "Both"];

// Jobs (Setup / Book / Feed) deliberately live on the standalone Job Book
// page now (JobBook.jsx) — Administration keeps Reports, Staff Accounts, and
// the reference-data lists, matching the PMs' mental model.
//
// Navigation is a two-level drill-down (group -> item), the same HubRow
// idiom Profile Hub uses, instead of an 11-wide tab bar. One decision at a
// time, in a shape a manager already knows from the rest of the app — that
// consistency is the whole point of this structure, not a tab count problem.
const NAV_GROUPS = [
  {
    id: "reports",
    label: "Reports",
    desc: "Logged time by job, and who still needs to submit",
    icon: FileBarChart,
    gradient: "from-[#122027] to-[#12a0e1]",
    items: [
      { id: "project-time", label: "Project/Time", icon: FileBarChart, desc: "Every logged hour, grouped by job" },
      { id: "studio-analytics", label: "Studio Analytics", icon: TrendingUp, desc: "Throughput, workload, overdue & hours — charted" },
      { id: "timesheet-completion", label: "Timesheet Completion", icon: ClipboardList, desc: "Who hasn't submitted for the week", soon: true },
    ],
  },
  {
    id: "staff",
    label: "Staff Accounts",
    desc: "People, their positions & department access",
    icon: Users,
    gradient: "from-teal-500 to-[#1cc1a5]",
    items: [
      { id: "people", label: "People", icon: Users, desc: "Everyone's role, position & department" },
      { id: "positions", label: "Positions", icon: UserCog, desc: "Job titles used across the team" },
    ],
  },
  {
    id: "supporting",
    label: "Supporting Content",
    desc: "Films, clients, descriptions, categories, countries & departments",
    icon: Layers,
    gradient: "from-violet-500 to-purple-600",
    items: [
      { id: "films", label: "Films", icon: Film, desc: "Every film in production" },
      { id: "clients", label: "Clients", icon: Building2, desc: "Studios and companies you work with" },
      { id: "descs", label: "Project Type Descriptions", icon: AlignLeft, desc: "The project types that follow each job number" },
      { id: "categories", label: "Item Categories", icon: Tag, desc: "Work item categories used on jobs" },
      { id: "translations", label: "Translation Countries", icon: Globe, desc: "Countries available for translation work" },
      { id: "departments", label: "Departments", icon: Layers, desc: "The department list used across the app" },
    ],
  },
  {
    id: "orgchart-group",
    label: "Org Chart",
    desc: "Company structure & reporting lines",
    icon: Network,
    gradient: "from-indigo-600 to-slate-800",
    items: [
      { id: "orgchart", label: "Org Chart", icon: Network, desc: "Who reports to whom, across the whole company" },
    ],
  },
];

function findNavItem(id) {
  for (const group of NAV_GROUPS) {
    const item = group.items.find((i) => i.id === id);
    if (item) return { group, item };
  }
  return null;
}

// ── Project Description quick-filter chips ────────────────────────────────────
// keyword uses "<CODE> " (with trailing space) so "UK Something" matches but
// hypothetical "BULK" wouldn't. Gradients mirror DESCRIPTION_GROUPS.
const DESC_QUICK_FILTERS = [
  { label: "AUS", keyword: "AUS ", gradient: "from-green-500 to-emerald-600"   },
  { label: "UK",  keyword: "UK ",  gradient: "from-blue-500 to-blue-700"       },
  { label: "DOM", keyword: "DOM ", gradient: "from-amber-400 to-orange-500"    },
  { label: "INT", keyword: "INT ", gradient: "from-violet-500 to-violet-700"   },
  { label: "IRE", keyword: "IRE ", gradient: "from-emerald-400 to-teal-600"    },
  { label: "XYi", keyword: "XYi ", gradient: "from-[#12a0e1] to-[#0872a0]"   },
];

// ── Studio quick-filter groups (for Clients tab) ──────────────────────────────
const STUDIO_GROUPS = [
  { label: "Universal", keyword: "Universal", gradient: "from-blue-500 to-indigo-700"   },
  { label: "Paramount", keyword: "Paramount", gradient: "from-sky-400 to-blue-700"      },
  { label: "Sony",      keyword: "Sony",      gradient: "from-slate-600 to-slate-900"   },
  { label: "Disney",    keyword: "Disney",    gradient: "from-blue-400 to-violet-700"   },
  { label: "Warner",    keyword: "Warner",    gradient: "from-cyan-500 to-blue-700"     },
  { label: "Netflix",   keyword: "Netflix",   gradient: "from-red-500 to-red-800"       },
  { label: "Apple",     keyword: "Apple",     gradient: "from-slate-400 to-slate-700"   },
  { label: "Amazon",    keyword: "Amazon",    gradient: "from-amber-400 to-orange-600"  },
  { label: "XYi",      keyword: "XYi",       gradient: "from-[#12a0e1] to-[#0872a0]"  },
];

// ── Category groups ────────────────────────────────────────────────────────────
// Prefix match is first-wins — Misc catches only what Digital/Print/XYi don't.
const CATEGORY_GROUPS = [
  {
    label: "Digital",
    color: "bg-cyan-50 text-cyan-700 border-cyan-200",
    gradient: "from-cyan-500 to-sky-600",
    match: s => s.startsWith("Digital"),
    stripPrefix: "Digital - ",
  },
  {
    label: "Print",
    color: "bg-orange-50 text-orange-700 border-orange-200",
    gradient: "from-orange-400 to-orange-600",
    match: s => s.startsWith("Print"),
    stripPrefix: "Print - ",
  },
  {
    label: "XYi",
    color: "bg-violet-50 text-violet-700 border-violet-200",
    gradient: "from-violet-500 to-violet-700",
    match: s => s.startsWith("XYi"),
    stripPrefix: "XYi - ",
  },
  {
    label: "Misc",
    color: "bg-slate-50 text-slate-600 border-slate-200",
    gradient: "from-slate-500 to-slate-700",
    match: () => true,
    stripPrefix: "",
  },
];

// ── Project Description groups (territory prefix) ─────────────────────────────
const DESCRIPTION_GROUPS = [
  { label: "AUS", color: "bg-green-50 text-green-700 border-green-200",       gradient: "from-green-500 to-emerald-600",  match: s => /^AUS[\s\-]/i.test(s),  stripPrefix: "" },
  { label: "UK",  color: "bg-blue-50 text-blue-700 border-blue-200",          gradient: "from-blue-500 to-blue-700",       match: s => /^UK[\s\-]/i.test(s),   stripPrefix: "" },
  { label: "DOM", color: "bg-amber-50 text-amber-700 border-amber-200",       gradient: "from-amber-400 to-orange-500",    match: s => /^DOM[\s\-]/i.test(s),  stripPrefix: "" },
  { label: "INT", color: "bg-violet-50 text-violet-700 border-violet-200",    gradient: "from-violet-500 to-violet-700",   match: s => /^INT[\s\-]/i.test(s),  stripPrefix: "" },
  { label: "IRE", color: "bg-emerald-50 text-emerald-700 border-emerald-200", gradient: "from-emerald-400 to-teal-600",    match: s => /^IRE[\s\-]/i.test(s),  stripPrefix: "" },
  { label: "XYi", color: "bg-cyan-50 text-cyan-700 border-cyan-200",         gradient: "from-[#12a0e1] to-[#0872a0]",    match: s => /^XYi[\s\-]/i.test(s),  stripPrefix: "" },
  { label: "Other", color: "bg-slate-50 text-slate-600 border-slate-200",    gradient: "from-slate-500 to-slate-700",     match: () => true,                   stripPrefix: "" },
];

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
function SimpleListSection({ table, labelField = "name", label, placeholder, isLong = false, quickFilters = [], quickFilterLabel = "Quick filters", groups = [] }) {
  const [items, setItems]               = useState([]);
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
  const seedMap = { films: SEED_FILMS, clients: SEED_CLIENTS, job_categories: CATEGORIES, project_descriptions: SEED_PROJECT_DESCRIPTIONS };
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
            className="w-full pl-9 pr-8 py-2 text-sm border border-[#dce4ec] rounded-xl outline-none focus:border-[#12a0e1] focus:ring-2 focus:ring-[#12a0e1]/20 bg-white"
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
          className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-[#768994] bg-white border border-[#dce4ec] rounded-xl hover:border-slate-300 hover:text-[#122027] transition-all shrink-0"
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
            className="flex items-center gap-1.5 px-3 py-2 bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold rounded-xl transition-all shrink-0 disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${saving ? "animate-spin" : ""}`} />
            Seed ({seedArr.length})
          </button>
        )}

        {/* Add */}
        <button onClick={() => setAdding(a => !a)}
          className={`flex items-center gap-1.5 px-3 py-2 text-xs font-bold rounded-xl transition-all shrink-0 ${
            adding ? "bg-slate-100 text-[#768994] border border-[#dce4ec]" : "bg-[#12a0e1] hover:bg-[#0d8bc4] text-white"
          }`}>
          <Plus className="w-3.5 h-3.5" /> Add
        </button>
      </div>

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
                  className={`group/chip relative flex flex-col items-start gap-0.5 px-4 py-3 min-w-[72px] rounded-2xl overflow-hidden border transition-all duration-200 ${
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
            className={`px-2.5 py-1 text-[11px] font-black rounded-lg transition-all ${
              !activeLetter ? "bg-[#122027] text-white shadow-sm" : "bg-slate-100 text-[#768994] hover:bg-slate-200 hover:text-[#122027]"
            }`}>All</button>
          {availableLetters.map(l => {
            const [bg] = letterPalette(l);
            const isActive = activeLetter === l;
            return (
              <button key={l} onClick={() => setLetter(isActive ? null : l)}
                className={`px-2.5 py-1 text-[11px] font-black rounded-lg transition-all ${
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
        <div className="flex items-center justify-center py-16 gap-2 text-[#768994]">
          <RefreshCw className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-2 text-[#768994]">
          <Search className="w-8 h-8 opacity-20" />
          <p className="text-sm font-medium">No {label.toLowerCase()} found</p>
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
                      className={`flex items-center gap-2.5 mb-3 px-3 py-2 rounded-xl border cursor-pointer select-none ${group.color}`}>
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
                          <span className="text-[11px] font-black uppercase tracking-widest">{displayLabel}</span>
                          <span className="text-[10px] font-black px-1.5 py-0.5 rounded-full bg-black/10">{groupItems.length}</span>
                          <button onClick={e => { e.stopPropagation(); setEditingGrp(group.label); setEditingGrpVal(displayLabel); }}
                            className="ml-auto p-1 rounded hover:bg-black/10 opacity-40 hover:opacity-100 transition-opacity">
                            <Pencil className="w-2.5 h-2.5" />
                          </button>
                        </>
                      )}
                    </div>
                    {!isOpen ? null : (<>
                    <div className={isLong ? "space-y-1.5" : "grid grid-cols-2 xl:grid-cols-3 gap-2"}>
                      {visibleItems.map(item => {
                        const text        = item[labelField] || "";
                        const displayText = group.stripPrefix ? text.replace(group.stripPrefix, "") : text;
                        const isEditing   = editId === item.id;
                        return (
                          <div key={item.id}
                            className={`group/item flex items-center gap-2.5 px-3 py-2.5 bg-white border rounded-xl hover:shadow-sm transition-all ${
                              isEditing ? "border-[#12a0e1] ring-2 ring-[#12a0e1]/15" : "border-[#dce4ec] hover:border-slate-300"
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
                                <span className={`flex-1 min-w-0 text-xs font-medium text-[#122027] ${isLong ? "leading-snug" : "truncate"}`}>{displayText}</span>
                                <div className="flex items-center gap-0.5 opacity-0 group-hover/item:opacity-100 transition-opacity shrink-0">
                                  <button onClick={() => { setEditId(item.id); setEditVal(text); }}
                                    className="p-1 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-[#122027]">
                                    <Pencil className="w-3 h-3" />
                                  </button>
                                  <button onClick={() => remove(item.id)}
                                    className="p-1 hover:bg-rose-50 rounded-lg text-slate-400 hover:text-rose-500">
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
        <div className={isLong ? "space-y-1.5" : "grid grid-cols-2 xl:grid-cols-3 gap-2"}>
          {paginated.map(item => {
            const text   = item[labelField] || "";
            const first  = text.charAt(0).toUpperCase() || "?";
            const [avatarCls, borderCls] = letterPalette(first);
            const isEditing = editId === item.id;
            return (
              <div key={item.id}
                className={`group flex items-center gap-3 p-3 bg-white border rounded-2xl hover:shadow-sm transition-all ${
                  isEditing ? "border-[#12a0e1] ring-2 ring-[#12a0e1]/15" : "border-[#dce4ec] hover:border-slate-300"
                }`}>
                {!isEditing && (
                  <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 text-[11px] font-black border ${avatarCls} ${borderCls}`}>
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
                    <span className={`flex-1 min-w-0 text-sm font-medium text-[#122027] ${isLong ? "leading-snug" : "truncate"}`}>
                      {text}
                    </span>
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      <button onClick={() => { setEditId(item.id); setEditVal(text); }}
                        className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-[#122027]">
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button onClick={() => remove(item.id)}
                        className="p-1.5 hover:bg-rose-50 rounded-lg text-slate-400 hover:text-rose-500">
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

// ── Modal field sub-components — defined at module level so React never
//    remounts them mid-keystroke (defining inside a component = new type each render).
const MODAL_INPUT = "w-full border border-[#dce4ec] rounded-2xl px-4 py-2.5 text-sm text-[#122027] outline-none focus:border-[#12a0e1] focus:ring-2 focus:ring-[#12a0e1]/15 bg-white placeholder-[#b0bec5] transition-all";

function FieldLabel({ text, required }) {
  return (
    <p className="text-[10px] font-black uppercase tracking-widest text-[#768994] mb-1.5">
      {text}{required && <span className="text-rose-400 ml-0.5">*</span>}
    </p>
  );
}

// ── Combobox grouping helpers ─────────────────────────────────────────────────
// Filtering used to live in loud gradient chips above each field, which clashed
// with the form. Instead we fold it into the dropdown: options group under
// sticky headers (same idiom as Tracker/Legacy's SearchableSelect), so scanning
// by territory/studio/type is a property of the list, not extra chrome.
const afterDash = (s) => { const i = s.indexOf(" - "); return i >= 0 ? s.slice(i + 3) : s; };
// "Digital - Production" → "Digital"; "AUS - Foo" → "AUS"; else a bucket.
const prefixGroup = (s) => {
  const i = s.indexOf(" - ");
  if (i >= 0) return s.slice(0, i);
  return s.startsWith("XYi") ? "XYi" : "Other";
};

// Project descriptions lead with a territory token but separate it with a SPACE
// as often as a dash ("UK Titles", "AUS - DOOH", "XYi Internal"), so split on the
// leading token itself rather than a fixed " - " delimiter.
const DESC_PREFIXES = ["AUS", "UK", "DOM", "INT", "IRE", "XYi"];
const descGroup = (s) => {
  for (const p of DESC_PREFIXES) if (new RegExp(`^${p}[\\s\\-]`, "i").test(s)) return p;
  return "Other";
};
const descLabel = (s) => {
  for (const p of DESC_PREFIXES) {
    const m = s.match(new RegExp(`^${p}[\\s\\-]+`, "i"));
    if (m) return s.slice(m[0].length);
  }
  return s;
};
const STUDIO_KEYS = ["Universal", "Paramount", "Sony", "Disney", "Warner"];
const studioGroup = (s) => {
  const u = s.toLowerCase();
  for (const k of STUDIO_KEYS) if (u.includes(k.toLowerCase())) return k;
  return u.includes("xyi") ? "XYi" : "Other";
};

// Group orders double as the dropdown's quick-filter chips — most-used buckets
// first so the common picks (Universal/Paramount, Digital/Print) are one tap in.
const CLIENT_GROUP_ORDER = ["Universal", "Paramount", "Sony", "Disney", "Warner", "XYi"];
// Exactly the two busiest desks per studio — "<Studio> Pictures International"
// then "…UK" — floated to the top of their group. Anchored to the end so
// "NBCUniversal International Ltd" and "Universal Pictures BAFTA - UK" don't match.
const CLIENT_PIN_RANK = (name) => {
  if (/ Pictures International$/i.test(name)) return 0;
  if (/ Pictures UK$/i.test(name) || /^Paramount UK$/i.test(name)) return 1;
  return 999;
};
const DESC_GROUP_ORDER = ["AUS", "UK", "DOM", "INT", "IRE", "XYi"];
const CAT_GROUP_ORDER = ["Digital", "Print", "XYi"];

// Searchable combobox. Free text is allowed (type a new value); selection uses
// onMouseDown so it commits before the input's onBlur closes the list.
//   groupBy      — bucket the dropdown under sticky headers
//   formatOption — shorten each row's label (e.g. drop the prefix it sits under)
//   groupOrder   — priority order for groups (Digital/Print before the rest);
//                  also drives the quick-filter chip bar at the top of the list,
//                  so the common buckets are one tap away without loud chips
//                  cluttering the form body.
function ComboField({ label, value, onChange, options, placeholder, required, groupBy = null, formatOption = null, groupOrder = null, pinRankFn = null }) {
  const [q, setQ] = useState(value);
  const [open, setOpen] = useState(false);
  const [activeGroup, setActiveGroup] = useState(null);

  // Sync display value when parent sets it externally (e.g. opening edit modal)
  useEffect(() => { setQ(value ?? ""); }, [value]);

  const hits = useMemo(() => {
    let list = options;
    if (q) list = list.filter(o => o.toLowerCase().includes(q.toLowerCase()));
    // Filter to the picked group BEFORE capping — otherwise a group that sorts
    // late in the alphabet (UK, XYi) can be entirely cut by the slice and the
    // chip would show nothing even though matches exist.
    if (activeGroup && groupBy) list = list.filter(o => (groupBy(o) || "Other") === activeGroup);
    return list.slice(0, 200);
  }, [options, q, activeGroup, groupBy]);

  const groups = useMemo(() => {
    if (!groupBy) return null;
    const m = new Map();
    for (const o of hits) {
      const g = groupBy(o) || "Other";
      if (!m.has(g)) m.set(g, []);
      m.get(g).push(o);
    }
    let entries = [...m.entries()];
    // Float pinned entries to the top of their group; the rest keep their order.
    if (pinRankFn) entries.forEach(([, items]) => items.sort((a, b) => pinRankFn(a) - pinRankFn(b)));
    if (groupOrder) {
      const rank = (g) => { const i = groupOrder.indexOf(g); return i === -1 ? groupOrder.length + 1 : i; };
      entries.sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
    }
    return entries;
  }, [hits, groupBy, groupOrder, pinRankFn]);

  const disp = (o) => (formatOption ? formatOption(o) : o);
  const isPinned = (o) => !!pinRankFn && pinRankFn(o) < 999;
  const pick = (o) => { onChange(o); setQ(o); setOpen(false); setActiveGroup(null); };
  const rowCls = (o) => {
    const sel = o === value;
    const pinned = isPinned(o);
    return `flex items-center text-left px-3 py-2 text-xs rounded-lg transition-colors ${
      sel ? "bg-[#10b981]/15 text-[#0f766e] font-bold"
        : pinned ? "bg-[#f0fbf7] text-[#0f766e] font-semibold hover:bg-[#e4f7ef]"
          : "text-[#33454f] hover:bg-slate-50"
    }`;
  };

  return (
    <div>
      <FieldLabel text={label} required={required} />
      <div className="relative">
        <input value={q}
          onChange={e => { setQ(e.target.value); onChange(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          placeholder={placeholder || "Search or type…"}
          className={MODAL_INPUT} />
        {open && hits.length > 0 && (
          <div className="absolute z-[100] left-0 right-0 mt-1.5 bg-white border border-[#dce4ec] rounded-2xl shadow-2xl max-h-72 overflow-y-auto">
            {groupOrder && (
              <div className="flex flex-wrap gap-1.5 p-2 border-b border-[#eef2f6] sticky top-0 bg-white z-20">
                {groupOrder.map(g => {
                  const on = activeGroup === g;
                  return (
                    <button key={g} type="button"
                      onMouseDown={e => { e.preventDefault(); setActiveGroup(on ? null : g); }}
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition-colors ${
                        on ? "bg-[#10b981] border-[#10b981] text-white"
                          : "bg-white border-[#dce4ec] text-[#768994] hover:border-[#10b981] hover:text-[#0d9488]"
                      }`}>{g}</button>
                  );
                })}
                {activeGroup && (
                  <button type="button" onMouseDown={e => { e.preventDefault(); setActiveGroup(null); }}
                    className="px-1.5 py-1 text-[10px] font-bold text-slate-400 hover:text-rose-500 transition-colors">Clear</button>
                )}
              </div>
            )}
            <div className="p-1.5">
              {groups ? groups.map(([g, items]) => (
                <div key={g} className="mb-1.5 last:mb-0">
                  <div className="px-2.5 py-1 text-[10px] font-black uppercase tracking-widest text-[#0d9488] bg-[#f4faf8] rounded-lg">{g}</div>
                  <div className="grid grid-cols-2 gap-1 mt-1">
                    {items.map(o => (
                      <button key={o} type="button" onMouseDown={e => { e.preventDefault(); pick(o); }}
                        className={rowCls(o)} title={o}>
                        {isPinned(o) && <span className="w-1.5 h-1.5 rounded-full bg-[#10b981] shrink-0 mr-2" />}
                        <span className="truncate">{disp(o)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )) : (
                <div className="grid grid-cols-2 gap-1">
                  {hits.map(o => (
                    <button key={o} type="button" onMouseDown={e => { e.preventDefault(); pick(o); }}
                      className={rowCls(o)} title={o}>
                      {isPinned(o) && <span className="w-1.5 h-1.5 rounded-full bg-[#10b981] shrink-0 mr-2" />}
                      <span className="truncate">{disp(o)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Searchable, selection-only dropdown — same visual language as ComboField's
// popup, but you can't commit free text, only pick an existing option. Use
// for pickers whose values must reference an existing row (e.g. Film Setup's
// film picker), as opposed to ComboField which lets you introduce new values.
function StrictSelect({ value, onChange, options, placeholder, loading, className = "" }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const btnRef = useRef(null);

  const hits = useMemo(() => {
    if (!q) return options.slice(0, 60);
    return options.filter(o => o.toLowerCase().includes(q.toLowerCase())).slice(0, 60);
  }, [options, q]);

  const toggle = () => {
    if (!open) setRect(btnRef.current.getBoundingClientRect());
    setOpen(o => !o);
  };

  // The panel is portaled to <body> and positioned from the button's own
  // rect, rather than CSS-nested `absolute` inside whatever card/accordion
  // it happens to sit in — nesting meant it inherited that ancestor's
  // clipping and paint order, so once a card was tall enough (or another
  // card sat right below it) the open panel could render clipped or
  // behind the next sibling instead of on top of everything, regardless
  // of its own z-index. Keep the rect in sync while open so scrolling the
  // page doesn't leave it stranded over the wrong spot.
  useEffect(() => {
    if (!open) return;
    const reposition = () => setRect(btnRef.current.getBoundingClientRect());
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open]);

  return (
    <div className={className}>
      <button ref={btnRef} type="button" disabled={loading}
        onClick={toggle}
        className="w-full flex items-center justify-between gap-2 border border-[#dce4ec] rounded-xl px-3 py-2.5 text-sm font-bold text-[#122027] outline-none focus:border-[#12a0e1] bg-white disabled:opacity-50 transition-colors hover:border-[#12a0e1]">
        <span className={`min-w-0 truncate ${value ? "" : "text-[#b0bec5] font-medium"}`}>
          {loading ? "Loading…" : (value || placeholder || "Select…")}
        </span>
        <ChevronRight className={`w-3.5 h-3.5 text-[#768994] shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && rect && createPortal(
        <>
          <div className="fixed inset-0 z-[9998]" onClick={() => setOpen(false)} />
          <div
            className="fixed z-[9999] bg-white border border-[#dce4ec] rounded-2xl shadow-2xl overflow-hidden"
            style={{ top: rect.bottom + 6, left: rect.left, width: rect.width }}
          >
            <div className="p-2 border-b border-[#dce4ec]/60">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#b0bec5]" />
                <input autoFocus value={q} onChange={e => setQ(e.target.value)}
                  placeholder="Search…"
                  className="w-full pl-8 pr-2 py-1.5 text-sm text-[#122027] outline-none bg-slate-50 rounded-xl" />
              </div>
            </div>
            <div className="max-h-52 overflow-y-auto">
              {hits.length === 0 && <p className="px-4 py-3 text-sm text-[#b0bec5]">No matches</p>}
              {hits.map(o => (
                <button key={o} type="button"
                  onClick={() => { onChange(o); setQ(""); setOpen(false); }}
                  className={`w-full text-left px-4 py-2.5 text-sm border-b border-[#dce4ec]/60 last:border-0 transition-colors ${
                    o === value ? "bg-[#12a0e1]/10 text-[#12a0e1] font-bold" : "text-[#122027] hover:bg-slate-50"
                  }`}>
                  {o}
                </button>
              ))}
            </div>
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

function PillField({ label, value, onChange, options, colorMap }) {
  return (
    <div>
      <FieldLabel text={label} />
      <div className="flex flex-wrap gap-1.5">
        {options.map(o => {
          const active = value === o;
          const activeColor = colorMap?.[o] || "bg-[#122027] border-[#122027]";
          return (
            <button key={o} type="button" onClick={() => onChange(o)}
              className={`px-3.5 py-2 rounded-xl text-xs font-bold border transition-all ${
                active
                  ? `${activeColor} text-white shadow-sm`
                  : "bg-white text-[#768994] border-[#dce4ec] hover:border-slate-300 hover:text-[#122027]"
              }`}>
              {o}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const PD_COLOR_MAP = { Digital: "bg-cyan-600 border-cyan-600", Print: "bg-orange-500 border-orange-500", Both: "bg-violet-600 border-violet-600" };
const JOB_STATUSES = ["Inactive", "Active", "Closed"];
const STATUS_COLOR_MAP = { Inactive: "bg-slate-400 border-slate-400", Active: "bg-[#12a0e1] border-[#12a0e1]", Closed: "bg-[#1cc1a5] border-[#1cc1a5]" };
const STATUS_BADGE = { Inactive: "bg-slate-100 text-slate-500", Active: "bg-[#12a0e1]/10 text-[#12a0e1]", Closed: "bg-[#1cc1a5]/10 text-[#1cc1a5]" };

// ── Job Form ───────────────────────────────────────────────────────────────────
// Fields + footer for creating/editing a Job Book row. Shared by JobModal (edit,
// from Job Book) and the Custom Job tab in Jobs Setup (create) — same form,
// different chrome around it (layout="modal" adds the fixed-footer/scroll
// behaviour a popup needs; layout="inline" just flows in the page).
function JobForm({ job, clients, films, categories, descs, onSave, onCancel, saving, submitLabel, layout = "modal" }) {
  const isEdit = !!job?.id;
  const [orderedByOpts, setOrderedByOpts] = useState([]);
  const [billedToOpts, setBilledToOpts]   = useState([]);
  const [nextCode, setNextCode] = useState(null); // e.g. "XY025999" — allocated once when creating a new job

  useEffect(() => {
    supabase.from("jobs")
      .select("ordered_by, billed_to")
      .not("ordered_by", "is", null)
      .neq("ordered_by", "")
      .then(({ data }) => {
        if (!data) return;
        setOrderedByOpts([...new Set(data.map(r => r.ordered_by).filter(Boolean))].sort());
        setBilledToOpts([...new Set(data.map(r => r.billed_to).filter(Boolean))].sort());
      });
  }, []);

  // New jobs get the next sequential XY code auto-allocated, same source of truth
  // (max across jobs + tasks) as the Bulk Campaign flow — never manually typed.
  useEffect(() => {
    if (isEdit) return;
    Promise.all([
      supabase.from("jobs").select("job_number"),
      supabase.from("tasks").select("job_number"),
    ]).then(([{ data: jobRows }, { data: taskRows }]) => {
      let maxNum = 0;
      [...(jobRows || []), ...(taskRows || [])].forEach(r => {
        const m = (r.job_number || "").match(/XY(\d+)/);
        if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
      });
      setNextCode(`XY${String(maxNum + 1).padStart(6, "0")}`);
    });
  }, [isEdit]);

  const [form, setForm] = useState({
    job_number: job?.job_number || "",
    start_date: job?.start_date ? job.start_date.slice(0, 10) : new Date().toISOString().slice(0, 10),
    client: job?.client || "",
    film_title: job?.film_title || "",
    office: job?.office || "LDN",
    print_digital: job?.print_digital || "Digital",
    project_description: job?.project_description || "",
    job_work_category: job?.job_work_category || "",
    ordered_by: job?.ordered_by || "",
    billed_to: job?.billed_to || "",
    fixed_cost: job?.fixed_cost ?? "",
    third_party_cost: job?.third_party_cost ?? "",
    estimated_cost: job?.estimated_cost ?? "",
    completed_date: job?.completed_date ? job.completed_date.slice(0, 10) : "",
    job_done: job?.job_done || false,
    status: job?.status || (isEdit ? "Inactive" : "Active"),
    notes: job?.notes || "",
  });

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  // Create tucks billing/admin fields behind a disclosure; edit shows them open.
  const [showAdmin, setShowAdmin] = useState(isEdit);
  const bodyClass = layout === "modal" ? "overflow-y-auto flex-1 px-6 py-5 space-y-6" : "space-y-6";
  const footerClass = layout === "modal"
    ? "px-6 py-4 border-t border-[#dce4ec] flex items-center justify-end gap-2 shrink-0"
    : "mt-3 pt-6 border-t border-[#dce4ec] flex items-center justify-end gap-2";

  // Live preview: "Film Title : XY025999, Project Description" — updates as you type
  const livePreview = useMemo(() => {
    if (!nextCode) return "";
    const film = form.film_title.trim();
    const desc = form.project_description.trim();
    let s = film ? `${film} : ${nextCode}` : nextCode;
    if (desc) s += `, ${desc}`;
    return s;
  }, [nextCode, form.film_title, form.project_description]);

  const canSave = isEdit
    ? form.job_number.trim() && form.client && form.start_date
    : nextCode && form.client && form.start_date;

  const handleSave = () => onSave(isEdit ? form : { ...form, job_number: livePreview });

  return (
    <>
      <div className={bodyClass}>
        {/* Hero — the assembling job label is the one thing this form exists to
            produce, so it leads instead of sitting muted at the top. */}
        <div>
          <FieldLabel text="Job Number" required />
          {isEdit ? (
            <input value={form.job_number} onChange={e => set("job_number", e.target.value)}
              placeholder="e.g. The Odyssey : XY025999, Finishing"
              className={`${MODAL_INPUT} font-mono`} />
          ) : (
            <>
              <div className="bg-[#f4faf8] border border-[#d5ebe4] rounded-2xl px-4 py-3.5 min-h-[54px] flex items-center flex-wrap gap-x-1.5 gap-y-1 leading-snug">
                <span className={`text-base font-bold ${form.film_title.trim() ? "text-[#122027]" : "text-[#b0bec5]"}`}>
                  {form.film_title.trim() || "Film title"}
                </span>
                <span className="text-[#b0bec5] font-bold">:</span>
                <span className="font-mono text-sm font-bold text-[#0f766e] bg-[#dcf3ec] px-2 py-0.5 rounded-md">
                  {nextCode || "XY…"}
                </span>
                <span className="text-[#b0bec5] font-bold">,</span>
                <span className={`text-sm font-medium ${form.project_description.trim() ? "text-[#33454f]" : "text-[#b0bec5]"}`}>
                  {form.project_description.trim() || "project description"}
                </span>
              </div>
              <p className="text-[10px] text-[#768994] mt-1.5">
                Auto-allocated — the label builds itself from the film and project description below.
              </p>
            </>
          )}
        </div>

        {/* Essentials — film, client, description, category, start date compose
            the label above and are the minimum to file the job. */}
        <div className="grid grid-cols-2 gap-5">
          <ComboField label="Film Title" value={form.film_title} onChange={v => set("film_title", v)}
            options={films} placeholder="Search films, or type something else (e.g. Studio Management)…" />
          <ComboField label="Client" required value={form.client} onChange={v => set("client", v)}
            options={clients} placeholder="Search clients…"
            groupBy={studioGroup} groupOrder={CLIENT_GROUP_ORDER} pinRankFn={CLIENT_PIN_RANK} />
        </div>

        <ComboField label="Project Description" value={form.project_description}
          onChange={v => set("project_description", v)}
          options={descs} placeholder="Search descriptions or type a new one…"
          groupBy={descGroup} formatOption={descLabel} groupOrder={DESC_GROUP_ORDER} />

        <div className="grid grid-cols-2 gap-5">
          <ComboField label="Item Category" value={form.job_work_category}
            onChange={v => set("job_work_category", v)}
            options={categories} placeholder="Search categories…"
            groupBy={prefixGroup} formatOption={afterDash} groupOrder={CAT_GROUP_ORDER} />
          <div>
            <FieldLabel text="Start Date" required />
            <DateField value={form.start_date} onChange={v => set("start_date", v)} allowClear={false} placeholder="Pick a start date…" />
          </div>
        </div>

        {/* Billing & admin — everything optional at creation, one disclosure. */}
        <div className="border border-[#dce4ec] rounded-2xl overflow-hidden">
          <button type="button" onClick={() => setShowAdmin(s => !s)}
            className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-[#fbfdff] hover:bg-slate-50 transition-colors">
            <span className="flex items-center gap-2.5 min-w-0">
              <ChevronRight className={`w-4 h-4 text-[#768994] shrink-0 transition-transform ${showAdmin ? "rotate-90" : ""}`} />
              <span className="text-xs font-bold text-[#33454f]">Billing &amp; admin</span>
              {!showAdmin && (
                <span className="hidden sm:inline text-[10px] font-bold text-[#768994] bg-slate-100 px-2 py-0.5 rounded-full truncate">
                  Office · Print/Digital · Ordered by · Costs · Notes
                </span>
              )}
            </span>
            <span className="text-[11px] font-bold text-[#0d9488] shrink-0">Optional</span>
          </button>
          {showAdmin && (
            <div className="px-4 py-5 space-y-6 border-t border-[#dce4ec]">
              <div className="grid grid-cols-2 gap-5">
                <PillField label="Office" value={form.office} onChange={v => set("office", v)} options={OFFICES} />
                <PillField label="Print / Digital" value={form.print_digital} onChange={v => set("print_digital", v)}
                  options={PRINT_DIGITAL} colorMap={PD_COLOR_MAP} />
              </div>

              <div className="grid grid-cols-2 gap-5">
                <ComboField label="Ordered By" value={form.ordered_by} onChange={v => set("ordered_by", v)}
                  options={orderedByOpts} placeholder="Name or type new…" />
                <ComboField label="Billed To" value={form.billed_to} onChange={v => set("billed_to", v)}
                  options={billedToOpts} placeholder="Company or name…" />
              </div>

              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-[#768994] mb-3">Costs</p>
                <div className="grid grid-cols-3 gap-4">
                  {[["Fixed", "fixed_cost"], ["3rd Party", "third_party_cost"], ["Estimated", "estimated_cost"]].map(([lbl, field]) => (
                    <div key={field}>
                      <FieldLabel text={lbl} />
                      <div className="relative">
                        <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#768994] text-sm font-bold select-none">£</span>
                        <input type="number" step="0.01" min="0" value={form[field]}
                          onChange={e => set(field, e.target.value)} placeholder="0.00"
                          className={`${MODAL_INPUT} pl-8`} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <FieldLabel text="Notes" />
                <textarea value={form.notes} onChange={e => set("notes", e.target.value)}
                  rows={3} placeholder="Any additional notes…"
                  className={`${MODAL_INPUT} resize-none`} />
              </div>
            </div>
          )}
        </div>

        {/* Lifecycle — edit only. A job you're creating now is never "done", and
            its create-time Inactive/Active choice lives in the footer instead. */}
        {isEdit && (
          <div className="space-y-6">
            <PillField label="Status" value={form.status} onChange={v => set("status", v)}
              options={JOB_STATUSES} colorMap={STATUS_COLOR_MAP} />

            <div className="grid grid-cols-2 gap-5">
              <div>
                <FieldLabel text="Completed Date" />
                <DateField value={form.completed_date} onChange={v => set("completed_date", v)} placeholder="Not completed yet…" />
              </div>
              <div className="flex items-end">
                <button type="button" onClick={() => set("job_done", !form.job_done)}
                  className={`flex items-center gap-2.5 w-full px-4 py-2.5 rounded-2xl border font-bold text-sm transition-all ${
                    form.job_done
                      ? "bg-[#1cc1a5]/10 border-[#1cc1a5] text-[#1cc1a5]"
                      : "bg-white border-[#dce4ec] text-[#768994] hover:border-[#1cc1a5]/50"
                  }`}>
                  <div className={`w-5 h-5 rounded-lg border-2 flex items-center justify-center shrink-0 transition-colors ${
                    form.job_done ? "bg-[#1cc1a5] border-[#1cc1a5]" : "border-[#dce4ec]"
                  }`}>
                    {form.job_done && <Check className="w-3 h-3 text-white" />}
                  </div>
                  Job Done
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className={footerClass}>
        {/* Create-time status lives here, opposite the actions — present without
            re-cluttering the field stack. Closed only makes sense once editing. */}
        {!isEdit && (
          <div className="mr-auto">
            <p className="text-[9px] font-black uppercase tracking-widest text-[#768994] mb-1.5">Status</p>
            <div className="inline-flex border border-[#dce4ec] rounded-xl overflow-hidden">
              {["Inactive", "Active"].map(s => (
                <button key={s} type="button" onClick={() => set("status", s)}
                  className={`px-4 py-1.5 text-xs font-bold transition-colors ${
                    form.status === s ? "bg-[#10b981] text-white" : "bg-white text-[#768994] hover:text-[#122027]"
                  }`}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {onCancel && (
          <button onClick={onCancel}
            className="px-5 py-2.5 text-sm font-bold text-[#768994] hover:text-[#122027] bg-white border border-[#dce4ec] rounded-2xl transition-all">
            Cancel
          </button>
        )}
        <button onClick={handleSave} disabled={saving || !canSave}
          className={`flex items-center gap-2 px-6 py-2.5 text-white text-sm font-bold rounded-2xl transition-all disabled:opacity-50 shadow-sm ${
            isEdit ? "bg-[#12a0e1] hover:bg-[#0d8bc4]" : "bg-[#10b981] hover:bg-[#0d9488]"
          }`}>
          {saving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          {submitLabel || (isEdit ? "Save Changes" : "Create Job")}
        </button>
      </div>
    </>
  );
}

// ── Job Form Modal (edit only — creation now lives in Jobs Setup > Custom Job) ─
function JobModal({ job, clients, films, categories, descs, onSave, onClose, saving }) {
  return (
    // onMouseDown instead of onClick: fires before blur, so the close is instant
    // and never races with a combobox dropdown's state updates.
    <div className="fixed inset-0 z-[9999] bg-[#122027]/60 backdrop-blur-sm flex items-center justify-center p-4"
      onMouseDown={onClose}>
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden border border-[#dce4ec]"
        onMouseDown={e => e.stopPropagation()}>

        <div className="px-6 pt-5 pb-4 border-b border-[#dce4ec] flex items-center justify-between shrink-0">
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest text-[#12a0e1] mb-0.5">Job Book</p>
            <h2 className="text-xl font-black text-[#122027]">Edit {job?.job_number}</h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-xl text-slate-400 hover:text-slate-600 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <JobForm job={job} clients={clients} films={films} categories={categories} descs={descs}
          onSave={onSave} onCancel={onClose} saving={saving} layout="modal" />
      </div>
    </div>
  );
}

// ── Film Setup: Wrike master-template folder trees ────────────────────────────
// Mirrors each studio's "_STUDIO_MASTER_TEMPLATES" folder in Wrike. Every node
// tagged jobNumber:true gets its own auto-generated job number when a film is
// created — mirrors how the real template's "JOBNUMBER_..." folders are
// currently hand-replaced per new job.
const FOLDER_TEMPLATES = {
  Paramount: {
    label: "_Paramount_MASTER_TEMPLATES",
    children: [
      { label: "_House_Keeping" },
      { label: "Digital" },
      { label: "Launch", children: [
        { label: "Artwork_Launch" },
        { label: "Character_Poster_Launch" },
        { label: "PLF_Launch" },
        { label: "Reporting" },
      ]},
      { label: "Print", children: [
        { label: "DOM" },
        { label: "INT_Creative", children: [
          { label: "JOBNUMBER_Finishing", jobNumber: true },
          { label: "JOBNUMBER_Print_Quad_Creation_OV", jobNumber: true },
          { label: "INTL", children: [
            { label: "JOBNUMBER_CMYK_Conversions", jobNumber: true },
            { label: "JOBNUMBER_INTL_Asset_Chart", jobNumber: true },
            { label: "JOBNUMBER_INTL_Outdoor_Campaign_Bespoke", jobNumber: true },
            { label: "JOBNUMBER_INTL_Outdoor_Campaign_Masters", jobNumber: true },
            { label: "JOBNUMBER_INTL_PRINT_Outdoor_Campaign_Markets", jobNumber: true },
            { label: "JOBNUMBER_Print_OV_Mechs", jobNumber: true },
            { label: "JOBNUMBER_Standee", jobNumber: true },
            { label: "JOBNUMBER_TYPE_Title_Adjustment", jobNumber: true },
            { label: "JOBNUMBER_TYPE_Titles", jobNumber: true },
          ]},
        ]},
      ]},
    ],
  },
};

const STUDIO_OPTIONS = ["Paramount", "Universal"];
// Studios we can currently fetch/test live from Wrike (have a master-template folder).
// Paramount also ships a hardcoded fallback tree above; Universal is fetch-only.
const TESTABLE_STUDIOS = new Set(["Paramount", "Universal"]);

const JOBS_SETUP_TABS = [
  { id: "campaign", label: "Bulk Campaign", desc: "Generate a whole campaign's job numbers at once from a studio's Wrike folder template.", icon: FolderPlus, color: "from-blue-500 to-[#12a0e1]" },
  { id: "custom",   label: "Custom Job",    desc: "Add a single one-off job manually, with its own job number and details.", icon: Plus, color: "from-emerald-500 to-teal-600" },
];

// Exported: also rendered inside the PMs' standalone Job Book page (JobBook.jsx).
export function JobsSetupSection({ setActiveTab }) {
  const [innerTab, setInnerTab] = useState("campaign");
  const [studio, setStudio] = useState("Paramount");
  const [filmTitle, setFilmTitle] = useState("");
  const [fetchedTemplate, setFetchedTemplate] = useState(null); // real subtree pulled live from Wrike
  const [fetchingTemplate, setFetchingTemplate] = useState(false);
  const [fetchInfo, setFetchInfo] = useState(null); // { rootLabel, jobCount } | { error }
  const [films, setFilms] = useState([]);
  const [filmsLoading, setFilmsLoading] = useState(true);
  const [clients, setClients] = useState([]);
  const [categories, setCategories] = useState([]);
  const [descs, setDescs] = useState([]);
  const [customSaving, setCustomSaving] = useState(false);
  const [customCreated, setCustomCreated] = useState(null); // job_number of the row just created

  // Slots already activated for the selected film — { [templateSlotLabel]: jobRow }.
  // Nothing gets created until a slot is clicked, so a film never ends up with a
  // pile of job numbers nobody asked for — you activate exactly what's needed,
  // as and when the work comes in, and can come back to activate more later.
  const [slotJobs, setSlotJobs] = useState({});
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [activatingSlot, setActivatingSlot] = useState(null); // slot label currently being created
  const [activateError, setActivateError] = useState(null);

  // Films are added in the Films tab first — this section only picks from that
  // list, it never creates new films, so the two stay in sync by construction.
  useEffect(() => {
    supabase.from("films").select("title").order("title").then(({ data }) => {
      setFilms((data || []).map(f => f.title));
      setFilmsLoading(false);
    });
    supabase.from("clients").select("name").order("name").then(({ data }) => setClients((data || []).map(c => c.name)));
    supabase.from("job_categories").select("name").order("name").then(({ data }) => setCategories((data || []).map(c => c.name)));
    supabase.from("project_descriptions").select("description").order("description").then(({ data }) => setDescs((data || []).map(d => d.description)));
  }, []);

  const handleCreateCustomJob = async (form) => {
    setCustomSaving(true);
    const payload = {
      ...form,
      start_date: form.start_date || null,
      completed_date: form.completed_date || null,
      fixed_cost: form.fixed_cost === "" ? null : parseFloat(form.fixed_cost),
      third_party_cost: form.third_party_cost === "" ? null : parseFloat(form.third_party_cost),
      estimated_cost: form.estimated_cost === "" ? null : parseFloat(form.estimated_cost),
    };
    const { error } = await supabase.from("jobs").insert(payload);
    setCustomSaving(false);
    if (!error) setCustomCreated(form.job_number);
    else notify(
      error.code === "23505"
        ? `Job number "${form.job_number}" already exists in Job Book.`
        : "Failed to create job: " + error.message,
      "error"
    );
  };

  // Walk the template, collecting every jobNumber:true leaf with a human-readable description
  const collectJobLeaves = (node) => {
    let leaves = node.jobNumber
      ? [{ label: node.label, description: node.label.replace(/^JOBNUMBER_?/i, "").replace(/_/g, " ").trim() || "General" }]
      : [];
    (node.children || []).forEach(c => { leaves = leaves.concat(collectJobLeaves(c)); });
    return leaves;
  };

  // Pull the real master-template folder subtree from Wrike via the OAuth
  // proxy. Builds the same { label, children, jobNumber } shape as the
  // hardcoded FOLDER_TEMPLATES, tagging every "JOBNUMBER_..." folder so it
  // gets a generated code.
  const fetchTemplateFromWrike = async () => {
    if (!localStorage.getItem("wrike_user_id")) { setFetchInfo({ error: "Wrike not connected — connect it in Profile → Settings first." }); return; }
    setFetchingTemplate(true);
    setFetchInfo(null);
    try {
      const FF = encodeURIComponent("[childIds]");
      const fd = {};
      let url = `/api/wrike/folders?fields=${FF}`;
      while (url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Wrike folders fetch failed (${res.status})`);
        const json = await res.json();
        (json.data || []).forEach(f => { fd[f.id] = { id: f.id, title: f.title, childIds: f.childIds || [] }; });
        url = json.nextPageToken
          ? `/api/wrike/folders?fields=${FF}&nextPageToken=${json.nextPageToken}`
          : null;
      }
      // Find candidate master-template roots by fuzzy title match. There can be
      // several ("_Paramount_MASTER_TEMPLATES", a "... copy", archived dupes), so
      // build each subtree and pick the one with the most JOBNUMBER folders,
      // penalising obvious duplicates — that's the real, populated template.
      const wanted = studio.toUpperCase();
      const candidates = Object.values(fd).filter(f => {
        const norm = (f.title || "").toUpperCase().replace(/[_\s]+/g, " ");
        return norm.includes(wanted) && norm.includes("MASTER TEMPLATE");
      });
      if (!candidates.length) throw new Error(`No "${studio}" master-template folder found in Wrike.`);

      const buildFrom = (rootId) => {
        const visited = new Set();
        const build = (id) => {
          if (visited.has(id)) return null;
          visited.add(id);
          const node = fd[id];
          if (!node) return null;
          const children = (node.childIds || []).map(build).filter(Boolean);
          const out = { label: node.title };
          if (children.length) out.children = children;
          if (/JOBNUMBER/i.test(node.title || "")) out.jobNumber = true;
          return out;
        };
        return build(rootId);
      };

      let best = null;
      for (const cand of candidates) {
        const tree = buildFrom(cand.id);
        const jobCount = collectJobLeaves(tree).length;
        const isDupe = /\b(COPY|ARCHIVE|ARCHIVED|OLD|BACKUP|BAK)\b/i.test(cand.title || "");
        const score = jobCount - (isDupe ? 1e6 : 0) - (cand.title || "").length * 0.001;
        if (!best || score > best.score) best = { tree, jobCount, title: cand.title, score };
      }
      setFetchedTemplate(best.tree);
      setFetchInfo({ rootLabel: best.title, jobCount: best.jobCount });
    } catch (e) {
      setFetchInfo({ error: e.message });
      setFetchedTemplate(null);
    } finally {
      setFetchingTemplate(false);
    }
  };

  // Load which slots are already activated for the selected film — keyed by
  // template_slot, so we know per JOBNUMBER_ folder whether it already has a
  // real job number or is still a pending, un-clicked placeholder.
  const loadSlotJobs = useCallback(async (film) => {
    if (!film) { setSlotJobs({}); return; }
    setLoadingSlots(true);
    const { data } = await supabase.from("jobs").select("*").eq("film_title", film).not("template_slot", "is", null);
    const map = {};
    (data || []).forEach(j => { map[j.template_slot] = j; });
    setSlotJobs(map);
    setLoadingSlots(false);
  }, []);

  useEffect(() => { loadSlotJobs(filmTitle); }, [filmTitle, loadSlotJobs]);

  // Activate exactly one slot: allocate the next sequential XY code fresh
  // (reflects anything created anywhere since we last looked), create one job
  // for it, and mark it activated locally. Nothing else in the template is
  // touched — the rest stay pending until someone clicks them too.
  const activateSlot = async (leaf) => {
    if (!filmTitle.trim() || activatingSlot || slotJobs[leaf.label]) return;
    setActivatingSlot(leaf.label);
    setActivateError(null);
    try {
      const [{ data: jobRows }, { data: taskRows }] = await Promise.all([
        supabase.from("jobs").select("job_number"),
        supabase.from("tasks").select("job_number"),
      ]);
      let maxNum = 0;
      [...(jobRows || []), ...(taskRows || [])].forEach(r => {
        const m = (r.job_number || "").match(/XY(\d+)/);
        if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
      });
      const code = `XY${String(maxNum + 1).padStart(6, "0")}`;
      const row = {
        job_number: `${filmTitle.trim()} : ${code}, ${leaf.description}`,
        film_title: filmTitle.trim(),
        template_slot: leaf.label,
        status: "Inactive",
        start_date: new Date().toISOString().slice(0, 10),
      };
      const { data, error } = await supabase.from("jobs").insert(row).select().single();
      if (error) throw error;
      setSlotJobs(prev => ({ ...prev, [leaf.label]: data }));
    } catch (e) {
      setActivateError(e.code === "23505" ? "That job number was just taken by another activation — try again." : e.message);
    } finally {
      setActivatingSlot(null);
    }
  };

  // Recursive tree renderer — activated JOBNUMBER_ leaves show their real code;
  // pending ones stay clickable placeholders you can activate right in the tree.
  // Uses a path-based key since live Wrike data can have repeated folder names
  // across branches. The root folder in Wrike is always renamed to the film
  // itself (e.g. "Passenger") rather than keeping the "_STUDIO_MASTER_TEMPLATES"
  // name — mirror that here once a film is picked.
  const renderTree = (node, depth = 0, path = "0") => {
    const isSlot = !!node.jobNumber;
    const activated = isSlot ? slotJobs[node.label] : null;
    const isActivating = activatingSlot === node.label;
    const leafDesc = isSlot ? node.label.replace(/^JOBNUMBER_?/i, "").replace(/_/g, " ").trim() || "General" : null;

    let displayLabel = node.label;
    if (depth === 0 && filmTitle.trim()) displayLabel = filmTitle.trim().replace(/\s+/g, "_");
    else if (activated) displayLabel = node.label.replace(/^JOBNUMBER/i, activated.job_number.match(/XY\d+/)?.[0] || "XY??????");

    return (
      <div key={path}>
        <div
          onClick={isSlot && !activated && !isActivating && filmTitle.trim() ? () => activateSlot({ label: node.label, description: leafDesc }) : undefined}
          className={`flex items-center gap-1.5 py-1 ${isSlot && !activated && filmTitle.trim() ? "cursor-pointer hover:bg-[#12a0e1]/5 rounded-lg -mx-1 px-1" : ""}`}
          style={{ paddingLeft: depth * 18 }}>
          {node.children?.length
            ? <FolderOpen className="w-3.5 h-3.5 text-[#f4b740] shrink-0" />
            : <Folder className={`w-3.5 h-3.5 shrink-0 ${isSlot && !activated ? "text-[#12a0e1]" : "text-[#b0bec5]"}`} />}
          <span className={`text-[12px] ${activated ? "font-mono font-bold text-[#12a0e1]" : isSlot ? "text-[#122027] font-bold" : "text-[#122027]"}`}>
            {displayLabel}
          </span>
          {isSlot && !activated && !isActivating && filmTitle.trim() && (
            <span className="text-[9px] font-black uppercase tracking-wider text-[#12a0e1] bg-[#12a0e1]/10 px-1.5 py-0.5 rounded ml-1">Click to activate</span>
          )}
          {isActivating && <Loader2 className="w-3 h-3 animate-spin text-[#12a0e1] ml-1" />}
        </div>
        {node.children?.map((c, i) => renderTree(c, depth + 1, `${path}-${i}`))}
      </div>
    );
  };

  const hasTemplate = !!(fetchedTemplate || FOLDER_TEMPLATES[studio]);
  const templateToShow = fetchedTemplate || (hasTemplate ? FOLDER_TEMPLATES[studio] : null);
  const allLeaves = templateToShow ? collectJobLeaves(templateToShow) : [];
  const activatedCount = allLeaves.filter(l => slotJobs[l.label]).length;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-4">
        {JOBS_SETUP_TABS.map(t => {
          const Icon = t.icon;
          const active = innerTab === t.id;
          return (
            <button key={t.id} onClick={() => setInnerTab(t.id)}
              className={`text-left rounded-2xl p-5 border-2 transition-all ${
                active
                  ? "border-[#12a0e1] bg-[#12a0e1]/5 shadow-md"
                  : "border-[#dce4ec] bg-white hover:border-slate-300 hover:shadow-sm"
              }`}>
              <div className="flex items-start justify-between mb-3">
                <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${t.color} flex items-center justify-center shadow-sm`}>
                  <Icon className="w-5 h-5 text-white" />
                </div>
                {active && (
                  <div className="w-5 h-5 rounded-full bg-[#12a0e1] flex items-center justify-center shrink-0">
                    <Check className="w-3 h-3 text-white" />
                  </div>
                )}
              </div>
              <p className="text-sm font-black text-[#122027] mb-1">{t.label}</p>
              <p className="text-xs text-[#768994] leading-relaxed">{t.desc}</p>
            </button>
          );
        })}
      </div>

      {innerTab === "campaign" && (
    <div className="flex flex-col gap-5">
      <div className="bg-[#f8fafc] border border-[#dce4ec] rounded-2xl p-4">
        <p className="text-xs text-[#768994] leading-relaxed">
          Pick a film and fetch its studio template to see every possible job slot. Nothing is created just
          from looking — <span className="font-bold text-[#122027]">click a slot</span> to allocate a real job
          number for it right then and add it to Job Book. Come back to this same page any time to activate
          more slots as work actually comes in, so you never end up with numbers nobody used.
        </p>
      </div>

      <div>
        <label className="block text-[10px] font-black uppercase tracking-widest text-[#768994] mb-1.5">Studio Template</label>
        <div className="flex gap-2">
          {STUDIO_OPTIONS.map(s => {
            const available = TESTABLE_STUDIOS.has(s);
            return (
              <button key={s} disabled={!available}
                onClick={() => { setStudio(s); setFetchedTemplate(null); setFetchInfo(null); }}
                className={`px-3 py-2 rounded-xl text-xs font-bold border transition-all ${
                  studio === s
                    ? "bg-[#122027] text-white border-[#122027]"
                    : available
                      ? "bg-white text-[#122027] border-[#dce4ec] hover:border-[#12a0e1]"
                      : "bg-slate-50 text-slate-300 border-slate-100 cursor-not-allowed"
                }`}>
                {s}{!available && " (soon)"}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={fetchTemplateFromWrike} disabled={fetchingTemplate || !TESTABLE_STUDIOS.has(studio)}
          className="flex items-center gap-2 px-4 py-2 bg-white border border-[#12a0e1] text-[#12a0e1] hover:bg-[#12a0e1] hover:text-white text-xs font-bold rounded-xl transition-all disabled:opacity-40">
          {fetchingTemplate ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          {fetchingTemplate ? "Fetching from Wrike…" : `Fetch ${studio} template from Wrike`}
        </button>
        {fetchInfo?.error && <span className="text-xs font-bold text-red-500">{fetchInfo.error}</span>}
        {fetchInfo && !fetchInfo.error && (
          <span className="text-xs font-bold text-[#1cc1a5]">
            Loaded “{fetchInfo.rootLabel}” — {fetchInfo.jobCount} job folder{fetchInfo.jobCount === 1 ? "" : "s"}
          </span>
        )}
        {fetchedTemplate && (
          <span className="text-[10px] font-black uppercase tracking-wider text-[#12a0e1] bg-[#12a0e1]/10 px-2 py-1 rounded-lg">Live Wrike Data</span>
        )}
      </div>

      <div>
        <label className="block text-[10px] font-black uppercase tracking-widest text-[#768994] mb-1.5">Film</label>
        <StrictSelect value={filmTitle} onChange={v => setFilmTitle(v)}
          options={films} placeholder="Select a film…" loading={filmsLoading} />
        {!filmsLoading && films.length === 0 && (
          <p className="text-xs text-[#768994] mt-1.5">
            No films yet — add one in the{" "}
            <button onClick={() => setActiveTab?.("films")} className="text-[#12a0e1] font-bold hover:underline">Films</button> tab first.
          </p>
        )}
      </div>

      {templateToShow && (
        <>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs font-bold text-[#768994]">
              {filmTitle.trim()
                ? `${activatedCount} / ${allLeaves.length} job number${allLeaves.length === 1 ? "" : "s"} activated for “${filmTitle}”`
                : `${allLeaves.length} job slot${allLeaves.length === 1 ? "" : "s"} in this template — select a film above to activate any of them`}
            </span>
            {loadingSlots && <Loader2 className="w-3.5 h-3.5 animate-spin text-[#768994]" />}
            {activateError && <span className="text-xs font-bold text-red-500">{activateError}</span>}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="border border-[#dce4ec] rounded-2xl p-4 max-h-[420px] overflow-y-auto">
              <p className="text-[10px] font-black uppercase tracking-widest text-[#768994] mb-2">
                Folder Preview{fetchedTemplate ? " · live from Wrike" : ""}
              </p>
              {renderTree(templateToShow)}
            </div>
            <div className="border border-[#dce4ec] rounded-2xl p-4 max-h-[420px] overflow-y-auto">
              <p className="text-[10px] font-black uppercase tracking-widest text-[#768994] mb-2">Job Slots</p>
              <div className="flex flex-col gap-1.5">
                {allLeaves.map(l => {
                  const activated = slotJobs[l.label];
                  const isActivating = activatingSlot === l.label;
                  const code = activated?.job_number.match(/XY\d+/)?.[0];
                  const canActivate = filmTitle.trim() && !activated && !isActivating;
                  return (
                    <button key={l.label} disabled={!canActivate}
                      onClick={() => activateSlot(l)}
                      title={!filmTitle.trim() && !activated ? "Select a film above first" : ""}
                      className={`flex items-center justify-between text-[11px] border-b border-[#f0f4f8] pb-1.5 pt-0.5 text-left transition-colors ${
                        canActivate ? "hover:bg-[#12a0e1]/5 rounded-lg -mx-1 px-1" : "cursor-default"
                      }`}>
                      <span className={activated ? "text-[#768994]" : "text-[#122027] font-bold"}>{l.description}</span>
                      {activated ? (
                        <span className="font-mono font-bold text-[#12a0e1]">{code}</span>
                      ) : isActivating ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-[#12a0e1]" />
                      ) : (
                        <span className={`text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full ${
                          filmTitle.trim() ? "text-[#12a0e1] bg-[#12a0e1]/10" : "text-[#b0bec5] bg-slate-100"
                        }`}>Activate</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button onClick={() => setActiveTab?.("jobs")}
              className="px-4 py-2.5 bg-[#122027] hover:bg-[#1a2e38] text-white text-sm font-bold rounded-2xl transition-all">
              View in Job Book
            </button>
            <button disabled
              title="Coming soon — will use the Wrike API to create the folder automatically when a slot is activated"
              className="flex items-center gap-2 px-5 py-2.5 bg-slate-100 text-slate-400 text-sm font-bold rounded-2xl cursor-not-allowed">
              <FolderPlus className="w-3.5 h-3.5" /> Push Folders to Wrike (Soon)
            </button>
          </div>
        </>
      )}
    </div>
      )}

      {innerTab === "custom" && (
        <div>
          {customCreated == null ? (
            <JobForm clients={clients} films={films} categories={categories} descs={descs}
              onSave={handleCreateCustomJob} saving={customSaving} submitLabel="Create Job" layout="inline" />
          ) : (
            <div className="flex items-center gap-3 py-4">
              <span className="flex items-center gap-2 px-4 py-2.5 bg-[#1cc1a5]/10 text-[#1cc1a5] text-sm font-bold rounded-2xl">
                <CheckCircle2 className="w-3.5 h-3.5" /> Created {customCreated} in Job Book
              </span>
              <button onClick={() => setActiveTab?.("jobs")}
                className="px-4 py-2.5 bg-[#122027] hover:bg-[#1a2e38] text-white text-sm font-bold rounded-2xl transition-all">
                View in Job Book
              </button>
              <button onClick={() => setCustomCreated(null)}
                className="px-4 py-2.5 bg-white border border-[#dce4ec] hover:border-[#12a0e1] text-[#122027] text-sm font-bold rounded-2xl transition-all">
                Add Another Job
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Job Book Section ───────────────────────────────────────────────────────────
// Exported: also rendered standalone as the PMs' "Job Book" page (JobBook.jsx).
export function JobBookSection({ setActiveTab }) {
  const [jobs, setJobs]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [search, setSearch]     = useState("");
  const [monthFilter, setMonthFilter] = useState(() => new Date().toISOString().slice(0, 7));
  const [showModal, setShowModal] = useState(false);
  const [editJob, setEditJob]   = useState(null);
  const [saving, setSaving]     = useState(false);
  const [clients, setClients]   = useState([]);
  const [films, setFilms]       = useState([]);
  const [categories, setCategories] = useState([]);
  const [descs, setDescs]       = useState([]);
  const [page, setPage]         = useState(0);
  const PER_PAGE = 50;

  const loadRef = useCallback(async () => {
    const [c, f, cat, d] = await Promise.all([
      supabase.from("clients").select("name").order("name"),
      supabase.from("films").select("title, created_at").order("created_at", { ascending: false }),
      supabase.from("job_categories").select("name").order("name"),
      supabase.from("project_descriptions").select("description").order("description"),
    ]);
    setClients((c.data || []).map(x => x.name));
    setFilms((f.data || []).map(x => x.title));
    setCategories((cat.data || []).map(x => x.name));
    setDescs((d.data || []).map(x => x.description));
  }, []);

  const loadJobs = useCallback(async () => {
    setLoading(true);
    let q = supabase.from("jobs").select("*").order("id", { ascending: false });
    if (monthFilter) {
      const start = monthFilter + "-01";
      const end = new Date(monthFilter + "-01");
      end.setMonth(end.getMonth() + 1);
      q = q.gte("start_date", start).lt("start_date", end.toISOString().slice(0, 10));
    }
    const { data } = await q;
    setJobs(data || []);
    setLoading(false);
  }, [monthFilter]);

  useEffect(() => { loadRef(); }, [loadRef]);
  useEffect(() => { loadJobs(); setPage(0); }, [loadJobs]);

  const filtered = useMemo(() =>
    jobs.filter(j =>
      !search ||
      (j.job_number || "").toLowerCase().includes(search.toLowerCase()) ||
      (j.client || "").toLowerCase().includes(search.toLowerCase()) ||
      (j.film_title || "").toLowerCase().includes(search.toLowerCase())
    ),
    [jobs, search]
  );

  const paginated = filtered.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
  const totalPages = Math.ceil(filtered.length / PER_PAGE);

  const handleSave = async (form) => {
    setSaving(true);
    const payload = {
      ...form,
      start_date: form.start_date || null,
      completed_date: form.completed_date || null,
      fixed_cost: form.fixed_cost === "" ? null : parseFloat(form.fixed_cost),
      third_party_cost: form.third_party_cost === "" ? null : parseFloat(form.third_party_cost),
      estimated_cost: form.estimated_cost === "" ? null : parseFloat(form.estimated_cost),
    };
    if (editJob?.id) {
      await supabase.from("jobs").update(payload).eq("id", editJob.id);
    } else {
      await supabase.from("jobs").insert(payload);
    }
    setShowModal(false); setEditJob(null);
    await loadJobs();
    setSaving(false);
  };

  const toggleDone = async (job) => {
    await supabase.from("jobs").update({ job_done: !job.job_done }).eq("id", job.id);
    setJobs(prev => prev.map(j => j.id === job.id ? { ...j, job_done: !j.job_done } : j));
  };

  // Click cycles Inactive -> Active -> Closed -> Inactive, matching the workflow:
  // new jobs start Inactive, go Active once billing info is filled in, Closed when done.
  const cycleStatus = async (job) => {
    const next = JOB_STATUSES[(JOB_STATUSES.indexOf(job.status || "Inactive") + 1) % JOB_STATUSES.length];
    await supabase.from("jobs").update({ status: next }).eq("id", job.id);
    setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: next } : j));
  };

  const deleteJob = async (id) => {
    const ok = await confirmAction({
      title: "Delete this job?",
      message: "The job and its Job Book record will be removed. This can't be undone.",
      confirmLabel: "Delete job",
      danger: true,
    });
    if (!ok) return;
    await supabase.from("jobs").delete().eq("id", id);
    await loadJobs();
  };

  const formatCost = (j) => {
    if (j.fixed_cost) return `Fixed: $${parseFloat(j.fixed_cost).toLocaleString()}`;
    if (j.estimated_cost) return `Est: $${parseFloat(j.estimated_cost).toLocaleString()}`;
    if (j.third_party_cost) return `3P: $${parseFloat(j.third_party_cost).toLocaleString()}`;
    return "—";
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="flex items-center gap-2 bg-white border border-[#dce4ec] rounded-xl px-3 py-2">
          <span className="text-[10px] font-black text-[#768994] uppercase tracking-widest">Month</span>
          <input type="month" value={monthFilter} onChange={e => setMonthFilter(e.target.value)}
            className="text-sm font-bold text-[#122027] outline-none bg-transparent" />
          {monthFilter && (
            <button onClick={() => setMonthFilter("")} className="text-slate-400 hover:text-rose-500">
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#768994]" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search job number, client, film…"
            className="w-full pl-9 pr-4 py-2 text-sm border border-[#dce4ec] rounded-xl outline-none focus:border-[#12a0e1] bg-white"
          />
        </div>
        <button onClick={() => setActiveTab?.("jobsSetup")}
          className="flex items-center gap-1.5 px-4 py-2 bg-[#12a0e1] hover:bg-[#0d8bc4] text-white text-sm font-bold rounded-xl transition-all shrink-0">
          <Plus className="w-4 h-4" /> Add Jobs
        </button>
      </div>

      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] font-black text-[#768994] uppercase tracking-widest">
          {filtered.length} jobs
        </p>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
              className="p-1 disabled:opacity-30 hover:bg-slate-100 rounded-lg">
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="text-xs font-bold text-[#768994]">{page + 1} / {totalPages}</span>
            <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page === totalPages - 1}
              className="p-1 disabled:opacity-30 hover:bg-slate-100 rounded-lg">
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 gap-2 text-[#768994]">
          <RefreshCw className="w-4 h-4 animate-spin" /> Loading jobs…
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-[#dce4ec]">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-[#dce4ec]">
                {["Job #","Date","Client","Office","P/D","Film Title","Project Description","Costs","Ordered By","Billed To","Status","Done",""].map(h => (
                  <th key={h} className="px-3 py-2.5 text-left text-[9px] font-black uppercase tracking-widest text-[#768994] whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paginated.length === 0 ? (
                <tr><td colSpan={13} className="text-center py-12 text-[#768994] italic">No jobs found</td></tr>
              ) : paginated.map(j => (
                <tr key={j.id} className={`border-b border-[#dce4ec] last:border-0 hover:bg-slate-50/50 transition-colors ${j.job_done ? "opacity-50" : ""}`}>
                  <td className="px-3 py-2.5">
                    <span className="font-black text-[#12a0e1] font-mono">{j.job_number}</span>
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-[#768994]">
                    {j.start_date ? new Date(j.start_date).toLocaleDateString("en-GB", { day:"2-digit", month:"short", year:"2-digit" }) : "—"}
                  </td>
                  <td className="px-3 py-2.5 max-w-[120px] truncate font-medium text-[#122027]">{j.client || "—"}</td>
                  <td className="px-3 py-2.5">
                    <span className="text-[9px] font-black bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">{j.office || "—"}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`text-[9px] font-black px-1.5 py-0.5 rounded ${j.print_digital === "Digital" ? "bg-cyan-100 text-cyan-700" : j.print_digital === "Print" ? "bg-orange-100 text-orange-700" : "bg-purple-100 text-purple-700"}`}>
                      {j.print_digital || "—"}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 max-w-[100px] truncate italic text-[#768994]">{j.film_title || "—"}</td>
                  <td className="px-3 py-2.5 max-w-[160px] truncate text-[#122027]">{j.project_description || "—"}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap font-bold text-[#122027]">{formatCost(j)}</td>
                  <td className="px-3 py-2.5 text-[#768994]">{j.ordered_by || "—"}</td>
                  <td className="px-3 py-2.5 text-[#768994]">{j.billed_to || "—"}</td>
                  <td className="px-3 py-2.5">
                    <button onClick={() => cycleStatus(j)} title="Click to change status"
                      className={`text-[9px] font-black px-2 py-1 rounded-full transition-colors ${STATUS_BADGE[j.status || "Inactive"]}`}>
                      {j.status || "Inactive"}
                    </button>
                  </td>
                  <td className="px-3 py-2.5">
                    <button onClick={() => toggleDone(j)} title="Toggle done">
                      <div className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-colors ${j.job_done ? "bg-[#1cc1a5] border-[#1cc1a5]" : "border-[#dce4ec] hover:border-[#1cc1a5]"}`}>
                        {j.job_done && <Check className="w-2.5 h-2.5 text-white" />}
                      </div>
                    </button>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1">
                      <button onClick={() => { setEditJob(j); setShowModal(true); }}
                        className="p-1 hover:bg-slate-200 rounded-lg text-slate-400 hover:text-[#122027] transition-colors">
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button onClick={() => deleteJob(j.id)}
                        className="p-1 hover:bg-rose-100 rounded-lg text-slate-400 hover:text-rose-600 transition-colors">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <JobModal
          job={editJob}
          clients={clients} films={films} categories={categories} descs={descs}
          onSave={handleSave} onClose={() => { setShowModal(false); setEditJob(null); }}
          saving={saving}
        />
      )}
    </div>
  );
}

// ── Jobs Feed ─────────────────────────────────────────────────────────────────
// Exported: also rendered inside the PMs' standalone Job Book page (JobBook.jsx).
export function JobsFeedSection() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [monthFilter, setMonthFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    // "date" is a text column with mixed historical formats (dd/mm/yyyy and
    // ISO), so filtering it with .gte()/.lt() at the DB level is unreliable —
    // it's a lexicographic string compare, not a real date compare. Fetch
    // everything and filter by month client-side after normalising to ISO.
    const { data: allTasks } = await supabase
      .from("tasks")
      .select("*")
      .order("id", { ascending: false })
      .limit(2000);

    const toIso = (d) => {
      if (!d) return null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
      const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
    };

    const tasks = monthFilter
      ? (allTasks || []).filter(t => (toIso(t.date) || "").startsWith(monthFilter))
      : (allTasks || []);

    // Sort by the job's actual date (not by row id / sync time) — id only
    // reflects when a row was pulled into the app, which can be well after
    // the work date it's tagged with. Rows without a parseable date fall
    // to the bottom; ties break by most-recently-synced first.
    tasks.sort((a, b) => {
      const da = toIso(a.date) || "";
      const db = toIso(b.date) || "";
      if (da !== db) return db.localeCompare(da);
      return (b.id || 0) - (a.id || 0);
    });

    if (!tasks?.length) { setEntries([]); setLoading(false); return; }

    const userIds = [...new Set(tasks.map(t => t.wrike_user_id).filter(Boolean))];
    const jobNums = [...new Set(tasks.map(t => t.job_number).filter(Boolean))];

    const [{ data: profiles }, { data: jobs }] = await Promise.all([
      userIds.length
        ? supabase.from("profiles").select("wrike_user_id, first_name, last_name").in("wrike_user_id", userIds)
        : Promise.resolve({ data: [] }),
      jobNums.length
        ? supabase.from("jobs").select("job_number, office, print_digital, job_work_category, ordered_by, billed_to, fixed_cost").in("job_number", jobNums)
        : Promise.resolve({ data: [] }),
    ]);

    const profileMap = Object.fromEntries(
      (profiles || []).map(p => [p.wrike_user_id, cleanFullName(p.first_name, p.last_name)])
    );
    const jobMap = Object.fromEntries((jobs || []).map(j => [j.job_number, j]));

    setEntries(tasks.map(t => ({ ...t, _name: profileMap[t.wrike_user_id] || "—", _job: jobMap[t.job_number] || {} })));
    setLoading(false);
  }, [monthFilter]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (!search) return entries;
    const q = search.toLowerCase();
    return entries.filter(e =>
      (e.job_number || "").toLowerCase().includes(q) ||
      (e.client || "").toLowerCase().includes(q) ||
      (e.film_title || "").toLowerCase().includes(q) ||
      (e._name || "").toLowerCase().includes(q) ||
      (e.project_description || "").toLowerCase().includes(q)
    );
  }, [entries, search]);

  const fmtDate = (d) => {
    if (!d) return "—";
    try {
      // ISO "2026-06-29" → "29.06.26"
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        const [y, m, day] = d.split("-");
        return `${day}.${m}.${y.slice(2)}`;
      }
      // Legacy "dd/mm/yyyy" → "29.06.26"
      const slash = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (slash) return `${slash[1]}.${slash[2]}.${slash[3].slice(2)}`;
      return d;
    } catch { return d; }
  };
  const fmtNum = (n) => {
    if (n === null || n === undefined || n === "" || n === "none") return "—";
    const s = String(n);
    // New format already stored as "H:MM"
    if (/^\d+:\d{2}$/.test(s)) return s;
    const v = parseFloat(s);
    if (isNaN(v) || v <= 0) return "—";
    // Old decimal hours ("0.5", "1.50") → convert to H:MM
    const mins = s.includes(".") ? Math.round(v * 60) : Math.round(v);
    if (mins <= 0) return "—";
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}:${String(m).padStart(2, "0")}`;
  };

  // Build month options: current + past 11
  const monthOptions = useMemo(() => {
    const now = new Date();
    return Array.from({ length: 12 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    });
  }, []);

  const fmtMonthLabel = (s) => {
    const [y, m] = s.split("-");
    return new Date(+y, +m - 1).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
  };

  const COLS = [
    { key: "job_number",          label: ["Job #"],                    px: 80  },
    { key: "date",                label: ["Date"],                     px: 64  },
    { key: "client",              label: ["Client"],                   px: 130 },
    { key: "office",              label: ["Off."],                     px: 38  },
    { key: "print_digital",       label: ["P/D"],                      px: 44  },
    { key: "film_title",          label: ["Film"],                     px: 120 },
    { key: "job_category",        label: ["Job", "Cat."],              px: 72  },
    { key: "project_description", label: ["Project", "Description"],   px: 140 },
    { key: "category",            label: ["Item", "Category"],         px: 140 },
    { key: "client_amends",       label: ["CA"],                       px: 30  },
    { key: "is_3d",               label: ["3D"],                       px: 28  },
    { key: "costs",               label: ["Costs"],                    px: 68  },
    { key: "ordered_by",          label: ["Ordered", "By"],            px: 100 },
    { key: "billed_to",           label: ["Billed", "To"],             px: 100 },
    { key: "worked_on",           label: ["Worked", "On By"],          px: 100 },
    { key: "hourly_rate",         label: ["Rate"],                     px: 56  },
    { key: "time_spent",          label: ["Time"],                     px: 44  },
    { key: "extra_time",          label: ["Extra"],                    px: 44  },
    { key: "over_time",           label: ["OT"],                       px: 38  },
    { key: "total",               label: ["Total"],                    px: 60  },
  ];

  const getCellValue = (e, key) => {
    const j = e._job || {};
    switch (key) {
      case "job_number": {
        const s = e.job_number || "";
        const colonIdx = s.indexOf(" : ");
        if (colonIdx < 0) return s || "—";
        const after = s.slice(colonIdx + 3);
        const commaIdx = after.indexOf(",");
        return commaIdx > 0 ? after.slice(0, commaIdx).trim() : after.trim();
      }
      case "date":                return fmtDate(e.date);
      case "client":              return e.client || "—";
      case "office":              return j.office || "—";
      case "print_digital":       return j.print_digital || "—";
      case "film_title": {
        // Prefer extracting from job_number "Film Name : XYnnnnnn, ..." — always authoritative
        const colonIdx = (e.job_number || "").indexOf(" : ");
        if (colonIdx > 0) return e.job_number.slice(0, colonIdx).trim();
        return e.film_title || "—";
      }
      case "job_category":        return j.job_work_category || "—";
      case "project_description": return e.project_description || "—";
      case "category":            return e.category || "—";
      case "client_amends":       return e.client_amends ? <Check className="w-3.5 h-3.5 text-emerald-500 mx-auto" /> : "";
      case "is_3d":               return e.is_3d ? <Check className="w-3.5 h-3.5 text-emerald-500 mx-auto" /> : "";
      case "costs":               return j.fixed_cost != null ? `£${parseFloat(j.fixed_cost).toFixed(2)}` : "—";
      case "ordered_by":          return j.ordered_by || "—";
      case "billed_to":           return j.billed_to || "—";
      case "worked_on":           return e._name;
      case "hourly_rate":         return "—";
      case "time_spent":          return fmtNum(e.time_spent);
      case "extra_time":          return fmtNum(e.additional_time);
      case "over_time":           return "0.00";
      case "total":               return "—";
      default:                    return "—";
    }
  };

  // Text-only version of getCellValue for the export — the two boolean
  // columns render a checkmark icon on screen, which can't go in a CSV cell.
  const getCellText = (e, key) => {
    if (key === "client_amends") return e.client_amends ? "Yes" : "";
    if (key === "is_3d") return e.is_3d ? "Yes" : "";
    return getCellValue(e, key);
  };

  // Same CSV-Blob-and-click-a-link approach as the app's other export
  // (App.jsx's "Download CSV" palette action) — Excel opens CSV natively,
  // so there's no need for an xlsx-writing dependency just for this.
  // Exports whatever the current month/search filters are showing, not
  // the full unfiltered table.
  const exportToExcel = () => {
    const headers = COLS.map(c => c.label.join(" "));
    const rows = filtered.map(e => COLS.map(c => getCellText(e, c.key)));
    // Leading BOM — Excel doesn't sniff UTF-8 for a local CSV file without
    // one and falls back to Windows-1252, which mangles the em-dash
    // placeholder (and anything else non-ASCII) into "â€"".
    const csv = "\uFEFF" + [headers, ...rows]
      .map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const a = document.createElement("a");
    a.href = url;
    const scope = monthFilter ? fmtMonthLabel(monthFilter).replace(" ", "_") : "All";
    a.download = `ProjectTime_${scope}_${new Date().toISOString().split("T")[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Filters row */}
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={monthFilter}
          onChange={e => setMonthFilter(e.target.value)}
          className="border border-[#dce4ec] rounded-xl px-3 py-2 text-sm font-bold text-[#122027] outline-none focus:border-[#12a0e1] bg-white"
        >
          {monthOptions.map(m => (
            <option key={m} value={m}>{fmtMonthLabel(m)}</option>
          ))}
        </select>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#b0bec5]" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search job, client, film, person…"
            className="w-full pl-9 pr-3 py-2 border border-[#dce4ec] rounded-xl text-sm text-[#122027] outline-none focus:border-[#12a0e1] bg-white"
          />
        </div>
        <div className="flex items-center gap-3 ml-auto">
          <span className="text-xs font-bold text-[#b0bec5]">
            {loading ? "Loading…" : `${filtered.length} entr${filtered.length === 1 ? "y" : "ies"}`}
          </span>
          <button
            onClick={exportToExcel}
            disabled={loading || filtered.length === 0}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-white border border-[#dce4ec] hover:border-slate-300 text-[#122027] text-xs font-bold rounded-xl transition-all disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            Export to Excel
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-[#dce4ec] shadow-sm">
        <table className="border-collapse text-[11px] w-full" style={{ minWidth: `${COLS.reduce((s, c) => s + c.px, 0)}px` }}>
          <thead>
            <tr>
              {COLS.map(c => (
                <th
                  key={c.key}
                  style={{ width: c.px, minWidth: c.px }}
                  className="px-2 py-2.5 text-center font-black uppercase tracking-widest text-[9px] text-white bg-[#0d1b22] border-r border-white/5 last:border-r-0 whitespace-nowrap"
                >
                  {Array.isArray(c.label) ? c.label.map((l, i) => <span key={i} className="block leading-tight">{l}</span>) : c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={COLS.length} className="px-4 py-8 text-center text-[#b0bec5]">Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={COLS.length} className="px-4 py-8 text-center text-[#b0bec5]">No entries for this period</td></tr>
            ) : filtered.map((e, i) => (
              <tr key={e.id} className={`border-b border-[#f0f4f8] align-top ${i % 2 === 0 ? "bg-white" : "bg-[#f8fafc]"} hover:bg-[#edf5fb] transition-colors`}>
                {COLS.map(c => {
                  const val = getCellValue(e, c.key);
                  const isCheck = c.key === "client_amends" || c.key === "is_3d";
                  const isMono = ["time_spent", "extra_time", "over_time", "total", "hourly_rate", "costs"].includes(c.key);
                  const noWrap = ["date", "office", "print_digital", "client_amends", "is_3d", "time_spent", "extra_time", "over_time", "total", "hourly_rate", "costs"].includes(c.key);
                  return (
                    <td
                      key={c.key}
                      style={{ width: c.px, minWidth: c.px }}
                      className={`px-2 py-1.5 border-r border-[#f0f4f8] last:border-r-0 ${isCheck ? "text-center" : ""} ${isMono ? "font-mono text-[10px]" : ""} ${noWrap ? "whitespace-nowrap" : ""} text-[#122027]`}
                    >
                      <span className={`block leading-snug ${c.key === "job_number" ? "font-black text-[#12a0e1]" : "font-medium"}`}>
                        {val}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Administration hub (level 0) ────────────────────────────────────────────
function AdminHub({ expandedGroup, onToggleGroup, onOpenItem }) {
  return (
    <div className="space-y-6">

      {/* The three destinations — clicking one unfolds its items right there
          in place (an accordion), rather than navigating to a separate
          screen. Each is its own separate card now (was one shared
          bordered list with rows butted against each other) — same
          treatment PeopleSection's department cards already use, so a
          manager sees three distinct destinations, not one dense block
          that happens to have three rows. */}
      <div className="space-y-4">
        {NAV_GROUPS.map((group) => {
          const isOpen = expandedGroup === group.id;
          // A group with exactly one destination has nothing to unfold —
          // an accordion revealing a single row you then click again is
          // pure friction. Go straight there, and read as navigation (no
          // `open` prop) rather than as an expand/collapse toggle.
          const singleItem = group.items.length === 1;
          return (
            <div key={group.id} className="bg-white rounded-3xl border border-[#dce4ec] shadow-sm overflow-hidden">
              <HubRow
                section={group}
                onClick={() => (singleItem ? onOpenItem(group.items[0].id) : onToggleGroup(group.id))}
                open={singleItem ? undefined : isOpen}
                first
              />
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
                    className="overflow-hidden bg-slate-50 border-t border-[#dce4ec]"
                  >
                    {/* Same HubRow, just compact — identical gradient sweep
                        and hover behavior as the parent row, not a
                        hand-rolled approximation of it. */}
                    {group.items.map((item) => (
                      <HubRow
                        key={item.id}
                        compact
                        section={{ ...item, gradient: group.gradient }}
                        onClick={() => onOpenItem(item.id)}
                        badge={
                          item.soon ? (
                            <span className="text-[9px] font-black uppercase tracking-widest text-[#768994] group-hover:text-white/80 bg-slate-100 group-hover:bg-white/15 px-2 py-1 rounded-full transition-colors duration-300">
                              Coming soon
                            </span>
                          ) : null
                        }
                      />
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

    </div>
  );
}

// ── People section ──────────────────────────────────────────────────────────
function PeopleSection() {
  const [people, setPeople]         = useState([]);
  const [positions, setPositions]   = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading]       = useState(true);
  const [syncing, setSyncing]       = useState(false);
  const [syncMsg, setSyncMsg]       = useState("");
  const [expanded, setExpanded]     = useState({});
  const [search, setSearch]         = useState("");
  // Per-department: has its expand/collapse animation finished? Multiple
  // departments can be open at once here (unlike the top-level hub, this
  // isn't an exclusive accordion), so this has to be tracked per label, not
  // as one shared flag. See toggleGroup below for why it matters.
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

      let added = 0;
      for (const c of contacts) {
        const payload = {
          wrike_user_id: c.id,
          first_name: c.firstName || null,
          last_name: c.lastName || null,
          email: c.profiles?.[0]?.email || null,
          avatar_url: c.avatarUrl || null,
        };
        // Only overwrite department when Wrike groups give us a clear answer
        if (deptMap[c.id]) payload.department = deptMap[c.id];
        const { error } = await supabase.from("profiles").upsert(payload, { onConflict: "wrike_user_id" });
        if (!error) added++;
      }
      const deptCount = Object.keys(deptMap).length;
      setSyncMsg(`Synced ${added} members · ${deptCount} department assignments from Wrike groups.`);
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

  // While searching, auto-open every department that has a match so results
  // are visible without the user having to expand each group by hand.
  useEffect(() => {
    if (!search.trim()) return;
    setExpanded(prev => {
      const next = { ...prev };
      for (const group of DEPT_GROUPS) {
        if ((buckets[group.label] || []).length > 0) next[group.label] = true;
      }
      return next;
    });
  }, [search, buckets]);

  const toggleGroup = (label) => {
    // Any toggle (opening or closing) starts a height transition, so the
    // clipping needs to be hidden again until it finishes — otherwise a
    // dropdown left open from before the animation started would render
    // past the box's edge mid-transition.
    setSettled(prev => ({ ...prev, [label]: false }));
    setExpanded(prev => ({ ...prev, [label]: !prev[label] }));
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
      <div className="flex items-stretch bg-white border border-[#dce4ec] rounded-2xl overflow-hidden hover:border-slate-300 hover:shadow-sm transition-all">
        {/* Flush to the card's own edges (top/bottom/left), full height —
            clipped to the card's rounded-2xl by the parent's overflow-hidden
            rather than rounding the image itself, so it reads as one card
            with a portrait on the left, not a small avatar floating in
            padding. */}
        {p.avatar_url ? (
          <img src={p.avatar_url} alt={fullName} className="w-28 sm:w-32 shrink-0 object-cover" />
        ) : (
          <div className="w-28 sm:w-32 shrink-0 bg-gradient-to-br from-[#12a0e1] to-[#1cc1a5] text-white flex items-center justify-center font-display font-bold text-lg">
            {initials}
          </div>
        )}
        <div className="flex-1 min-w-0 flex items-center gap-3 p-3.5">
          <div className="flex-1 min-w-0">
            <p className="font-display text-base font-bold text-[#122027] tracking-tight truncate">{fullName}</p>
            <p className="text-xs text-[#768994] truncate">{p.email || p.wrike_user_id}</p>
          </div>
          {/* Same searchable dropdown Job Book uses for its pickers, instead
              of a bare native <select> — the app's one dropdown style. "No
              department"/"No position" are plain entries in the option list
              (StrictSelect is selection-only, no separate clear affordance),
              translated back to null on the way out. */}
          <div className="flex flex-col gap-1.5 shrink-0 w-36 sm:w-40">
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
            <span className="text-[10px] font-black text-[#768994] shrink-0">
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
              className="w-full pl-9 pr-8 py-2 text-sm border border-[#dce4ec] rounded-xl outline-none focus:border-[#12a0e1] focus:ring-2 focus:ring-[#12a0e1]/20 bg-white"
            />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-500">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {syncMsg && <span className="text-[11px] font-medium text-[#768994]">{syncMsg}</span>}
          <button onClick={syncFromWrike} disabled={syncing}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-white border border-[#dce4ec] hover:border-slate-300 text-[#122027] text-xs font-bold rounded-xl transition-all disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing…" : "Sync from Wrike"}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 gap-2 text-[#768994]">
          <RefreshCw className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : people.length === 0 ? (
        <div className="py-16 text-center text-[#768994] text-sm">
          No people yet — click "Sync from Wrike" to pull everyone in the workspace.
        </div>
      ) : filteredPeople.length === 0 ? (
        <div className="py-16 text-center text-[#768994] text-sm">
          No one matches "{search}".
        </div>
      ) : (
        <div className="space-y-3">
          {/* Same HubRow accordion as Administration's own hub, one level
              down — a department header behaves exactly like a group row
              (gradient sweep, chevron rotates open) instead of the small
              colour-pill toggle this used to be. */}
          {DEPT_GROUPS.map(group => {
            const items = buckets[group.label] || [];
            if (items.length === 0) return null;
            const isOpen = !!expanded[group.label];
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
                  />
                </div>
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
                      onAnimationComplete={() => setSettled(prev => ({ ...prev, [group.label]: true }))}
                      style={{ overflow: settled[group.label] ? "visible" : "hidden" }}
                      className="bg-slate-50 border-t border-[#dce4ec] rounded-b-2xl"
                    >
                      <div className="grid grid-cols-1 xl:grid-cols-2 gap-2.5 p-3">
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

// ── Main Management Page ───────────────────────────────────────────────────────
// Placeholder for report tabs whose data model isn't built yet, so the IA is
// visible and honest about what's coming rather than silently missing.
function ComingSoon({ icon: Icon, title, body, note }) {
  return (
    <div className="flex flex-col items-center text-center py-16 px-6">
      <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#122027] to-[#12a0e1] flex items-center justify-center shadow-lg mb-5">
        {Icon && <Icon className="w-7 h-7 text-white" />}
      </div>
      <span className="text-[10px] font-black uppercase tracking-widest text-[#12a0e1] mb-1">Coming soon</span>
      <h3 className="font-display text-2xl font-bold text-[#122027] tracking-tight">{title}</h3>
      {body && <p className="text-sm text-[#768994] mt-2 max-w-md leading-relaxed">{body}</p>}
      {note && (
        <p className="text-xs text-[#768994] mt-4 max-w-md bg-slate-50 border border-[#dce4ec] rounded-xl px-4 py-3 leading-relaxed">
          {note}
        </p>
      )}
    </div>
  );
}

// Push/pop panel slide — drilling in slides the new panel in from the
// right (direction 1), going back slides the previous panel in from the
// left (direction -1). Same shape as the page-swap fade in App.jsx, just
// with a horizontal offset since this is a nested navigation stack, not a
// full page change.
const HUB_SLIDE_VARIANTS = {
  initial: (dir) => ({ x: dir > 0 ? 28 : -28, opacity: 0 }),
  animate: { x: 0, opacity: 1, transition: { duration: 0.22, ease: [0.25, 0.1, 0.25, 1] } },
  exit: (dir) => ({ x: dir > 0 ? -28 : 28, opacity: 0, transition: { duration: 0.16, ease: [0.25, 0.1, 0.25, 1] } }),
};

export default function Management({ wrikeUserId, department, wrikeData = [] }) {
  // expandedGroup is purely a display toggle — which group's items are
  // unfolded inline on the hub, an accordion, not a navigation state.
  // activeTab is the real navigation: null means "still on the hub"
  // (accordion open or not), a value means "showing that item's content".
  const [expandedGroup, setExpandedGroup] = useState(null);
  const [activeTab, setActiveTab] = useState(null);
  // Tracks which way the content panel should slide: forward opening an
  // item, backward returning to the hub.
  const [navDirection, setNavDirection] = useState(1);

  const toggleGroup = (id) => setExpandedGroup((g) => (g === id ? null : id));
  const openItem = (id) => { setNavDirection(1); setActiveTab(id); };
  // The accordion stays exactly as it was — going back doesn't collapse
  // the group you were just looking at.
  const backToHub = () => { setNavDirection(-1); setActiveTab(null); };

  // Administration is a first-class page for PMs; the hardcoded allowlist
  // remains as an admin override for everyone else.
  const hasAccess =
    department === "PM" ||
    MANAGEMENT_IDS.length === 0 ||
    MANAGEMENT_IDS.includes(wrikeUserId);
  if (!hasAccess) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center">
        <div className="bg-white border border-[#dce4ec] rounded-3xl p-10 text-center max-w-sm shadow-xl">
          <div className="w-14 h-14 bg-rose-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Shield className="w-7 h-7 text-rose-500" />
          </div>
          <h2 className="text-xl font-black text-[#122027] mb-2">Access Restricted</h2>
          <p className="text-sm text-[#768994]">This page is for management only.</p>
          {wrikeUserId && (
            <p className="text-[10px] font-mono mt-3 text-slate-400 bg-slate-50 rounded-lg p-2">
              Your ID: {wrikeUserId}
            </p>
          )}
        </div>
      </div>
    );
  }

  const nav = activeTab ? findNavItem(activeTab) : null;

  return (
    <div className="min-h-screen bg-slate-100 text-[#122027] font-sans pb-16">
      {/* Full-bleed gradient header — same PageHeader treatment as every
          other page, so the Home wash resolves into it (see pageGradients). */}
      <PageHeader
        pageId="management"
        icon={Shield}
        title="Administration"
        subtitle="Reports · Staff Accounts · Supporting Content"
      >
        {MANAGEMENT_IDS.length === 0 && (
          <div className="flex items-center gap-2 bg-white/15 border border-white/20 backdrop-blur-sm rounded-xl px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-300 shrink-0" />
            <p className="text-[10px] font-bold text-white/90">
              Add your Wrike ID to <code className="font-mono">MANAGEMENT_IDS</code> in Management.jsx
            </p>
          </div>
        )}
      </PageHeader>

      <div className="max-w-[1800px] mx-auto px-4 sm:px-6 pt-6 pb-6 overflow-hidden">
        {/* The hub (with its accordion) and an open item's content are the
            only two panels that ever swap — the accordion itself doesn't
            trigger this, it's a height animation inside the hub panel.
            overflow-hidden on the parent clips the 28px travel so nothing
            peeks past the edge mid-transition. */}
        <AnimatePresence mode="wait" custom={navDirection} initial={false}>
          <motion.div
            key={nav ? `item:${nav.item.id}` : "hub"}
            custom={navDirection}
            variants={HUB_SLIDE_VARIANTS}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            {!nav && (
              <AdminHub
                expandedGroup={expandedGroup}
                onToggleGroup={toggleGroup}
                onOpenItem={openItem}
              />
            )}

            {/* The item's actual content */}
            {nav && (
              <div>
                <div className="flex items-center gap-3 mb-4">
                  <button
                    onClick={backToHub}
                    className="flex items-center gap-1.5 text-xs font-bold text-[#768994] hover:text-[#122027] bg-white border border-[#dce4ec] hover:border-slate-300 rounded-xl px-3 py-2 shadow-sm transition-all"
                  >
                    <ChevronLeft className="w-4 h-4" /> Administration
                  </button>
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className={`w-8 h-8 rounded-xl bg-gradient-to-br ${nav.group.gradient} flex items-center justify-center text-white shadow-sm shrink-0`}>
                      <nav.item.icon className="w-4 h-4" />
                    </div>
                    <h2 className="font-display text-xl font-bold text-[#122027] tracking-tight truncate">{nav.item.label}</h2>
                  </div>
                </div>

                <div className="bg-white border border-[#dce4ec] rounded-2xl p-6 shadow-sm">
                  {/* Project/Time is the logged-time-per-job feed — same
                      component Job Book uses (JobsFeedSection), not a separate
                      report. */}
                  {activeTab === "project-time" && <JobsFeedSection />}
                  {activeTab === "studio-analytics" && <StudioAnalytics wrikeData={wrikeData} />}
                  {activeTab === "timesheet-completion" && (
                    <ComingSoon
                      icon={ClipboardList}
                      title="Staff Timesheet Completion"
                      body="A live list of which staff haven't submitted their timesheet for a given week, so it's obvious at a glance who still needs to."
                      note="Buildable from submitted tasks vs the staff roster — flagged as the next report to build."
                    />
                  )}
                  {activeTab === "people"     && <PeopleSection />}
                  {activeTab === "films"      && <SimpleListSection table="films" labelField="title" label="Films" placeholder="Film title…" />}
                  {activeTab === "clients"    && <SimpleListSection table="clients" labelField="name" label="Clients" quickFilters={STUDIO_GROUPS} quickFilterLabel="Filter by studio" />}
                  {activeTab === "categories" && <SimpleListSection table="job_categories" labelField="name" label="Item Categories" groups={CATEGORY_GROUPS} />}
                  {activeTab === "descs"      && <SimpleListSection table="project_descriptions" labelField="description" label="Project Type Descriptions" isLong quickFilters={DESC_QUICK_FILTERS} quickFilterLabel="Filter by territory" groups={DESCRIPTION_GROUPS} />}
                  {activeTab === "positions"  && <SimpleListSection table="positions" labelField="title" label="Positions" placeholder="e.g. Creative Director…" />}
                  {activeTab === "translations" && <SimpleListSection table="translation_countries" labelField="name" label="Translation Countries" placeholder="e.g. France…" />}
                  {activeTab === "departments"  && <SimpleListSection table="job_departments" labelField="name" label="Departments" placeholder="e.g. Print…" />}
                  {activeTab === "orgchart"     && <OrgChart />}
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
