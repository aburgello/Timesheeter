import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Briefcase, Film, Users, Tag, AlignLeft, Building2,
  Plus, Pencil, Trash2, X, Check, Search,
  RefreshCw, Shield, AlertTriangle, ChevronLeft, ChevronRight,
  ArrowUpAZ, ArrowDownAZ, CheckCircle2,
  FolderPlus, Folder, FolderOpen, Sparkles, Loader2,
  FileBarChart, ClipboardList, Globe, Layers, Download, Network, TrendingUp,
  Undo2, UploadCloud, Eye, ListChecks, Banknote,
} from "lucide-react";
import { supabase, selectAll } from "../lib/supabaseClient";
import { parseCsv, mapCsvRows } from "../utils/csv";
import { parseTimeToSeconds, parseTimeToHours, secondsToHM } from "../utils/timeHelpers";
import { confirmAction } from "../lib/confirm";
import { notify } from "../lib/toast";
import {
  discoverJobNumberField, planFilmSync, fetchAllFolders, findStudioFolder,
  findMasterTemplateFolder, fetchFolderProjects, collectSubtreeIds, findFilmLocation,
  planPropagate, applyPropagate, copyTemplateDeep,
  mapSlotFoldersUnder, pickSlotFolder, slotSuffix, renameFolder, buildFilmView,
  setFolderJobNumber, triggerFieldCascade, scanStudioJobNumbers,
  discoverItemPriceField, fetchFolderItemPrice, descriptionsAgree,
} from "../lib/wrikeCampaign";
import { isServiceAccount, DEPT_GROUPS } from "../lib/people";
import { layoutRect } from "../utils/zoom";
import { useColumnResize } from "../lib/useColumnResize";
import { SEED_CLIENTS, SEED_PROJECT_DESCRIPTIONS } from "../data/seedData";
import { CATEGORIES } from "../constants";
import { builtInAliasesFor } from "../utils/countryCodes";
import { loadCountryAliases } from "../lib/countryAliases";
import { fullName as cleanFullName, cleanNamePart } from "../lib/formatName";
import PageHeader from "./shared/PageHeader";
import HubRow from "./shared/HubRow";
import DateField from "./shared/DateField";
import OrgChart from "./OrgChart";
import StudioAnalytics from "./StudioAnalytics";

// SEED_FILMS is gone with DEFAULT_JOBS. It only ever rendered a "seed this
// table" button while `films` was empty, and that table has been populated for
// a while — Film Setup pulls films straight from Wrike (planFilmSync), which is
// a better source than film titles scraped out of a hardcoded job catalogue.

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
      { id: "rates", label: "Positions & Rates", icon: Banknote, desc: "Job titles, what each bills per hour, and item-category overrides" },
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
      { id: "work-categories", label: "Job Work Categories", icon: Tag, desc: "The work category set on a job itself" },
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

// The open item as read from `#management/<section>`. Validated against
// NAV_GROUPS, so a stale or hand-edited link lands on the hub rather than on a
// panel that renders nothing.
const sectionFromHash = () => {
  const [page, section] = window.location.hash.slice(1).split("/");
  return page === "management" && section && findNavItem(section) ? section : null;
};

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

// ── Country alias editor ─────────────────────────────────────────────────────
// One row's worth of aliases, shown inline against its country in Translation
// Countries. Two kinds sit side by side:
//
//   built-in  — read from CODE_LOOKUP itself (builtInAliasesFor), so what's
//               shown is what actually resolves rather than a second list that
//               can drift from it. Not editable here; they live in constants.js
//               and include MAGI's own sheet, which stays a verbatim copy.
//   curated   — rows in country_aliases, added freely and removed freely. They
//               are consulted FIRST, so adding one that matches a built-in
//               re-points it, and adding a new one extends the set.
//
// Uniqueness is global and normalised (upper, punctuation stripped) because an
// alias is a lookup key: "BE-FL" and "befl" are the same key, and two rows
// claiming it would make resolution depend on row order. The DB enforces it;
// this checks first so the failure is a sentence rather than a constraint error.
const ALIAS_KEY = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// The eight codes that are also ordinary English words. Adding one of these as
// an alias is allowed — production may have a good reason — but it's called out,
// because these are the codes that read countries out of prose when they land
// somewhere unanchored (see countryCodes.js and the Norway incident).
const RISKY_ALIAS_KEYS = new Set(["NO", "IN", "IT", "AT", "BE", "US", "IS", "MY"]);

// `open`/`onToggle`/`onClose` are owned by the list, not by each row, so only
// one panel can be open at a time — three of these stacked over each other was
// the first thing that went wrong on screen.
function CountryAliasEditor({ territory, aliases, onChanged, open, onToggle, onClose }) {
  const [adding, setAdding] = useState("");
  const [busy, setBusy]     = useState(false);
  const [err, setErr]       = useState("");

  // A centred modal rather than a popover anchored to its row. Anchoring was
  // tried twice — nested (clipped by the list) and portaled with computed
  // coordinates (landed rows above its own row under html{zoom:1.1}) — and it
  // was never buying much: the panel names the country in its heading, so it
  // doesn't need to touch the row to say what it belongs to. This drops the
  // whole coordinate problem, can't clip, and reuses the modal shell the rest
  // of this file already uses, which the dark-theme sheet covers.
  //
  // Escape closes it; click-away is handled by the modal backdrop below.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && onClose?.();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // A half-typed alias and its error shouldn't be waiting there next time.
  useEffect(() => {
    if (!open) { setAdding(""); setErr(""); }
  }, [open]);

  const builtIn = useMemo(() => builtInAliasesFor(territory), [territory]);
  const mine    = aliases || [];

  const add = async () => {
    const value = adding.trim();
    if (!value) return;
    const key = ALIAS_KEY(value);
    if (!key) { setErr("An alias needs at least one letter or number."); return; }

    const clash = mine.find((a) => ALIAS_KEY(a.alias) === key);
    if (clash) { setErr(`"${clash.alias}" is already on this country.`); return; }

    setBusy(true); setErr("");
    const { error } = await supabase
      .from("country_aliases")
      .insert({ alias: value, territory });
    setBusy(false);

    if (error) {
      // The unique index is on the normalised alias across every country, so
      // the usual cause is that another country already claims this code.
      setErr(
        error.code === "23505"
          ? `"${value}" is already used as an alias for another country.`
          : "Couldn't save that alias."
      );
      return;
    }
    setAdding("");
    onChanged?.();
  };

  const remove = async (id) => {
    setBusy(true);
    await supabase.from("country_aliases").delete().eq("id", id);
    setBusy(false);
    onChanged?.();
  };

  const riskyPending = RISKY_ALIAS_KEYS.has(ALIAS_KEY(adding));

  return (
    <div className="shrink-0 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      {mine.slice(0, open ? mine.length : 3).map((a) => (
        <span key={a.id}
          className="px-1.5 py-0.5 rounded-md bg-[#12a0e1]/10 text-[#0d8bc4] text-[10px] font-bold tracking-wide">
          {a.alias}
        </span>
      ))}
      {!open && mine.length > 3 && (
        <span className="text-[10px] font-bold text-[#768994]">+{mine.length - 3}</span>
      )}
      <button
        onClick={onToggle}
        title={`Aliases for ${territory}`}
        className="p-1 rounded-lg text-slate-400 hover:text-[#12a0e1] hover:bg-slate-100"
      >
        <Tag className="w-3 h-3" />
      </button>

      {open && createPortal(
        // Same shell as this file's other modals, so the dark-theme sheet —
        // which keys off Tailwind class names — covers it without any
        // per-element dark styling here. onMouseDown, like the others: closes
        // before blur rather than racing it.
        <div className="fixed inset-0 z-[9999] bg-[#122027]/60 backdrop-blur-sm flex items-center justify-center p-4"
          onMouseDown={() => onClose?.()}>
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md border border-[#dce4ec] overflow-hidden text-left"
            onMouseDown={(e) => e.stopPropagation()}>

            <div className="px-5 pt-4 pb-3 border-b border-[#dce4ec]">
              <p className="text-[9px] font-black uppercase tracking-widest text-[#12a0e1] mb-0.5">Aliases</p>
              <h2 className="text-lg font-black text-[#122027]">{territory}</h2>
            </div>

            <div className="p-5">
              <div className="flex gap-2 mb-3">
                <input
                  autoFocus
                  value={adding}
                  onChange={(e) => { setAdding(e.target.value); setErr(""); }}
                  onKeyDown={(e) => e.key === "Enter" && add()}
                  placeholder="Add alias…"
                  className="flex-1 min-w-0 text-sm border border-[#dce4ec] rounded-lg px-3 py-1.5 outline-none focus:border-[#12a0e1] focus:ring-2 focus:ring-[#12a0e1]/20 bg-white text-[#122027]"
                />
                <button onClick={add} disabled={busy || !adding.trim()}
                  className="shrink-0 px-3 py-1.5 rounded-lg bg-[#12a0e1] text-white text-xs font-bold hover:bg-[#0d8bc4] disabled:opacity-40">
                  Add
                </button>
              </div>

              {riskyPending && (
                <p className="text-[11px] text-yellow-700 bg-yellow-50 border border-yellow-200 rounded-lg px-2.5 py-2 mb-3">
                  “{adding.trim()}” is also an ordinary English word. It'll be
                  read as {territory} wherever someone writes it deliberately —
                  at the end of a task name, on a folder, in the Country field —
                  but it stays refused in unidentified custom fields, which is
                  what stopped a boolean “No” being read as Norway.
                </p>
              )}
              {err && <p className="text-[11px] text-rose-600 mb-3">{err}</p>}

              {mine.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-4">
                  {mine.map((a) => (
                    <span key={a.id}
                      className="group/alias inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-blue-50 text-blue-700 text-xs font-bold">
                      {a.alias}
                      <button onClick={() => remove(a.id)} disabled={busy}
                        className="text-slate-400 hover:text-rose-500">
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {builtIn.length > 0 && (
                <>
                  <p className="text-[9px] font-black uppercase tracking-widest text-[#768994] mb-1.5">
                    Built in
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {builtIn.map((b) => (
                      <span key={b} title="Defined in code — add the same alias above to re-point it"
                        className="px-2 py-1 rounded-lg bg-slate-200 text-slate-700 text-xs font-bold">
                        {b}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// Translation Countries + their aliases. Wraps the generic list rather than
// extending it: the alias rows are a second table, fetched once for the whole
// list here instead of once per row, and re-read after every edit so the
// resolver's overlay and the UI never disagree about what's saved.
function TranslationCountriesSection() {
  const [byTerritory, setByTerritory] = useState({});
  // Which row's alias panel is open — one at a time, owned here.
  const [openFor, setOpenFor] = useState(null);
  // Stable identity, so the editor's click-away listener isn't torn down and
  // rebuilt on every render of the list.
  const closePanel = useCallback(() => setOpenFor(null), []);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("country_aliases")
      .select("id,alias,territory")
      .order("alias");
    const grouped = {};
    for (const row of data || []) (grouped[row.territory] ||= []).push(row);
    setByTerritory(grouped);
    // Push the same rows into the resolver, so an alias added here is live for
    // the next Wrike pull without a reload.
    await loadCountryAliases({ force: true });
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <SimpleListSection
      table="translation_countries"
      labelField="name"
      label="Translation Countries"
      placeholder="e.g. France…"
      renderRowExtra={(item) => (
        <CountryAliasEditor
          territory={item.name}
          aliases={byTerritory[item.name]}
          onChanged={load}
          open={openFor === item.name}
          onToggle={() => setOpenFor((cur) => (cur === item.name ? null : item.name))}
          onClose={closePanel}
        />
      )}
    />
  );
}

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
function SimpleListSection({ table, labelField = "name", label, placeholder, isLong = false, quickFilters = [], quickFilterLabel = "Quick filters", groups = [], wrikeFilmSync = false, onItemClick, renderRowExtra }) {
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
                      {visibleItems.map(item => {
                        const text        = item[labelField] || "";
                        const displayText = group.stripPrefix ? text.replace(group.stripPrefix, "") : text;
                        const isEditing   = editId === item.id;
                        return (
                          <div key={item.id}
                            className={`group/item flex items-center gap-2.5 px-3.5 py-3 bg-white border rounded-2xl
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
          {paginated.map(item => {
            const text   = item[labelField] || "";
            const first  = text.charAt(0).toUpperCase() || "?";
            const [avatarCls, borderCls] = letterPalette(first);
            const isEditing = editId === item.id;
            return (
              <div key={item.id}
                className={`group flex items-center gap-3 p-3.5 bg-white border rounded-2xl
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
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
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

// ── Modal field sub-components — defined at module level so React never
//    remounts them mid-keystroke (defining inside a component = new type each render).
const MODAL_INPUT = "w-full border border-[#dce4ec] rounded-2xl px-4 py-2.5 text-sm text-[#122027] outline-none focus:border-[#12a0e1] focus:ring-2 focus:ring-[#12a0e1]/15 bg-white placeholder-[#b0bec5] transition-[border-color,box-shadow] ease-[cubic-bezier(0.16,1,0.3,1)]";

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
// `limit` caps how many rows render at once. The default keeps the original
// behaviour for the pickers that have always used it; callers with genuinely
// long lists (a year and a half of weeks, 65 item categories) raise it so the
// tail isn't reachable only by typing.
function StrictSelect({ value, onChange, options, placeholder, loading, className = "", limit = 60 }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const btnRef = useRef(null);

  const hits = useMemo(() => {
    if (!q) return options.slice(0, limit);
    return options.filter(o => o.toLowerCase().includes(q.toLowerCase())).slice(0, limit);
  }, [options, q, limit]);

  const toggle = () => {
    // layoutRect, not getBoundingClientRect: the panel below is position:fixed
    // and styled from this rect, so under html{zoom:1.1} a raw (visual) rect
    // would be zoomed a second time on paint and land offset from the button.
    if (!open) setRect(layoutRect(btnRef.current));
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
    const reposition = () => setRect(layoutRect(btnRef.current));
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
              {hits.length === 0 && <p className="px-4 py-3 text-sm text-[#768994]">No matches</p>}
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
              className={`px-3.5 py-2 rounded-xl text-xs font-bold border transition-[background-color,border-color,color,box-shadow] ease-[cubic-bezier(0.16,1,0.3,1)] ${
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

// Allocate the next sequential XY code. selectAll is essential here, not just
// tidier: this scans for the HIGHEST code in use, and a truncated read returns a
// max that's thousands too low — every allocation then collides with an existing
// job number. Reads jobs AND tasks, since either can carry the newest code.
async function nextJobCode() {
  const [jobRows, taskRows] = await Promise.all([
    selectAll("jobs", "job_number"),
    selectAll("tasks", "job_number"),
  ]);
  let maxNum = 0;
  [...jobRows, ...taskRows].forEach(r => {
    const m = (r.job_number || "").match(/XY(\d+)/);
    if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
  });
  return `XY${String(maxNum + 1).padStart(6, "0")}`;
}

// ── Job Form ───────────────────────────────────────────────────────────────────
// Fields + footer for creating/editing a Job Book row. Shared by JobModal (edit,
// from Job Book) and the Custom Job tab in Jobs Setup (create) — same form,
// different chrome around it (layout="modal" adds the fixed-footer/scroll
// behaviour a popup needs; layout="inline" just flows in the page).
function JobForm({ job, clients, films, workCategories, descs, onSave, onCancel, saving, submitLabel, layout = "modal", presetCode = null }) {
  const isEdit = !!job?.id;
  const [orderedByOpts, setOrderedByOpts] = useState([]);
  const [billedToOpts, setBilledToOpts]   = useState([]);
  // e.g. "XY025999" — allocated once when creating a new job. The Bulk Campaign
  // flow allocates it up front (so the folder preview can show the code the job
  // will get) and passes it in; standalone creation allocates its own below.
  const [nextCode, setNextCode] = useState(presetCode);

  useEffect(() => {
    // Whole table: a truncated read silently drops whole clients from these
    // pickers, which reads as "that option doesn't exist".
    selectAll("jobs", "ordered_by, billed_to", (q) =>
      q.not("ordered_by", "is", null).neq("ordered_by", "")
    ).then((data) => {
      setOrderedByOpts([...new Set(data.map(r => r.ordered_by).filter(Boolean))].sort());
      setBilledToOpts([...new Set(data.map(r => r.billed_to).filter(Boolean))].sort());
    });
  }, []);

  // New jobs get the next sequential XY code auto-allocated, same source of truth
  // (max across jobs + tasks) as the Bulk Campaign flow — never manually typed.
  useEffect(() => {
    if (isEdit || presetCode) return;
    nextJobCode().then(setNextCode);
  }, [isEdit, presetCode]);

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
  // Open from the start, creating or editing: the billing fields are filled in
  // at creation often enough that hiding them behind a disclosure just adds a
  // click. Still collapsible.
  const [showAdmin, setShowAdmin] = useState(true);
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
          {/* Job Work Category — the job-level taxonomy (AUS - Publicity, …).
              NOT the Item Categories list (Digital - Retouching, …), which is
              picked per timesheet line; this field was wrongly pointed at that
              one. Territory-prefixed like project descriptions, so it groups
              the same way. */}
          <ComboField label="Job Work Category" value={form.job_work_category}
            onChange={v => set("job_work_category", v)}
            options={workCategories} placeholder="Search job work categories…"
            groupBy={descGroup} formatOption={descLabel} groupOrder={DESC_GROUP_ORDER} />
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
                  className={`flex items-center gap-2.5 w-full px-4 py-2.5 rounded-xl border font-bold text-sm transition-[background-color,border-color,color] ease-[cubic-bezier(0.16,1,0.3,1)] ${
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
            className="px-5 py-2.5 text-sm font-bold text-[#768994] hover:text-[#122027] bg-white border border-[#dce4ec] rounded-xl transition-[color] ease-[cubic-bezier(0.16,1,0.3,1)]">
            Cancel
          </button>
        )}
        <button onClick={handleSave} disabled={saving || !canSave}
          className={`flex items-center gap-2 px-6 py-2.5 text-white text-sm font-bold rounded-xl transition-[background-color] ease-[cubic-bezier(0.16,1,0.3,1)] disabled:opacity-50 shadow-sm ${
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
function JobModal({ job, clients, films, workCategories, descs, onSave, onClose, saving }) {
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

        <JobForm job={job} clients={clients} films={films} workCategories={workCategories} descs={descs}
          onSave={onSave} onCancel={onClose} saving={saving} layout="modal" />
      </div>
    </div>
  );
}

// ── Shared shell for the Wrike dry-run / apply modals ─────────────────────────
// Both Wrike-writing flows (film sync, push+propagate) follow the same shape:
// run a read-only plan on open, show what WOULD change, then write only on an
// explicit "Apply" click. This shell provides the frame; each flow supplies the
// preview body and the apply handler.
function WrikeApplyShell({ title, subtitle, accent = "#12a0e1", onClose, children }) {
  return (
    <div className="fixed inset-0 z-[9999] bg-[#122027]/60 backdrop-blur-sm flex items-center justify-center p-4"
      onMouseDown={onClose}>
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg max-h-[92vh] flex flex-col overflow-hidden border border-[#dce4ec]"
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="px-6 pt-5 pb-4 border-b border-[#dce4ec] flex items-center justify-between shrink-0">
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest mb-0.5" style={{ color: accent }}>Wrike · dry run</p>
            <h2 className="text-xl font-black text-[#122027]">{title}</h2>
            {subtitle && <p className="text-xs text-[#768994] mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-xl text-slate-400 hover:text-slate-600 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Req 6 — preview + apply the Film DB sync from Wrike's studio-folder projects.
// Read-only until "Add N films": additive only (never deletes local films).
function FilmSyncModal({ studio: initialStudio = "Paramount", existingFilms, onClose, onApplied }) {
  const [studio, setStudio] = useState(initialStudio);
  const [plan, setPlan] = useState(null); // { error, studioFolder, projectCount, toAdd }
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setPlan(null);
    planFilmSync(studio, existingFilms)
      .then((p) => alive && setPlan(p))
      .catch((e) => alive && setPlan({ error: e.message, toAdd: [] }))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [studio, existingFilms]);

  const apply = async () => {
    if (!plan?.toAdd?.length) return;
    setApplying(true);
    const rows = plan.toAdd.map((title) => ({ title }));
    const { error } = await supabase.from("films").insert(rows);
    setApplying(false);
    if (error) { notify("Film sync failed: " + error.message, "error"); return; }
    notify(`Added ${rows.length} film${rows.length === 1 ? "" : "s"} from Wrike.`, "success");
    onApplied?.();
    onClose();
  };

  return (
    <WrikeApplyShell title="Sync films from Wrike" accent="#1cc1a5"
      subtitle={`Projects inside the ${studio} folder → Films`} onClose={onClose}>
      <div className="px-6 py-5 overflow-y-auto flex-1">
        {/* Which studio folder to pull film projects from. */}
        <div className="flex items-center gap-2 mb-4">
          <span className="text-[10px] font-black uppercase tracking-widest text-[#768994] mr-1">Studio</span>
          {STUDIO_OPTIONS.map((s) => (
            <button key={s} onClick={() => setStudio(s)}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-[background-color,border-color,color] ease-[cubic-bezier(0.16,1,0.3,1)] ${
                studio === s
                  ? "bg-[#122027] text-white border-[#122027]"
                  : "bg-white text-[#122027] border-[#dce4ec] hover:border-[#1cc1a5]"
              }`}>
              {s}
            </button>
          ))}
        </div>
        {loading ? (
          <div className="flex items-center gap-2 text-[#768994] py-8 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Reading {studio} projects from Wrike…
          </div>
        ) : plan?.error ? (
          <div className="text-sm font-bold text-rose-500 py-6 text-center">{plan.error}</div>
        ) : (
          <>
            <div className="flex items-center gap-2 text-xs text-[#768994] mb-4">
              <FolderOpen className="w-4 h-4 text-[#f4b740]" />
              Found <span className="font-bold text-[#122027]">{plan.studioFolder?.title}</span> ·
              {" "}{plan.projectCount} project{plan.projectCount === 1 ? "" : "s"} in Wrike
            </div>
            {plan.toAdd.length === 0 ? (
              <div className="flex items-center gap-2 text-sm font-bold text-[#1cc1a5] py-6 justify-center">
                <CheckCircle2 className="w-4 h-4" /> Films are already in sync — nothing to add.
              </div>
            ) : (
              <>
                <p className="text-[10px] font-black uppercase tracking-widest text-[#768994] mb-2">
                  {plan.toAdd.length} new film{plan.toAdd.length === 1 ? "" : "s"} to add
                </p>
                <div className="border border-[#dce4ec] rounded-2xl divide-y divide-[#f0f4f8] max-h-[320px] overflow-y-auto">
                  {plan.toAdd.map((t) => (
                    <div key={t} className="flex items-center gap-2 px-4 py-2 text-sm text-[#122027]">
                      <Film className="w-3.5 h-3.5 text-[#12a0e1] shrink-0" /> {t}
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
      <div className="px-6 py-4 border-t border-[#dce4ec] flex items-center justify-end gap-2 shrink-0">
        <button onClick={onClose}
          className="px-5 py-2.5 text-sm font-bold text-[#768994] hover:text-[#122027] bg-white border border-[#dce4ec] rounded-xl transition-[color] ease-[cubic-bezier(0.16,1,0.3,1)]">
          Cancel
        </button>
        <button onClick={apply} disabled={applying || loading || !plan?.toAdd?.length}
          className="flex items-center gap-2 px-6 py-2.5 bg-[#1cc1a5] hover:bg-[#17a892] text-white text-sm font-bold rounded-xl transition-[background-color] ease-[cubic-bezier(0.16,1,0.3,1)] disabled:opacity-40">
          {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
          {plan?.toAdd?.length ? `Add ${plan.toAdd.length} film${plan.toAdd.length === 1 ? "" : "s"}` : "Nothing to add"}
        </button>
      </div>
    </WrikeApplyShell>
  );
}

// Small ✓/✗ precondition row for the push preview.
function CheckRow({ ok, label, value, warn }) {
  const Icon = ok ? CheckCircle2 : warn ? AlertTriangle : X;
  const color = ok ? "#1cc1a5" : warn ? "#f4b740" : "#f43f5e";
  return (
    <div className="flex items-start gap-2 py-1.5">
      <Icon className="w-4 h-4 shrink-0 mt-0.5" style={{ color }} />
      <div className="min-w-0">
        <p className="text-xs font-bold text-[#122027]">{label}</p>
        {value && <p className="text-[11px] text-[#768994] truncate">{value}</p>}
      </div>
    </div>
  );
}

// Reqs 5 + 1 — duplicate the studio template into the film's Wrike project, then
// set the Job Number custom field on every task/subtask beneath each activated
// slot's folder. The preview validates every precondition against LIVE Wrike
// data on open (template found? film project found? field found?) and refuses to
// write unless they all hold — the safety net for shipping without local Wrike
// auth to test against.
// mode "push"  — duplicate template into the film project, then tag (reqs 5+1).
// mode "retag" — skip the copy; re-tag the film project's existing job folders,
//                topping up items added/renamed since (reqs 2 + 4).
function PushToWrikeModal({ studio, filmTitle, jobs, mode = "push", onClose }) {
  const isRetag = mode === "retag";
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState(null); // { step, done, total }
  const [result, setResult] = useState(null);      // { propagated, failed, skipped }
  const [targetId, setTargetId] = useState("");    // chosen Wrike project id (film picker)

  // Activated jobs, with the code we'll write as the field value. Identified by
  // job id, not slot label: the same slot can hold several jobs (two launches off
  // one template folder), and keying by label would merge them into one row.
  const slots = useMemo(() => jobs.map((j) => ({
    id: j.id,
    label: j.template_slot,
    jobNumber: j.job_number,
    code: (j.job_number?.match(/XY\d+/) || [])[0] || j.job_number,
  })), [jobs]);

  // Which activated jobs to actually tag — all by default; unchecking one in the
  // preview drops it from this push (its Job Book row is untouched).
  const [excluded, setExcluded] = useState(() => new Set());
  const selectedSlots = useMemo(() => slots.filter((s) => !excluded.has(s.id)), [slots, excluded]);
  const toggleSlot = (id) => setExcluded((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [field, byId] = await Promise.all([discoverJobNumberField(), fetchAllFolders()]);
        const template = findMasterTemplateFolder(byId, studio);
        const studioFolder = findStudioFolder(byId, studio);
        const projects = studioFolder ? await fetchFolderProjects(studioFolder.childIds) : [];
        // Auto-pick the best match so the common case is one glance. Compare
        // underscore/space-insensitively, since the DB film title is spaced but
        // the Wrike project name is underscored (Angry_Birds_3_Movie).
        const norm = (s) => (s || "").toLowerCase().replace(/[_\s]+/g, " ").trim();
        const wanted = norm(filmTitle);
        const exact = projects.find((p) => norm(p.title) === wanted);
        const close = exact || projects.find((p) => {
          const t = norm(p.title);
          return wanted && (t.includes(wanted) || wanted.includes(t));
        });
        // Guard set: every folder id inside the master template. We refuse to
        // copy into it or write a field on anything within it.
        const templateIds = template ? collectSubtreeIds(byId, template.id) : new Set();
        if (alive) {
          setPlan({ field, template, studioFolder, projects, templateIds, byId });
          setTargetId(close?.id || "");
        }
      } catch (e) {
        if (alive) setError(e.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [studio, filmTitle]);

  // The chosen target project (picker selection resolved against the plan).
  const filmProject = useMemo(
    () => plan?.projects?.find((p) => p.id === targetId) || null,
    [plan, targetId]
  );
  const canApply = plan && plan.field && filmProject && (isRetag || plan.template) && !applying;

  // Slots already done — a live Wrike folder is already named with THIS job's
  // code (read straight from plan.byId, so it's accurate even for old pushes).
  // These are pre-unchecked so re-pushing only touches genuinely new slots.
  //
  // Collects every folder sharing a suffix, not just one. When two jobs sit on
  // the same slot, keeping a single title per suffix meant one job's folder
  // decided both jobs' status: whichever title survived, the other job either
  // read as done when nothing had been written for it, or read as pending while
  // its folder existed. A job is done only if a folder carries its own code.
  const doneSlots = useMemo(() => {
    const done = new Set();
    if (!plan?.byId || !filmProject) return done;
    const bySuffix = {};
    const walk = (id) => {
      const n = plan.byId[id];
      if (!n) return;
      if (/^(JOBNUMBER|XY\d+)_/i.test(n.title || "")) {
        (bySuffix[slotSuffix(n.title)] ||= []).push(n.title);
      }
      (n.childIds || []).forEach(walk);
    };
    walk(filmProject.id);
    slots.forEach((s) => {
      const live = bySuffix[slotSuffix(s.label)] || [];
      if (live.some((t) => new RegExp(`^${s.code}_`, "i").test(t))) done.add(s.id);
    });
    return done;
  }, [plan, filmProject, slots]);

  // Once the plan resolves, default the already-done slots to unchecked so the
  // common re-push does nothing redundant. Runs once; the user can re-check any.
  const inited = useRef(false);
  useEffect(() => {
    if (inited.current || !plan || !filmProject) return;
    inited.current = true;
    if (doneSlots.size) setExcluded(new Set(doneSlots));
  }, [plan, filmProject, doneSlots]);

  const apply = async () => {
    if (!canApply) return;
    setApplying(true);
    setError(null);

    // ── Template-write guard ──────────────────────────────────────────────
    // Hard stop: the master template must never be a write target. Any folder
    // id inside its subtree is off-limits both as a copy destination and as a
    // tagging target. This is defence-in-depth on top of the fact that copy is
    // read-only on its source — it makes writing to the template physically
    // impossible even if a lookup ever returned the wrong folder.
    const templateIds = plan.templateIds || new Set();
    const inTemplate = (id) => templateIds.has(id);
    const TEMPLATE_GUARD = "Aborted to protect the master template — a target folder resolved inside it. Nothing was written.";

    try {
      if (inTemplate(filmProject.id) || filmProject.id === plan.template?.id) {
        throw new Error(TEMPLATE_GUARD);
      }

      let droppedTaskFolders = [];
      // Rename-resilient map of the project's slot folders (JOBNUMBER_… or
      // already XY#####_…), keyed by stable suffix.
      setProgress({ step: "Checking the film's folders in Wrike…", done: 0, total: 1 });
      let slotFolders = await mapSlotFoldersUnder(filmProject.id);

      // Only duplicate the template when the project is genuinely empty of slot
      // folders. If it already has the structure, we rename/tag in place.
      if (Object.keys(slotFolders).length === 0) {
        if (isRetag) throw new Error("This project has no template folders yet — run Push first.");
        if (!plan.template) throw new Error(`No ${studio} master template found to copy.`);
        // Copy the template's CHILDREN straight into the film project — never the
        // template root as one film-named folder — so the film project doesn't end
        // up with a redundant wrapper folder named after itself. The template's top
        // level already IS the campaign structure (Launch/Print/…).
        const tpl = plan.byId[plan.template.id];
        const children = (tpl?.childIds || []).map((id) => plan.byId[id]).filter(Boolean);
        if (!children.length) throw new Error(`The ${studio} master template has no folders to copy.`);
        const report = { rootId: null, copies: 0, droppedTaskFolders: [] };
        for (const child of children) {
          await copyTemplateDeep({
            byId: plan.byId,
            sourceId: child.id,
            parentId: filmProject.id,
            title: child.title,
            onProgress: (step) => setProgress({ step, done: 0, total: 1 }),
            report,
          });
        }
        if (!report.copies) throw new Error("Wrike copy created nothing.");
        droppedTaskFolders = report.droppedTaskFolders || [];
        setProgress({ step: "Re-reading the copied folders…", done: 0, total: 1 });
        slotFolders = await mapSlotFoldersUnder(filmProject.id);
      }

      // Rename each activated slot's folder to its code, set the Job Number field
      // on the folder, then let Wrike cascade that value down to every subitem.
      //
      // A folder is claimed by IDENTITY, not by slot name. A slot can hold
      // several jobs on purpose, so each needs its own folder; pickSlotFolder
      // hands out the one already bearing this job's code (making a re-push a
      // no-op), else a free "JOBNUMBER_…" one, and NEVER one already carrying a
      // different job's code. A job with no folder available is reported so
      // somebody can make one — the previous version claimed by slot name and
      // could hand a job its neighbour's folder, renaming that neighbour's
      // allocation onto this code.
      const claimedIds = new Set();
      let renamed = 0, cascaded = 0, propagated = 0, failed = 0, skipped = 0, contended = 0;
      for (let i = 0; i < selectedSlots.length; i++) {
        const s = selectedSlots[i];
        const suffix = slotSuffix(s.label);
        const available = slotFolders[suffix] || [];
        const folder = pickSlotFolder(available, s.code, claimedIds);
        if (!folder) {
          // Tell "this slot has no folder at all" apart from "every folder it
          // has is already spoken for" — the first needs a template push, the
          // second needs one more folder in Wrike.
          if (available.length) contended += 1;
          else skipped += 1;
          continue;
        }
        claimedIds.add(folder.id);
        if (inTemplate(folder.id)) throw new Error(TEMPLATE_GUARD); // never write into the template

        const newTitle = `${s.code}_${suffix}`;
        setProgress({ step: `Assigning ${s.code}…`, done: i, total: slots.length });
        if (folder.title !== newTitle) { await renameFolder(folder.id, newTitle); renamed += 1; }

        // Remember which Wrike folder this job now owns, and under what name — so
        // the app can later tell "reverted/renamed in Wrike" from "never pushed"
        // (a job with no folder id was never pushed) and offer to reconcile.
        if (s.id) {
          await supabase.from("jobs")
            .update({ wrike_folder_id: folder.id, wrike_folder_title: newTitle })
            .eq("id", s.id);
        }

        // Fill the slot folder's own Job Number field, then turn on Wrike-native
        // cascading so the value flows down to every current AND future subitem
        // (nested market folders + tasks) — no per-item walk needed.
        try {
          await setFolderJobNumber(folder.id, plan.field.id, s.code);
          await triggerFieldCascade(folder.id, plan.field.id);
          cascaded += 1;
        } catch {
          failed += 1; // keep going with the remaining slots; count surfaces in the summary
        }

        // Belt-and-braces: also tag existing tasks directly. Redundant once cascade
        // is confirmed live, but harmless (same value) and safe if a field's config
        // limits cascade — remove once the cascade path is verified on the account.
        const p = await planPropagate(folder.id, plan.field.id, s.code);
        const r = await applyPropagate(p.willSet, plan.field.id, s.code,
          (d, t) => setProgress({ step: `Tagging ${s.code} tasks…`, done: d, total: t }));
        propagated += r.ok.length;
        failed += r.failed.length;
      }
      setResult({ renamed, cascaded, propagated, failed, skipped, contended, droppedTaskFolders });
      notify(`Wrike updated — ${renamed} folder${renamed === 1 ? "" : "s"} named${cascaded ? `, ${cascaded} cascaded` : ""}${propagated ? `, ${propagated} task${propagated === 1 ? "" : "s"} tagged` : ""}${failed ? `, ${failed} failed` : ""}.`,
        failed ? "error" : "success");
    } catch (e) {
      setError(e.message);
    } finally {
      setApplying(false);
      setProgress(null);
    }
  };

  return (
    <WrikeApplyShell title={isRetag ? "Re-tag new items in Wrike" : "Push to Wrike"}
      subtitle={isRetag
        ? `Top up the Job Number field on new items in “${filmTitle}”`
        : `Name the activated job folders in “${filmTitle}” and tag their tasks`} onClose={onClose}>
      <div className="px-6 py-5 overflow-y-auto flex-1">
        {loading ? (
          <div className="flex items-center gap-2 text-[#768994] py-8 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Checking Wrike…
          </div>
        ) : result ? (
          <div className="py-4 space-y-3 text-center">
            <CheckCircle2 className="w-10 h-10 text-[#1cc1a5] mx-auto" />
            <p className="text-sm font-bold text-[#122027]">
              {isRetag ? `“${filmTitle}” re-tagged in Wrike.` : `“${filmTitle}” updated in Wrike.`}
            </p>
            <p className="text-xs text-[#768994]">
              {result.renamed ? `${result.renamed} folder${result.renamed === 1 ? "" : "s"} named · ` : ""}
              {result.cascaded ? `${result.cascaded} cascaded · ` : ""}
              {result.propagated} task{result.propagated === 1 ? "" : "s"} tagged
              {result.failed ? ` · ${result.failed} failed` : ""}
              {result.skipped ? ` · ${result.skipped} slot${result.skipped === 1 ? "" : "s"} had no matching folder` : ""}
              {result.contended ? ` · ${result.contended} job${result.contended === 1 ? "" : "s"} share a slot whose folder was already claimed` : ""}.
            </p>
            {result.droppedTaskFolders?.length > 0 && (
              <div className="text-left mt-2 px-3 py-2 bg-[#f4b740]/10 border border-[#f4b740]/30 rounded-xl">
                <p className="flex items-center gap-1.5 text-[11px] font-bold text-[#8a6d1a] mb-1">
                  <AlertTriangle className="w-3.5 h-3.5" /> Some container folders were too big to copy whole
                </p>
                <p className="text-[11px] text-[#8a6d1a] leading-snug">
                  Their subfolders (and all tasks inside those) came across fine, but tasks pinned directly to
                  these folders were not copied — add them by hand if needed:
                </p>
                <ul className="mt-1 text-[11px] text-[#8a6d1a] list-disc pl-4">
                  {result.droppedTaskFolders.map((d) => (
                    <li key={d.title}>{d.title} — {d.count} direct task{d.count === 1 ? "" : "s"}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <>
            <p className="text-[10px] font-black uppercase tracking-widest text-[#768994] mb-1">Preconditions</p>
            <div className="border border-[#dce4ec] rounded-2xl px-4 py-2 mb-4">
              <CheckRow ok={!!plan?.field} label="Job Number custom field"
                value={plan?.field ? `“${plan.field.title}”` : "Not found in Wrike — can't tag tasks"} />
              {!isRetag && (
                <CheckRow ok={!!plan?.template} label="Studio master template"
                  value={plan?.template ? `${plan.template.title} · ${plan.template.jobCount} job folders` : `No “${studio}” master template found`} />
              )}
              <CheckRow ok={!!filmProject} label="Target film project in Wrike"
                warn={!filmProject && (plan?.projects?.length > 0)}
                value={filmProject
                  ? `${filmProject.title} (in ${plan.studioFolder?.title || studio})`
                  : plan?.projects?.length
                    ? "Pick the matching project below"
                    : `No projects under ${studio} — sync films first`} />
            </div>

            {/* Film picker — auto-selects the closest match, but you can override
                it (handy when the Wrike project name differs slightly from the
                local film title). This is the folder the template copies into. */}
            {!!plan?.projects?.length && (
              <div className="mb-4">
                <label className="block text-[10px] font-black uppercase tracking-widest text-[#768994] mb-1.5">
                  Target project · {studio}
                </label>
                <StrictSelect
                  value={filmProject?.title || ""}
                  onChange={(title) => {
                    const p = plan.projects.find((x) => x.title === title);
                    setTargetId(p?.id || "");
                  }}
                  options={plan.projects.map((p) => p.title)}
                  placeholder={`Search ${studio} projects…`} />
                <p className="text-[10px] text-[#768994] mt-1">
                  Closest match to “{filmTitle}” is pre-selected — change it if the Wrike name differs.
                </p>
              </div>
            )}

            <p className="text-[10px] font-black uppercase tracking-widest text-[#768994] mb-2">
              {selectedSlots.length} of {slots.length} activated job{slots.length === 1 ? "" : "s"} to tag
              {doneSlots.size > 0 && <span className="text-[#1cc1a5] normal-case font-bold"> · {doneSlots.size} already tagged</span>}
            </p>
            {slots.length === 0 ? (
              <p className="text-xs text-[#768994] italic mb-2">
                No slots activated yet — the template will still be duplicated, but no tasks will be tagged.
                Activate slots first to tag their tasks with a Job Number.
              </p>
            ) : (
              <div className="border border-[#dce4ec] rounded-2xl divide-y divide-[#f0f4f8] max-h-[200px] overflow-y-auto mb-2">
                {slots.map((s) => {
                  const on = !excluded.has(s.id);
                  const done = doneSlots.has(s.id);
                  return (
                    <label key={s.id}
                      className={`flex items-center justify-between gap-2 px-4 py-2 text-[11px] cursor-pointer transition-opacity ${on ? "" : "opacity-45"}`}>
                      <span className="flex items-center gap-2 min-w-0">
                        <input type="checkbox" checked={on} onChange={() => toggleSlot(s.id)}
                          className="accent-[#12a0e1] w-3.5 h-3.5 shrink-0" />
                        <span className="text-[#122027] truncate">{s.label.replace(/^JOBNUMBER_?/i, "").replace(/_/g, " ")}</span>
                        {done && <span className="text-[9px] font-black uppercase tracking-wider text-[#1cc1a5] bg-[#1cc1a5]/10 px-1.5 py-0.5 rounded-full shrink-0">Tagged</span>}
                      </span>
                      <span className={`font-mono font-bold shrink-0 ${on ? "text-[#12a0e1]" : "text-[#768994] line-through"}`}>{s.code}</span>
                    </label>
                  );
                })}
              </div>
            )}

            {progress && (
              <div className="mt-3">
                <p className="text-xs font-bold text-[#12a0e1] mb-1.5">{progress.step}</p>
                <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full w-full bg-[#12a0e1] origin-left transition-[transform] ease-[cubic-bezier(0.16,1,0.3,1)]"
                    style={{ transform: `scaleX(${progress.total ? progress.done / progress.total : 1})` }} />
                </div>
              </div>
            )}
            {error && <p className="text-xs font-bold text-rose-500 mt-3">{error}</p>}
          </>
        )}
      </div>
      <div className="px-6 py-4 border-t border-[#dce4ec] flex items-center justify-end gap-2 shrink-0">
        <button onClick={onClose}
          className="px-5 py-2.5 text-sm font-bold text-[#768994] hover:text-[#122027] bg-white border border-[#dce4ec] rounded-xl transition-[color] ease-[cubic-bezier(0.16,1,0.3,1)]">
          {result ? "Close" : "Cancel"}
        </button>
        {!result && (
          <button onClick={apply} disabled={!canApply}
            title={!canApply && !applying ? "All preconditions above must pass first" : ""}
            className="flex items-center gap-2 px-6 py-2.5 bg-[#12a0e1] hover:bg-[#0d8bc4] text-white text-sm font-bold rounded-xl transition-[background-color] ease-[cubic-bezier(0.16,1,0.3,1)] disabled:opacity-40">
            {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UploadCloud className="w-3.5 h-3.5" />}
            Apply to Wrike
          </button>
        )}
      </div>
    </WrikeApplyShell>
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
// Studios we can currently fetch live from Wrike (have a master-template folder).
// Paramount also ships a hardcoded fallback tree above; Universal is fetch-only.
const TESTABLE_STUDIOS = new Set(["Paramount", "Universal"]);

// When a slot is activated inside a studio's folder, the ordering client is that
// studio's international arm by default (req: "Client — if I'm in Paramount
// folder assume Paramount International"). Editable afterwards in the detail modal.
const STUDIO_CLIENT = {
  Paramount: "Paramount International",
  Universal: "Universal International",
};

const JOBS_SETUP_TABS = [
  { id: "campaign", label: "Bulk Campaign", desc: "Generate a whole campaign's job numbers at once from a studio's Wrike folder template.", icon: FolderPlus, color: "from-blue-500 to-[#12a0e1]" },
  { id: "custom",   label: "Custom Job",    desc: "Add a single one-off job manually, with its own job number and details.", icon: Plus, color: "from-emerald-500 to-teal-600" },
];

// Exported: also rendered inside the PMs' standalone Job Book page (JobBook.jsx).
// initialStudio/initialFilm + lockPickers let this same section be rendered
// against one already-chosen film (the Films tab's campaign modal), where the
// studio and film are resolved from Wrike instead of picked by hand — so that
// modal gets the real thing (activate, push, re-tag) rather than a read-only
// copy that would drift out of step with this one.
export function JobsSetupSection({ setActiveTab, initialStudio, initialFilm, lockPickers = false }) {
  const [innerTab, setInnerTab] = useState("campaign");
  const [studio, setStudio] = useState(initialStudio || "Paramount");
  const [filmTitle, setFilmTitle] = useState(initialFilm || "");
  const [fetchedTemplate, setFetchedTemplate] = useState(null); // real subtree pulled live from Wrike
  const [fetchingTemplate, setFetchingTemplate] = useState(false);
  const [fetchInfo, setFetchInfo] = useState(null); // { rootLabel, jobCount } | { error }
  // The selected film's OWN live subtree (source of truth for what actually
  // exists / is already numbered), independent of the studio template.
  // { filmProject, tree, hasSlots } | null. hasSlots:false ⇒ fall back to template.
  const [filmView, setFilmView] = useState(null);
  const [filmViewLoading, setFilmViewLoading] = useState(false);
  // A film shared into several studio folders ("territories") — which one we show.
  // null = the base studio findFilmLocation picks. Reset when the film changes.
  const [territoryId, setTerritoryId] = useState(null);
  // One shared, cached fetch of the whole (recycle-bin-filtered) folder tree, so
  // the film-view lookup doesn't re-hit Wrike on every film change.
  const foldersRef = useRef(null);
  const [films, setFilms] = useState([]);
  const [filmsLoading, setFilmsLoading] = useState(true);
  const [clients, setClients] = useState([]);
  const [workCategories, setWorkCategories] = useState([]);
  const [descs, setDescs] = useState([]);
  const [customSaving, setCustomSaving] = useState(false);
  const [customCreated, setCustomCreated] = useState(null); // job_number of the row just created

  // Per-studio in-memory cache of the fetched template, so re-selecting a studio
  // you've already loaded is instant and doesn't re-hit Wrike. Cleared only on a
  // manual refresh (the small re-sync affordance below the studio picker).
  const templateCache = useRef({}); // { [studio]: { tree, info } }

  // Every Job Book row already activated against a template slot for the selected
  // film. A flat list rather than a slot→job map on purpose: the same slot can be
  // activated any number of times (numerous launches, several title treatments),
  // so one slot owns N jobs. Nothing is created until a slot is clicked and the
  // form below is submitted, so a film never ends up with a pile of job numbers
  // nobody asked for — you activate exactly what's needed, when the work comes in.
  const [filmJobs, setFilmJobs] = useState([]);
  const [loadingSlots, setLoadingSlots] = useState(false);

  // The staged activation. Clicking a template slot doesn't write anything: it
  // allocates the next code, previews the folder it would create in the film tree
  // below, and opens the job form pre-filled from the slot. Because a draft isn't
  // keyed by slot, an already-allocated slot stays clickable — that's what makes
  // repeat launches of the same job type possible.
  // { slotLabel, description, path: [containerLabels], code } | null
  const [draft, setDraft] = useState(null);
  const [allocatingDraft, setAllocatingDraft] = useState(false);
  const [activateError, setActivateError] = useState(null);
  const [creatingJob, setCreatingJob] = useState(false);
  const draftRef = useRef(null); // scroll target so the form comes into view on activate
  // Item Price custom field, discovered once per session. undefined = not
  // looked up yet; null = this member can't see it (or it doesn't exist).
  const itemPriceFieldRef = useRef(undefined);

  // Job numbers activated during THIS session (across films) — the reviewable
  // list at the bottom. Most-recent first. Each can be opened in a detail modal
  // to fill in costs/billing, or undone (which deletes the row again).
  const [sessionJobs, setSessionJobs] = useState([]);
  const [reviewJob, setReviewJob] = useState(null); // job row currently open in the detail modal
  const [reviewSaving, setReviewSaving] = useState(false);
  const [undoingId, setUndoingId] = useState(null); // job id currently being undone
  const [showFilmSync, setShowFilmSync] = useState(false); // req 6 dry-run modal
  const [pushMode, setPushMode] = useState(null);          // null | "push" (req 5+1) | "retag" (req 2+4)

  // Reloadable so the Film-sync modal can refresh the picker after adding films.
  const loadFilms = useCallback(() => {
    supabase.from("films").select("title").order("title").then(({ data }) => {
      setFilms((data || []).map(f => f.title));
      setFilmsLoading(false);
    });
  }, []);

  // Films are added in the Films tab first — this section only picks from that
  // list, it never creates new films, so the two stay in sync by construction.
  useEffect(() => {
    loadFilms();
    supabase.from("clients").select("name").order("name").then(({ data }) => setClients((data || []).map(c => c.name)));
    supabase.from("job_work_categories").select("name").order("name").then(({ data }) => setWorkCategories((data || []).map(c => c.name)));
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

  // Walk a tree (studio template OR a film's own subtree), collecting every
  // jobNumber:true leaf. Film-view nodes carry `allocated`/`code`/`description`
  // already (read from the live folder name); template nodes don't, so we derive
  // description from the label and default allocated:false.
  const collectJobLeaves = (node) => {
    let leaves = node.jobNumber
      ? [{
          label: node.label,
          description: node.description || node.label.replace(/^JOBNUMBER_?/i, "").replace(/_/g, " ").trim() || "General",
          allocated: !!node.allocated,
          code: node.code || null,
        }]
      : [];
    (node.children || []).forEach(c => { leaves = leaves.concat(collectJobLeaves(c)); });
    return leaves;
  };

  // Pull the real master-template folder subtree from Wrike via the OAuth
  // proxy. Builds the same { label, children, jobNumber } shape as the
  // hardcoded FOLDER_TEMPLATES, tagging every "JOBNUMBER_..." folder so it
  // gets a generated code.
  const fetchTemplateFromWrike = useCallback(async (targetStudio, { force = false } = {}) => {
    if (!TESTABLE_STUDIOS.has(targetStudio)) return;
    // Serve from the per-studio cache unless the caller explicitly forces a refresh.
    if (!force && templateCache.current[targetStudio]) {
      const cached = templateCache.current[targetStudio];
      setFetchedTemplate(cached.tree);
      setFetchInfo(cached.info);
      return;
    }
    if (!localStorage.getItem("wrike_user_id")) { setFetchInfo({ error: "Wrike not connected — connect it in Profile → Settings first." }); return; }
    setFetchingTemplate(true);
    setFetchInfo(null);
    setFetchedTemplate(null);
    const studio = targetStudio; // shadow so the existing body below reads the requested studio
    try {
      const FF = encodeURIComponent("[childIds]");
      const fd = {};
      let url = `/api/wrike/folders?fields=${FF}`;
      while (url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Wrike folders fetch failed (${res.status})`);
        const json = await res.json();
        (json.data || []).forEach(f => {
          if (/^Rb/i.test(f.scope || "")) return; // skip Recycle Bin so a deleted template dupe can't win
          fd[f.id] = { id: f.id, title: f.title, childIds: f.childIds || [] };
        });
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
          // id is carried through so a staged slot can read its own Wrike
          // custom fields (Item Price) without re-walking the tree.
          const out = { label: node.title, id: node.id };
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
      const info = { rootLabel: best.title, jobCount: best.jobCount };
      templateCache.current[targetStudio] = { tree: best.tree, info };
      setFetchedTemplate(best.tree);
      setFetchInfo(info);
    } catch (e) {
      setFetchInfo({ error: e.message });
      setFetchedTemplate(null);
    } finally {
      setFetchingTemplate(false);
    }
  }, []);

  // Req 7 — auto-fetch the studio's master template the moment a studio is
  // selected (no manual "Fetch" button). Re-selecting a studio you've already
  // loaded is served instantly from templateCache. Req 4's reconcile: every
  // switch re-reads the live tree, so renamed folders in Wrike show up here.
  useEffect(() => { fetchTemplateFromWrike(studio); }, [studio, fetchTemplateFromWrike]);

  // Load (and cache) the whole folder tree once, so we can derive the selected
  // film's own subtree without re-fetching. `force` busts the cache after a
  // re-sync so renamed/pushed folders show up.
  const ensureFolders = useCallback(async ({ force = false } = {}) => {
    if (!force && foldersRef.current) return foldersRef.current;
    const byId = await fetchAllFolders();
    foldersRef.current = byId;
    return byId;
  }, []);

  // Read the selected film's OWN live subtree (see buildFilmView). This is what
  // makes an already-numbered campaign read as done instead of the template's
  // "activate everything" — the film's real XY##### folders are the truth. Films
  // with no slot folders yet leave filmView.hasSlots false, and the render falls
  // back to the studio template to show what could be created.
  // A new film has its own set of territories — drop any previous selection.
  useEffect(() => { setTerritoryId(null); }, [filmTitle]);

  useEffect(() => {
    let cancelled = false;
    if (!filmTitle.trim() || !localStorage.getItem("wrike_user_id")) { setFilmView(null); return; }
    setFilmViewLoading(true);
    ensureFolders()
      .then((byId) => { if (!cancelled) setFilmView(buildFilmView(byId, filmTitle, territoryId)); })
      .catch(() => { if (!cancelled) setFilmView(null); })
      .finally(() => { if (!cancelled) setFilmViewLoading(false); });
    return () => { cancelled = true; };
  }, [filmTitle, territoryId, ensureFolders]);

  // Load every job already activated against a template slot for this film, so
  // the film tree can show which slots are numbered and how many times over.
  const loadSlotJobs = useCallback(async (film) => {
    if (!film) { setFilmJobs([]); return; }
    setLoadingSlots(true);
    const { data } = await supabase.from("jobs").select("*").eq("film_title", film).not("template_slot", "is", null);
    setFilmJobs(data || []);
    setLoadingSlots(false);
  }, []);

  // slot → the jobs activated against it (usually one, several for a slot run
  // more than once). Drives the ALLOCATED badges and the ×N counts. Keyed by
  // slotSuffix, not the raw label, so a job stamped against the template's
  // "JOBNUMBER_French_Canada_Assets" still matches the film's own copy of that
  // folder once Wrike has renamed it to "XY026047_French_Canada_Assets".
  const jobsBySlot = useMemo(() => {
    const map = {};
    filmJobs.forEach(j => { (map[slotSuffix(j.template_slot)] ||= []).push(j); });
    return map;
  }, [filmJobs]);

  useEffect(() => { loadSlotJobs(filmTitle); }, [filmTitle, loadSlotJobs]);

  // Re-read just the film's own subtree from Wrike (busts the folder cache), so a
  // folder renamed/reverted in Wrike reflects here on demand. Lighter than resync
  // (doesn't re-pull the studio template) and available even when the pickers —
  // and their Re-sync button — are hidden (lockPickers, opened from the Films tab).
  const refreshFilmView = useCallback(() => {
    if (!filmTitle.trim() || !localStorage.getItem("wrike_user_id")) return;
    loadSlotJobs(filmTitle); // re-read Job Book too, so folder-tracking (wrike_folder_id) is current for reconciliation
    foldersRef.current = null;
    setFilmViewLoading(true);
    ensureFolders({ force: true })
      .then((byId) => setFilmView(buildFilmView(byId, filmTitle, territoryId)))
      .catch(() => setFilmView(null))
      .finally(() => setFilmViewLoading(false));
  }, [filmTitle, territoryId, ensureFolders, loadSlotJobs]);

  // Force-refresh both the studio template AND the film's own subtree from Wrike
  // (busts the folder cache), so a just-pushed / just-renamed film reflects here.
  const resync = useCallback(() => {
    foldersRef.current = null;
    fetchTemplateFromWrike(studio, { force: true });
    if (filmTitle.trim() && localStorage.getItem("wrike_user_id")) {
      setFilmViewLoading(true);
      ensureFolders({ force: true })
        .then((byId) => setFilmView(buildFilmView(byId, filmTitle, territoryId)))
        .catch(() => setFilmView(null))
        .finally(() => setFilmViewLoading(false));
    }
  }, [studio, filmTitle, territoryId, fetchTemplateFromWrike, ensureFolders]);

  // Stage one slot. Allocates the next sequential XY code fresh (so it reflects
  // anything created anywhere since we last looked) and opens the form below,
  // pre-filled from the slot — but writes nothing. Deliberately not blocked by
  // an existing activation: clicking a slot that's already been used stages
  // ANOTHER job of that type, which is the whole point of the flow.
  const activateSlot = async (leaf) => {
    if (allocatingDraft) return;
    setAllocatingDraft(true);
    setActivateError(null);
    try {
      // The slot's Item Price in Wrike becomes the job's Fixed Cost. Read
      // alongside the code rather than after it, and tolerated as absent: the
      // field is only visible to project managers, and plenty of slots carry
      // no price at all — either way the cost is just left empty.
      const [code, itemPrice] = await Promise.all([
        nextJobCode(),
        (async () => {
          if (!leaf.id) return null;
          const field = itemPriceFieldRef.current !== undefined
            ? itemPriceFieldRef.current
            : (itemPriceFieldRef.current = await discoverItemPriceField().catch(() => null));
          return field ? fetchFolderItemPrice(leaf.id, field.id) : null;
        })(),
      ]);
      setDraft({
        slotLabel: leaf.label,
        description: leaf.description,
        path: leaf.path || [],
        code,
        itemPrice,
      });
      // Bring the preview + form into view — the form is a long way below the
      // template tree that was just clicked.
      requestAnimationFrame(() => draftRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (e) {
      setActivateError(e.message);
    } finally {
      setAllocatingDraft(false);
    }
  };

  // Commit the staged draft: one Job Book row, tagged with the template slot it
  // came from. The code was allocated when the slot was clicked, but re-check it
  // here — a collision means someone else took it while the form was open, so
  // allocate again rather than failing the user's typing.
  const createDraftJob = async (form) => {
    if (!draft || creatingJob) return;
    setCreatingJob(true);
    setActivateError(null);
    try {
      const row = {
        ...form,
        template_slot: draft.slotLabel,
        start_date: form.start_date || null,
        completed_date: form.completed_date || null,
        fixed_cost: form.fixed_cost === "" ? null : parseFloat(form.fixed_cost),
        third_party_cost: form.third_party_cost === "" ? null : parseFloat(form.third_party_cost),
        estimated_cost: form.estimated_cost === "" ? null : parseFloat(form.estimated_cost),
      };
      let { data, error } = await supabase.from("jobs").insert(row).select().single();
      if (error?.code === "23505") {
        const fresh = await nextJobCode();
        row.job_number = (form.job_number || "").replace(/XY\d+/, fresh);
        ({ data, error } = await supabase.from("jobs").insert(row).select().single());
      }
      if (error) throw error;
      setFilmJobs(prev => [...prev.filter(j => j.id !== data.id), data]);
      // Prepend to the session review list (dedupe by id, just in case).
      setSessionJobs(prev => [data, ...prev.filter(j => j.id !== data.id)]);
      setDraft(null);
      // Creating a job and pushing it to Wrike are one action, not two. The
      // Job Book row is written first (it's what allocates the code), but the
      // push confirmation follows immediately so a job can't sit in the Book
      // having never reached Wrike because nobody pressed a second button.
      setPushMode("push");
    } catch (e) {
      setActivateError(e.message);
    } finally {
      setCreatingJob(false);
    }
  };

  // Req 3 — undo an activation: delete the jobs row again and drop it from both
  // the film's job list and the session review list. (Once live Wrike writes
  // land, this will also clear the pushed folder / custom field — that's wired
  // in the Wrike-write phase.)
  const undoActivation = async (job, { skipConfirm = false } = {}) => {
    if (!job?.id || undoingId) return;
    if (!skipConfirm) {
      const ok = await confirmAction({
        title: "Undo this job number?",
        message: `“${job.job_number}” will be removed from Job Book.`,
        confirmLabel: "Undo activation",
        danger: true,
      });
      if (!ok) return;
    }
    setUndoingId(job.id);
    const { error } = await supabase.from("jobs").delete().eq("id", job.id);
    setUndoingId(null);
    if (error) { notify("Couldn't undo: " + error.message, "error"); return; }
    setFilmJobs(prev => prev.filter(j => j.id !== job.id));
    setSessionJobs(prev => prev.filter(j => j.id !== job.id));
  };

  // Bulk undo — every job activated this session. Confirmed once.
  const undoAllSession = async () => {
    if (!sessionJobs.length) return;
    const ok = await confirmAction({
      title: `Undo all ${sessionJobs.length} job number${sessionJobs.length === 1 ? "" : "s"}?`,
      message: "Every job number activated in this session will be removed from Job Book.",
      confirmLabel: "Undo all",
      danger: true,
    });
    if (!ok) return;
    const ids = sessionJobs.map(j => j.id);
    setUndoingId("__bulk__");
    const { error } = await supabase.from("jobs").delete().in("id", ids);
    setUndoingId(null);
    if (error) { notify("Couldn't undo all: " + error.message, "error"); return; }
    const gone = new Set(ids);
    setFilmJobs(prev => prev.filter(j => !gone.has(j.id)));
    setSessionJobs([]);
  };

  // Save edits from the review detail modal back to the jobs row, then refresh
  // it in both the session list and the film's job list so the UI reflects it.
  const handleReviewSave = async (form) => {
    if (!reviewJob?.id) return;
    setReviewSaving(true);
    const payload = {
      ...form,
      start_date: form.start_date || null,
      completed_date: form.completed_date || null,
      fixed_cost: form.fixed_cost === "" ? null : parseFloat(form.fixed_cost),
      third_party_cost: form.third_party_cost === "" ? null : parseFloat(form.third_party_cost),
      estimated_cost: form.estimated_cost === "" ? null : parseFloat(form.estimated_cost),
    };
    const { data, error } = await supabase.from("jobs").update(payload).eq("id", reviewJob.id).select().single();
    setReviewSaving(false);
    if (error) { notify("Couldn't save: " + error.message, "error"); return; }
    setSessionJobs(prev => prev.map(j => j.id === data.id ? data : j));
    setFilmJobs(prev => prev.map(j => j.id === data.id ? data : j));
    setReviewJob(null);
  };

  // Collapsed folder paths, per tree (empty = all expanded). The template preview
  // and the film's own folders are two separate panels now, so they fold apart.
  const [collapsed, setCollapsed] = useState(() => ({ template: new Set(), film: new Set() }));
  const toggleCollapse = (mode, path) => setCollapsed((prev) => {
    const next = new Set(prev[mode]);
    next.has(path) ? next.delete(path) : next.add(path);
    return { ...prev, [mode]: next };
  });
  // Every container-folder path EXCEPT the root — collapsing these leaves the top
  // level (the folders right under the film) visible with their sections folded.
  const allContainerPaths = (node, path = "0", depth = 0, acc = []) => {
    if (node?.children?.length) {
      if (depth > 0) acc.push(path);
      node.children.forEach((c, i) => allContainerPaths(c, `${path}-${i}`, depth + 1, acc));
    }
    return acc;
  };

  // Recursive tree renderer, in two modes.
  //
  //   "template" — the studio's master template. Every JOBNUMBER_ leaf is a
  //     permanently clickable action: clicking it stages a job of that type.
  //     Nothing here is ever "used up", so a slot can be run as many times as
  //     the campaign needs.
  //   "film" — the picked film's own live folders. Read-only: slots already
  //     carrying an XY code are badged, and the staged draft appears inline as
  //     a green NEW JOB preview of the folder that's about to exist.
  //
  // Uses a path-based key since live Wrike data can have repeated folder names
  // across branches. Container folders collapse.
  const renderTree = (node, mode, depth = 0, path = "0", ancestors = []) => {
    const isTpl = mode === "template";
    const isSlot = !!node.jobNumber;
    const leafDesc = isSlot ? (node.description || node.label.replace(/^(JOBNUMBER|XY\d+)_?/i, "").replace(/_/g, " ").trim() || "General") : null;
    const slotJobsHere = isSlot ? jobsBySlot[slotSuffix(node.label)] : null;
    const done = isSlot && !isTpl && (node.allocated || slotJobsHere?.length);
    const clickable = isTpl && isSlot && !allocatingDraft;
    const isDraftNode = !!node.__draft;

    const hasChildren = node.children?.length > 0;
    // A search override keeps folders on a match path open regardless of collapse.
    const isCollapsed = collapsed[mode].has(path) && !(isTpl && searchExpand.has(path));
    const isMatch = isTpl && nodeMatches(node);

    return (
      <div key={path}>
        <div
          onClick={clickable
            ? () => activateSlot({ label: node.label, id: node.id, description: leafDesc, path: ancestors })
            : hasChildren ? () => toggleCollapse(mode, path) : undefined}
          className={`flex items-center gap-1.5 py-1 ${(clickable || hasChildren) ? "cursor-pointer hover:bg-[#12a0e1]/5 rounded-lg -mx-1 px-1" : ""}`}
          style={{ paddingLeft: depth * 18 }}>
          {hasChildren
            ? <ChevronRight className={`w-3 h-3 text-[#768994] shrink-0 transition-transform ${isCollapsed ? "" : "rotate-90"}`} />
            : <span className="w-3 shrink-0" />}
          {hasChildren
            ? (isCollapsed
                ? <Folder className="w-3.5 h-3.5 text-[#f4b740] shrink-0" />
                : <FolderOpen className="w-3.5 h-3.5 text-[#f4b740] shrink-0" />)
            : <Folder className={`w-3.5 h-3.5 shrink-0 ${isDraftNode ? "text-[#10b981]" : isSlot && !done ? "text-[#12a0e1]" : "text-[#b0bec5]"}`} />}
          <span className={`text-[12px] ${isMatch ? "bg-[#f4b740]/40 rounded px-1" : ""} ${
            isDraftNode ? "font-mono font-bold text-[#10b981]"
            : done ? "font-mono font-bold text-[#12a0e1]"
            : isSlot ? "text-[#122027] font-bold"
            : "text-[#122027]"}`}>
            {node.label}
          </span>
          {hasChildren && <span className="text-[10px] text-[#768994] font-bold shrink-0">{node.children.length}</span>}
          {clickable && (
            <span className="text-[9px] font-black uppercase tracking-wider text-[#12a0e1] bg-[#12a0e1]/10 px-1.5 py-0.5 rounded ml-1">Click to activate</span>
          )}
          {isDraftNode && (
            <span className="text-[9px] font-black uppercase tracking-wider text-[#10b981] bg-[#10b981]/10 px-1.5 py-0.5 rounded ml-1">New job</span>
          )}
          {done && (
            <span className="text-[9px] font-black uppercase tracking-wider text-[#1cc1a5] bg-[#1cc1a5]/10 px-1.5 py-0.5 rounded ml-1">
              Allocated{slotJobsHere?.length > 1 ? ` ×${slotJobsHere.length}` : ""}
            </span>
          )}
        </div>
        {hasChildren && !isCollapsed && node.children.map((c, i) =>
          renderTree(c, mode, depth + 1, `${path}-${i}`, [...ancestors, node.label]))}
      </div>
    );
  };

  const hasTemplate = !!(fetchedTemplate || FOLDER_TEMPLATES[studio]);
  // The studio template is now shown in its own right, always — it's the menu of
  // actions, not a stand-in for a film with no folders yet.
  const templateTree = fetchedTemplate || (hasTemplate ? FOLDER_TEMPLATES[studio] : null);
  // The film's own live folders. Only present once a film with real slot folders
  // is picked; until then there's nothing truthful to show below the template.
  const filmDriven = !!(filmView && filmView.hasSlots);
  const filmTree = filmDriven ? filmView.tree : null;
  const templateLeaves = templateTree ? collectJobLeaves(templateTree) : [];
  const filmLeaves = filmTree ? collectJobLeaves(filmTree) : [];
  // "Allocated" = already numbered in Wrike, or carrying a Job Book row we made.
  const activatedCount = filmLeaves.filter(l => l.allocated || jobsBySlot[slotSuffix(l.label)]?.length).length;

  // Search over the template tree — highlights matching nodes and auto-expands
  // the folders on the path to any match. A 30-slot template is a lot to scroll.
  const [slotQuery, setSlotQuery] = useState("");
  const nodeMatches = (n) => {
    const q = slotQuery.trim().toLowerCase();
    if (!q) return false;
    const desc = n.description || (n.label || "").replace(/^JOBNUMBER_?/i, "").replace(/_/g, " ");
    return (n.label || "").toLowerCase().includes(q) || desc.toLowerCase().includes(q);
  };
  const searchExpand = useMemo(() => {
    const set = new Set();
    const q = slotQuery.trim().toLowerCase();
    if (!q || !templateTree) return set;
    const matches = (n) => {
      const desc = n.description || (n.label || "").replace(/^JOBNUMBER_?/i, "").replace(/_/g, " ");
      return (n.label || "").toLowerCase().includes(q) || desc.toLowerCase().includes(q);
    };
    const walk = (n, path) => {
      let has = matches(n);
      (n.children || []).forEach((c, i) => { if (walk(c, `${path}-${i}`)) has = true; });
      if (has && n.children?.length) set.add(path);
      return has;
    };
    walk(templateTree, "0");
    return set;
  }, [templateTree, slotQuery]);

  // The film's tree with the staged draft grafted in as a preview of the folder
  // the job will occupy. The film project is a duplicate of the studio template,
  // so the draft's template path maps onto it folder-for-folder — walk that path
  // (ignoring the differing roots, and any XY prefix Wrike has already applied)
  // and drop the node in beside its siblings. If the film's copy has diverged and
  // the path doesn't resolve, the preview lands at the root rather than vanishing.
  const filmTreeWithDraft = useMemo(() => {
    if (!filmTree) return null;
    if (!draft) return filmTree;
    const preview = {
      label: `${draft.code}_${draft.description.replace(/\s+/g, "_")}`,
      jobNumber: true,
      __draft: true,
    };
    const norm = (s) => slotSuffix(s || "").replace(/[_\s]+/g, " ").trim().toLowerCase();
    const graft = (node, rest) => {
      if (!rest.length) return { ...node, children: [...(node.children || []), preview] };
      const [head, ...tail] = rest;
      const idx = (node.children || []).findIndex(c => norm(c.label) === norm(head));
      if (idx === -1) return { ...node, children: [...(node.children || []), preview] };
      const children = [...node.children];
      children[idx] = graft(children[idx], tail);
      return { ...node, children };
    };
    // draft.path[0] is the template root, which the film tree replaces with the
    // film project itself — so skip it and match from the level below.
    return graft(filmTree, draft.path.slice(1));
  }, [filmTree, draft]);

  // A film's live tree is a wall of folders — dozens of leaves across several
  // branches — so the green NEW JOB preview grafted into it is easy to lose.
  // Staging a slot folds the tree down to just the branch the new job lands in;
  // discarding the draft opens it back up. Manual toggling still works from
  // there, this only sets the starting state each time the draft changes.
  useEffect(() => {
    if (!filmTreeWithDraft) return;
    if (!draft) { setCollapsed(c => ({ ...c, film: new Set() })); return; }
    // Paths of every container on the way down to the draft node — the only
    // ones that stay open.
    const onDraftPath = new Set();
    const walk = (node, path = "0") => {
      if (node.__draft) return true;
      let found = false;
      (node.children || []).forEach((c, i) => { if (walk(c, `${path}-${i}`)) found = true; });
      if (found) onDraftPath.add(path);
      return found;
    };
    walk(filmTreeWithDraft);
    setCollapsed(c => ({
      ...c,
      film: new Set(allContainerPaths(filmTreeWithDraft).filter(p => !onDraftPath.has(p))),
    }));
  }, [draft, filmTreeWithDraft]);

  // ── Job Book ↔ Wrike reconciliation ──────────────────────────────────────
  // Every folder in the film's live subtree, by id, so we can look up the exact
  // folder a job was pushed to and see whether it still carries that job's code.
  const liveByFolderId = useMemo(() => {
    const out = {};
    const walk = (n) => { if (n?.id) out[n.id] = n; (n?.children || []).forEach(walk); };
    if (filmView?.tree) walk(filmView.tree);
    return out;
  }, [filmView]);

  // Activated jobs whose Wrike folder no longer matches them. We ONLY consider
  // jobs that were actually pushed (wrike_folder_id set) — a job without one was
  // never pushed and is just pending, not a mismatch. A pushed job is stale if
  // its folder was renamed off its code (e.g. reverted to JOBNUMBER_…) or the
  // folder is gone. This is the source-of-truth check: Wrike is the truth, and
  // when Job Book disagrees we offer to un-allocate.
  const jobMismatches = useMemo(() => {
    if (!filmView?.filmProject) return [];
    const out = [];
    filmJobs.forEach((job) => {
      if (!job.wrike_folder_id) return; // never pushed → pending, not stale
      const code = (job.job_number?.match(/XY\d+/) || [])[0];
      if (!code) return;
      const live = liveByFolderId[job.wrike_folder_id];
      if (!live) out.push({ job, code, reason: "deleted" });
      else if (!new RegExp(`^${code}_`, "i").test(live.label || ""))
        out.push({ job, code, reason: "renamed", liveLabel: live.label });
    });
    return out;
  }, [filmJobs, liveByFolderId, filmView]);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-4">
        {JOBS_SETUP_TABS.map(t => {
          const Icon = t.icon;
          const active = innerTab === t.id;
          return (
            <button key={t.id} onClick={() => setInnerTab(t.id)}
              className={`flex items-center gap-3 text-left rounded-2xl p-3.5 border-2 transition-[background-color,border-color,box-shadow] ease-[cubic-bezier(0.16,1,0.3,1)] ${
                active
                  ? "border-[#12a0e1] bg-[#12a0e1]/5 shadow-md"
                  : "border-[#dce4ec] bg-white hover:border-slate-300 hover:shadow-sm"
              }`}>
              <div className={`w-9 h-9 rounded-xl bg-gradient-to-br ${t.color} flex items-center justify-center shadow-sm shrink-0`}>
                <Icon className="w-4 h-4 text-white" />
              </div>
              <p className="text-sm font-black text-[#122027] flex-1 min-w-0">{t.label}</p>
              {active && (
                <div className="w-5 h-5 rounded-full bg-[#12a0e1] flex items-center justify-center shrink-0">
                  <Check className="w-3 h-3 text-white" />
                </div>
              )}
            </button>
          );
        })}
      </div>

      {innerTab === "campaign" && (
    <div className="flex flex-col gap-5">
      {!lockPickers && (
      <div className="bg-[#f8fafc] border border-[#dce4ec] rounded-2xl p-4">
        <p className="text-xs text-[#768994] leading-relaxed">
          Pick a studio and its template loads automatically. In the folder preview,
          <span className="font-bold text-[#122027]"> click a slot to activate it</span> — that stages a job
          number and opens the form below, pre-filled. Nothing reaches Job Book until you press Create Job.
          A slot never gets used up, so run the same one as many times as the campaign needs. Everything you
          create this session collects in <span className="font-bold text-[#122027]">Review</span> at the bottom.
        </p>
      </div>
      )}

      {!lockPickers && (
      <div>
        <label className="block text-[10px] font-black uppercase tracking-widest text-[#768994] mb-1.5">Template</label>
        <div className="flex items-center gap-2 flex-wrap">
          {STUDIO_OPTIONS.map(s => {
            const available = TESTABLE_STUDIOS.has(s);
            return (
              <button key={s} disabled={!available}
                onClick={() => setStudio(s)}
                className={`px-3 py-2 rounded-xl text-xs font-bold border transition-[background-color,border-color,color] ease-[cubic-bezier(0.16,1,0.3,1)] ${
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
          {/* Auto-fetch status + a small manual re-sync (force-refresh past the cache). */}
          {fetchingTemplate ? (
            <span className="flex items-center gap-1.5 text-xs font-bold text-[#768994] ml-1">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading {studio} template…
            </span>
          ) : fetchInfo?.error ? (
            <span className="flex items-center gap-2 ml-1">
              <span className="text-xs font-bold text-red-500">{fetchInfo.error}</span>
              <button onClick={resync}
                className="text-[#12a0e1] hover:underline text-xs font-bold">Retry</button>
            </span>
          ) : fetchInfo ? (
            <span className="flex items-center gap-2 ml-1">
              <button onClick={resync}
                title={`Loaded “${fetchInfo.rootLabel}” — re-sync from Wrike`}
                className="flex items-center gap-1 text-[#768994] hover:text-[#12a0e1] text-xs font-bold transition-colors">
                <RefreshCw className="w-3 h-3" /> Re-sync
              </button>
            </span>
          ) : null}
        </div>
      </div>
      )}

      {/* Folder preview — the studio's master template, straight from Wrike. Every
          JOBNUMBER_ folder in here is an action, and stays one however many times
          it's been used: activating a slot never consumes it. */}
      {templateTree && (
        <div className={`border border-[#dce4ec] rounded-2xl flex flex-col ${lockPickers ? "max-h-[38vh] min-h-[220px]" : "max-h-[52vh] min-h-[300px]"}`}>
          <div className="flex items-center gap-2 px-4 pt-4 pb-2 border-b border-[#f0f4f8] shrink-0">
            <p className="text-[10px] font-black uppercase tracking-widest text-[#768994] shrink-0">
              Folder Preview{fetchedTemplate ? " \u00b7 live from Wrike" : ""}
            </p>
            <div className="relative flex-1 max-w-[220px] ml-auto">
              <Search className="w-3.5 h-3.5 text-[#b0bec5] absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input value={slotQuery} onChange={(e) => setSlotQuery(e.target.value)}
                placeholder="Search slots\u2026"
                className="w-full pl-8 pr-2 py-1.5 text-[11px] bg-white border border-[#dce4ec] rounded-lg outline-none focus:border-[#12a0e1] transition-colors" />
            </div>
            <button type="button"
              onClick={() => setCollapsed(c => ({ ...c, template: c.template.size ? new Set() : new Set(allContainerPaths(templateTree)) }))}
              className="text-[10px] font-bold text-[#768994] hover:text-[#12a0e1] transition-colors shrink-0">
              {collapsed.template.size ? "Expand all" : "Collapse all"}
            </button>
          </div>
          <div className="px-4 py-2 overflow-y-auto">
            {renderTree(templateTree, "template")}
          </div>
          <p className="px-4 pb-3 pt-1 text-[10px] text-[#768994] shrink-0">
            {templateLeaves.length} job slot{templateLeaves.length === 1 ? "" : "s"} \u00b7 click one to activate another job of that type.
          </p>
        </div>
      )}

      {!lockPickers && (
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="block text-[10px] font-black uppercase tracking-widest text-[#768994]">Film</label>
          <button onClick={() => {
              try { sessionStorage.setItem("openAdminSection", "films"); } catch { /* ignore */ }
              window.location.hash = "management";
            }}
            title="Open the Films page (in Administration) to add or sync films"
            className="flex items-center gap-1.5 text-[11px] font-bold text-[#12a0e1] hover:text-[#0d8bc4] transition-colors">
            <Film className="w-3 h-3" /> Manage films
          </button>
        </div>
        <StrictSelect value={filmTitle} onChange={v => setFilmTitle(v)}
          options={films} placeholder="Select a film…" loading={filmsLoading} />
        {!filmsLoading && films.length === 0 && (
          <p className="text-xs text-[#768994] mt-1.5">
            No films yet — <button onClick={() => setShowFilmSync(true)} className="text-[#1cc1a5] font-bold hover:underline">sync them from Wrike</button>{" "}
            or add one on the{" "}
            <button onClick={() => { try { sessionStorage.setItem("openAdminSection", "films"); } catch { /* ignore */ } window.location.hash = "management"; }}
              className="text-[#12a0e1] font-bold hover:underline">Films</button> page.
          </p>
        )}
      </div>
      )}

      {activateError && (
        <p className="text-xs font-bold text-red-500">{activateError}</p>
      )}

      {filmTitle.trim() && (
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs font-bold text-[#768994]">
            {filmDriven
              ? `${activatedCount} / ${filmLeaves.length} job number${filmLeaves.length === 1 ? "" : "s"} already allocated for “${filmTitle}”`
              : `No job folders in Wrike yet for “${filmTitle}” — activating a slot still allocates its number and files the job.`}
          </span>
          {(loadingSlots || filmViewLoading) && <Loader2 className="w-3.5 h-3.5 animate-spin text-[#768994]" />}
          {/* Territory swap — this film is shared into more than one studio folder. */}
          {filmView?.territories?.length > 1 && (
            <label className="flex items-center gap-1.5 text-[11px] font-bold text-[#768994]">
              <Globe className="w-3 h-3 text-[#12a0e1]" />
              <select
                value={filmView.studioFolder?.id || ""}
                onChange={(e) => {
                  const t = filmView.territories.find((x) => x.studioFolder.id === e.target.value);
                  if (!t) return;
                  setTerritoryId(t.studioFolder.id);
                  setStudio(t.studio);
                }}
                className="text-[11px] font-bold text-[#33454f] bg-white border border-[#dce4ec] rounded-lg px-2 py-1 outline-none focus:border-[#12a0e1] cursor-pointer">
                {filmView.territories.map((t) => (
                  <option key={t.studioFolder.id} value={t.studioFolder.id}>{t.studio}</option>
                ))}
              </select>
            </label>
          )}
          {!filmViewLoading && (
            <button onClick={refreshFilmView}
              title="Re-read this film's folders from Wrike (reflects renames done in Wrike)"
              className="flex items-center gap-1 text-[11px] font-bold text-[#768994] hover:text-[#12a0e1] transition-colors">
              <RefreshCw className="w-3 h-3" /> Refresh from Wrike
            </button>
          )}
        </div>
      )}

      {/* Source-of-truth reconciliation: Job Book numbers whose Wrike folder
          no longer carries them (renamed off their code, or deleted). Wrike is
          the truth — offer to clear the stale Job Book entry. */}
      {jobMismatches.length > 0 && (
        <div className="border border-[#f4b740]/40 bg-[#f4b740]/10 rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-[#f4b740]/30">
            <p className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-[#8a6d1a]">
              <AlertTriangle className="w-4 h-4" />
              {jobMismatches.length} job number{jobMismatches.length === 1 ? "" : "s"} out of step with Wrike
            </p>
          </div>
          <div className="divide-y divide-[#f4b740]/20">
            {jobMismatches.map(({ job, code, reason, liveLabel }) => (
              <div key={job.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="font-mono font-bold text-[#8a6d1a] text-xs shrink-0">{code}</span>
                <span className="text-[11px] text-[#122027] flex-1 min-w-0 truncate">
                  {job.project_description}
                  <span className="text-[#8a6d1a] italic ml-1.5">
                    — {reason === "deleted"
                      ? "its Wrike folder was deleted"
                      : `its Wrike folder was renamed to “${liveLabel}”`}
                  </span>
                </span>
                <button onClick={() => undoActivation(job)} disabled={undoingId === job.id}
                  className="flex items-center gap-1.5 text-[11px] font-bold text-rose-600 hover:text-rose-700 disabled:opacity-40 shrink-0 transition-colors">
                  {undoingId === job.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Undo2 className="w-3 h-3" />}
                  Un-allocate
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* The film's own folders, live from Wrike — what actually exists today,
          with the staged job shown in place as the folder it's about to become. */}
      {filmTreeWithDraft && (
        <div className={`border border-[#dce4ec] rounded-2xl flex flex-col ${lockPickers ? "max-h-[38vh] min-h-[200px]" : "max-h-[52vh] min-h-[260px]"}`}>
          <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2 border-b border-[#f0f4f8] shrink-0">
            <p className="text-[10px] font-black uppercase tracking-widest text-[#768994]">
              Film Folders · live from Wrike
            </p>
            <button type="button"
              onClick={() => setCollapsed(c => ({ ...c, film: c.film.size ? new Set() : new Set(allContainerPaths(filmTreeWithDraft)) }))}
              className="text-[10px] font-bold text-[#768994] hover:text-[#12a0e1] transition-colors shrink-0">
              {collapsed.film.size ? "Expand all" : "Collapse all"}
            </button>
          </div>
          <div className="px-4 py-2 overflow-y-auto">
            {renderTree(filmTreeWithDraft, "film")}
          </div>
        </div>
      )}

      {/* The staged job. Everything below is pre-filled from the slot that was
          clicked plus the studio it sits under; nothing is written until Create
          Job. Remounting on a new draft (or a film change) reloads the defaults. */}
      <div ref={draftRef}>
        {draft ? (
          <div className="border-2 border-[#10b981]/40 rounded-2xl overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-3 bg-[#10b981]/5 border-b border-[#10b981]/20">
              <p className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-[#0d9488] min-w-0">
                <FolderPlus className="w-4 h-4 shrink-0" />
                <span className="truncate">New job · {draft.description}</span>
              </p>
              <button onClick={() => setDraft(null)}
                className="flex items-center gap-1 text-[11px] font-bold text-[#768994] hover:text-rose-500 shrink-0 transition-colors">
                <X className="w-3 h-3" /> Discard
              </button>
            </div>
            <div className="px-5 py-5">
              <JobForm
                key={`${draft.slotLabel}|${draft.code}|${filmTitle}`}
                job={{
                  film_title: filmTitle.trim(),
                  client: STUDIO_CLIENT[studio] || "",
                  project_description: draft.description,
                  // Prefilled from the slot folder's Item Price when it has
                  // one; left blank when it doesn't.
                  fixed_cost: draft.itemPrice ?? "",
                }}
                presetCode={draft.code}
                clients={clients} films={films} workCategories={workCategories} descs={descs}
                onSave={createDraftJob} saving={creatingJob}
                submitLabel="Create Job" layout="inline" />
            </div>
          </div>
        ) : templateTree ? (
          <p className="text-xs text-[#768994] italic">
            Click a slot in the folder preview above to start a job.
          </p>
        ) : null}
      </div>

      {/* Nothing sits here any more. "Push to Wrike" went when Create Job took
          over opening the push confirmation, and "View in Job Book" went with
          it: by the time a job reaches the Book it has already been through
          the push, so there was never a moment where jumping to the Book told
          you something the flow above hadn't. */}

      {/* Req 8 — Review: everything activated this session, each openable to fill
          in costs/billing (autofilled where we can) or undo. Shows across films. */}
      {sessionJobs.length > 0 && (
        <div className="border border-[#dce4ec] rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-3 bg-[#f8fafc] border-b border-[#dce4ec]">
            <p className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-[#122027]">
              <ListChecks className="w-4 h-4 text-[#12a0e1]" />
              Review · {sessionJobs.length} activated this session
            </p>
            <button onClick={undoAllSession} disabled={undoingId === "__bulk__"}
              className="flex items-center gap-1.5 text-[11px] font-bold text-rose-500 hover:text-rose-600 disabled:opacity-40 transition-colors">
              {undoingId === "__bulk__" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Undo2 className="w-3 h-3" />}
              Undo all
            </button>
          </div>
          <div className="divide-y divide-[#f0f4f8] max-h-[300px] overflow-y-auto">
            {sessionJobs.map(j => {
              const code = j.job_number?.match(/XY\d+/)?.[0];
              const hasBilling = j.fixed_cost != null || j.estimated_cost != null || j.third_party_cost != null || j.billed_to;
              return (
                <div key={j.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50/60 transition-colors">
                  <span className="font-mono font-bold text-[#12a0e1] text-xs shrink-0">{code}</span>
                  <span className="text-xs text-[#122027] truncate flex-1 min-w-0">
                    <span className="italic text-[#768994]">{j.film_title}</span>
                    {j.project_description ? ` · ${j.project_description}` : ""}
                  </span>
                  {hasBilling ? (
                    <span className="text-[9px] font-black uppercase tracking-wider text-[#1cc1a5] bg-[#1cc1a5]/10 px-2 py-0.5 rounded-full shrink-0">Details added</span>
                  ) : (
                    <span className="text-[9px] font-black uppercase tracking-wider text-[#f4b740] bg-[#f4b740]/10 px-2 py-0.5 rounded-full shrink-0">Needs details</span>
                  )}
                  <button onClick={() => setReviewJob(j)}
                    className="flex items-center gap-1 text-[11px] font-bold text-[#12a0e1] hover:text-[#0d8bc4] shrink-0 transition-colors">
                    <Eye className="w-3.5 h-3.5" /> Details
                  </button>
                  <button onClick={() => undoActivation(j)} disabled={undoingId === j.id}
                    title="Undo this activation"
                    className="p-1 rounded-lg text-slate-300 hover:text-rose-500 hover:bg-rose-50 shrink-0 transition-colors disabled:opacity-40">
                    {undoingId === j.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Undo2 className="w-3.5 h-3.5" />}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
      )}

      {reviewJob && (
        <JobModal
          job={reviewJob}
          clients={clients} films={films} workCategories={workCategories} descs={descs}
          onSave={handleReviewSave} onClose={() => setReviewJob(null)} saving={reviewSaving}
        />
      )}

      {showFilmSync && (
        <FilmSyncModal studio={studio} existingFilms={films}
          onClose={() => setShowFilmSync(false)} onApplied={loadFilms} />
      )}

      {/* Only what this session activated for the film on screen. Passing the
          film's whole job list dragged in codes from earlier attempts, which
          then showed up as stale rows in the push preview. Still film-scoped
          as well as session-scoped — the session list spans films, and a push
          targets one film's Wrike project. */}
      {pushMode && (
        <PushToWrikeModal
          studio={studio} filmTitle={filmTitle.trim()}
          jobs={sessionJobs.filter(j => (j.film_title || "").trim() === filmTitle.trim())}
          mode={pushMode}
          onClose={() => setPushMode(null)} />
      )}

      {innerTab === "custom" && (
        <div>
          {customCreated == null ? (
            <JobForm job={filmTitle.trim() ? { film_title: filmTitle.trim() } : undefined}
              clients={clients} films={films} workCategories={workCategories} descs={descs}
              onSave={handleCreateCustomJob} saving={customSaving} submitLabel="Create Job" layout="inline" />
          ) : (
            <div className="flex items-center gap-3 py-4">
              <span className="flex items-center gap-2 px-4 py-2.5 bg-[#1cc1a5]/10 text-[#1cc1a5] text-sm font-bold rounded-2xl">
                <CheckCircle2 className="w-3.5 h-3.5" /> Created {customCreated} in Job Book
              </span>
              <button onClick={() => setActiveTab?.("jobs")}
                className="px-4 py-2.5 bg-[#122027] hover:bg-[#1a2e38] text-white text-sm font-bold rounded-xl transition-[background-color] ease-[cubic-bezier(0.16,1,0.3,1)]">
                View in Job Book
              </button>
              <button onClick={() => setCustomCreated(null)}
                className="px-4 py-2.5 bg-white border border-[#dce4ec] hover:border-[#12a0e1] text-[#122027] text-sm font-bold rounded-xl transition-[border-color] ease-[cubic-bezier(0.16,1,0.3,1)]">
                Add Another Job
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Studio Job-Number Scanner ──────────────────────────────────────────────────
// Walks every visible Wrike folder for canonical "Film : CODE, Desc" job folders
// and backfills the Job Book with any codes it doesn't already have. Read-only
// against Wrike; the only write is the confirmed bulk insert into `jobs`, and it
// never touches an existing row (codes already in the book are shown but locked).
const scanCodeOf = (s) => {
  const m = (s || "").match(/XY\d{5,6}/i);
  return m ? m[0].toUpperCase() : (s || "").trim().toUpperCase();
};

// The "film" of a job label: the part before " : ". A bare year/number (e.g.
// "2026") or a letterless token isn't a real film — those are what the scan's
// year-folder fix now resolves to a real parent film.
const scanFilmOf = (s) => ((s || "").includes(" : ") ? (s || "").split(" : ")[0] : "").trim();
const scanIsPseudoFilm = (film) => !film || /^\d{2,4}$/.test(film.trim()) || !/[a-z]/i.test(film);

// A book row that is nothing but the bare code — the stub `ensureJob` writes
// the first time a job is seen in use, before anyone files it properly.
const scanIsBareCode = (s) => /^\s*XY\d{5,6}\s*$/i.test(s || "");

// The description a book row currently carries: everything after the first
// comma in its job number.
//
// Read off job_number rather than the project_description column on purpose.
// The rows this exists to catch were written by ensureJob, which only ever
// sets job_number/film_title/client — so their project_description is still
// null while the description itself sits inside the job number string.
const scanDescOf = (s) => {
  const i = (s || "").indexOf(",");
  return i === -1 ? "" : s.slice(i + 1).trim();
};

// How complete a book row is, used to pick which row wins when the same code
// appears more than once. `jobs.job_number` is unique, so "XY025091" and
// "The History of Sound : XY025091, NM Packshots FinalWindow" coexist happily
// as separate rows for one job — the constraint only stops two rows sharing
// the *same string*. Canonical "Film : CODE, Description" beats "Film : CODE"
// beats a bare stub.
const scanRowRank = (s) =>
  scanIsBareCode(s) ? 0 : (s || "").includes(" : ") ? ((s || "").includes(",") ? 2 : 1) : 0;

function StudioJobScanModal({ onClose, onApplied }) {
  const [phase, setPhase] = useState("scanning"); // scanning | review | saving | done
  const [error, setError] = useState("");
  const [candidates, setCandidates] = useState([]);
  const [totalFolders, setTotalFolders] = useState(0);
  const [existingCodes, setExistingCodes] = useState(new Set());
  const [existingByCode, setExistingByCode] = useState({}); // code -> best book row
  const [existingExtras, setExistingExtras] = useState({}); // code -> that code's other book rows
  const [fixedCount, setFixedCount] = useState(0);
  const [selected, setSelected] = useState({});   // code -> bool
  const [savedCount, setSavedCount] = useState(0);
  const [search, setSearch] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);
  const [showCorrections, setShowCorrections] = useState(false);

  const loadScan = useCallback(async () => {
    setPhase("scanning");
    try {
      // Whole table — a truncated read would make jobs already in the book look
      // new and invite duplicate inserts.
      const [found, existing] = await Promise.all([
        scanStudioJobNumbers(),
        selectAll("jobs", "id, job_number, film_title, client"),
      ]);
      // One code can own several book rows (a bare stub plus the properly filed
      // row, or two spellings of the same description). Keep the most complete
      // row as the one a correction is measured against and applied to, and
      // hang on to the rest — blindly overwriting the map, as this used to,
      // could leave a stub as the "current" row and then try to rewrite it to a
      // string its own sibling already holds, which is what tripped
      // jobs_job_number_key.
      const byCode = {};
      const extrasByCode = {};
      existing.forEach((j) => {
        const code = scanCodeOf(j.job_number);
        const prev = byCode[code];
        if (!prev) { byCode[code] = j; return; }
        const keep = scanRowRank(j.job_number) > scanRowRank(prev.job_number) ? j : prev;
        byCode[code] = keep;
        (extrasByCode[code] = extrasByCode[code] || []).push(keep === j ? prev : j);
      });
      const have = new Set(Object.keys(byCode));
      const sel = {};
      found.forEach((c) => { if (!have.has(c.code)) sel[c.code] = true; });
      setExistingCodes(have);
      setExistingByCode(byCode);
      setExistingExtras(extrasByCode);
      setCandidates(found);
      setTotalFolders(found.totalFolders || 0);
      setSelected(sel);
      setPhase("review");
    } catch (e) {
      setError(e.message || String(e));
      setPhase("review");
    }
  }, []);

  useEffect(() => { let alive = true; if (alive) loadScan(); return () => { alive = false; }; }, [loadScan]);

  // Existing book rows that disagree with Wrike. Three kinds:
  //   • a pseudo-film ("2026") the re-derived scan now resolves to a real film;
  //   • a row filed under the WRONG film, or carrying a malformed code
  //     ("XY026089_SKY_VIP" instead of "XY026089");
  //   • a row whose DESCRIPTION describes something else entirely.
  // The second kind is why "0 new" can coexist with jobs you can't find: the
  // code IS in the book, so the scan skips it as a duplicate, but it's filed
  // under someone else's film and no film search will ever surface it. Wrike's
  // folder tree is the source of truth. Nothing is written without a confirm.
  const corrections = candidates.filter((c) => {
    const cur = existingByCode[c.code];
    if (!cur) return false;
    if (!c.filmTitle || scanIsPseudoFilm(c.filmTitle)) return false; // scan has nothing better
    const curFilm = scanFilmOf(cur.job_number) || cur.film_title || "";
    const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const filmWrong = norm(curFilm) !== norm(c.filmTitle);
    // Canonical code position is the bare code — a suffix means the folder name
    // leaked into it.
    const codeMalformed = !new RegExp(`(^|\\s:\\s)${c.code}\\s*,`, "i").test(cur.job_number || "");
    // A description that isn't this job's at all. The signature case is a row
    // built from a TASK name back when the pull paths did that — the book says
    // "ODY_Print_Teaser1SHT_Birds_CMYK_KR" where the folder says "French Canada
    // Assets". Such a row has the right film and a well-formed code, so both
    // tests above pass it and nothing ever offered to repair it.
    //
    // descriptionsAgree is loose on purpose (wording, punctuation, and the
    // region prefix the scan adds are all treated as agreement) so this only
    // fires when the two are describing different work. An empty description on
    // either side counts as agreement, so a row nobody has a better answer for
    // is left alone rather than churned.
    const descWrong = !descriptionsAgree(scanDescOf(cur.job_number), c.projectDescription);
    // Another row for this code already IS what the scan would write, and this
    // one isn't — typically the region twin, where the book holds both
    // "…, Titles" and "…, INT - Titles" and the canonical one is the sibling.
    // Routed through corrections rather than deleted here so that fixMisfilmed's
    // existing twin handling does the work: it drops this row and lets the
    // canonical sibling stand, which is precisely the wanted outcome.
    const supersededByTwin =
      (cur.job_number || "") !== c.jobNumber &&
      (existingExtras[c.code] || []).some((r) => (r.job_number || "") === c.jobNumber);
    return filmWrong || codeMalformed || descWrong || supersededByTwin;
  });

  const allNew  = candidates.filter((c) => !existingCodes.has(c.code));
  const newOnes = allNew.filter((c) => !activeOnly || !c.archived);
  const archivedHidden = activeOnly ? allNew.filter((c) => c.archived).length : 0;
  const dupes   = candidates.filter((c) => existingCodes.has(c.code));
  const shown = newOnes.filter((c) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      c.code.toLowerCase().includes(q) ||
      (c.filmTitle || "").toLowerCase().includes(q) ||
      (c.client || "").toLowerCase().includes(q) ||
      // Region too, so a backfill can be done one territory at a time ("uk").
      (c.region || "").toLowerCase().includes(q)
    );
  });
  const selectedCount = newOnes.filter((c) => selected[c.code]).length;
  const allShownSelected = shown.length > 0 && shown.every((c) => selected[c.code]);

  const toggle = (code) => setSelected((p) => ({ ...p, [code]: !p[code] }));
  const toggleAllShown = () =>
    setSelected((p) => {
      const next = { ...p };
      shown.forEach((c) => { next[c.code] = !allShownSelected; });
      return next;
    });

  const apply = async () => {
    const rows = newOnes
      .filter((c) => selected[c.code])
      .map((c) => ({
        job_number: c.jobNumber,
        film_title: c.filmTitle || null,
        client: c.client || null,
        project_description: c.projectDescription || null,
        start_date: c.createdDate || null, // Wrike folder creation date
      }));
    if (!rows.length) return;
    setPhase("saving");
    // Chunked insert so a large backfill doesn't hit request limits.
    let saved = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { error: err } = await supabase.from("jobs").insert(chunk);
      if (err) { setError(err.message); setPhase("review"); return; }
      saved += chunk.length;
    }
    setSavedCount(saved);
    setPhase("done");
  };

  // The scan's own candidate for a code, so the rules below can defer to what
  // it would write rather than encoding a house style of their own.
  const candByCode = useMemo(() => {
    const m = {};
    candidates.forEach((c) => { m[c.code] = c; });
    return m;
  }, [candidates]);

  // Extra rows for a code that carry nothing the kept row doesn't. Two shapes:
  //
  //   • a bare "XY025091" stub sitting beside a properly filed row — what
  //     ensureJob writes the first time a job is seen in use;
  //   • a REGION TWIN: the same film and the same description, differing only
  //     in the region prefix the scan writes ("Shrek 5 : XY023362, Titles"
  //     beside "Shrek 5 : XY023362, INT - Titles"). jobs.job_number is unique
  //     on the whole string, so both rows are legal and both show up in every
  //     job picker, with useJobLookup silently preferring whichever has the
  //     lower id.
  //
  // Only ever removes the extra when the KEPT row is the one the scan itself
  // would write. When it's the other way round — the kept row is the scruffy
  // one and an extra is canonical — nothing is deleted here; `supersededByTwin`
  // routes that through corrections instead, where the existing twin handling
  // drops the kept row and lets the canonical sibling stand.
  //
  // The film must match too. "Universal House Job : XY018540, Digital
  // Housekeeping" and "XYi Internal Use : XY018540, Digital Housekeeping" have
  // identical descriptions and are NOT duplicates — they are the same code
  // filed under two different owners, which is a judgement call for a human and
  // is already surfaced by filmWrong.
  const redundantRows = Object.entries(existingExtras).flatMap(([code, rows]) => {
    const kept = existingByCode[code];
    if (!kept || scanIsBareCode(kept.job_number)) return [];
    const cand = candByCode[code];
    const keptIsCanonical = !!cand && kept.job_number === cand.jobNumber;
    const keptFilm = scanFilmOf(kept.job_number).toLowerCase();
    return rows.filter((r) => {
      if (scanIsBareCode(r.job_number)) return true;
      if (!keptIsCanonical) return false;
      if ((r.job_number || "") === kept.job_number) return false;
      return (
        scanFilmOf(r.job_number).toLowerCase() === keptFilm &&
        descriptionsAgree(scanDescOf(r.job_number), scanDescOf(kept.job_number))
      );
    });
  });

  // Correct existing book rows whose film was a pseudo-film ("2026") to the
  // real film the re-derived scan found — updates film, client, job number and
  // description in place. Only touches the `corrections` set (safe rows).
  const fixMisfilmed = async () => {
    if (!corrections.length && !redundantRows.length) return;
    const total = corrections.length + redundantRows.length;
    const ok = await confirmAction({
      title: `Fix ${total} book ${total === 1 ? "entry" : "entries"}?`,
      message:
        (corrections.length
          ? `${corrections.length} ${corrections.length === 1 ? "entry disagrees" : "entries disagree"} with Wrike's folder tree — wrong film, a year/placeholder film, or the folder name left inside the job number. This rewrites their film, client, description and job number to match Wrike. `
          : "") +
        (redundantRows.length
          ? `${redundantRows.length} duplicate ${redundantRows.length === 1 ? "entry says" : "entries say"} nothing the properly filed row for the same job doesn't — a bare code, or the same description without its region prefix — and will be deleted. `
          : "") +
        "Use Review first to see every before → after.",
      confirmLabel: `Fix ${total}`,
    });
    if (!ok) return;
    setPhase("saving");
    let fixed = 0;
    let merged = 0;
    const failures = [];
    for (const c of corrections) {
      const cur = existingByCode[c.code];
      // Another row for this code already *is* what Wrike says this one should
      // become. Rewriting would violate jobs_job_number_key, and the right
      // outcome isn't two identical rows anyway — drop this one and let the
      // already-correct sibling stand.
      const twin = (existingExtras[c.code] || []).find(
        (r) => (r.job_number || "") === c.jobNumber
      );
      if (twin) {
        const { error: delErr } = await supabase.from("jobs").delete().eq("id", cur.id);
        if (delErr) failures.push(`${c.code}: ${delErr.message}`);
        else merged += 1;
        continue;
      }
      const { error: err } = await supabase.from("jobs").update({
        job_number: c.jobNumber,
        film_title: c.filmTitle || null,
        client: c.client || null,
        project_description: c.projectDescription || null,
      }).eq("id", cur.id);
      // One bad row used to abort the whole run, leaving every later correction
      // unapplied and no record of which one failed. Keep going and report.
      if (err) failures.push(`${c.code}: ${err.message}`);
      else fixed += 1;
    }

    if (redundantRows.length) {
      const ids = redundantRows.map((r) => r.id);
      for (let i = 0; i < ids.length; i += 200) {
        const { error: delErr } = await supabase
          .from("jobs").delete().in("id", ids.slice(i, i + 200));
        if (delErr) failures.push(`duplicate cleanup: ${delErr.message}`);
        else merged += Math.min(200, ids.length - i);
      }
    }

    setFixedCount(fixed + merged);
    setError(
      failures.length
        ? `${failures.length} of ${corrections.length} couldn't be fixed — ${failures.slice(0, 3).join("; ")}${failures.length > 3 ? "…" : ""}`
        : ""
    );
    await loadScan(); // re-derive so corrected rows drop out of the list
  };

  return (
    <div className="fixed inset-0 z-[9999] bg-black/40 flex items-center justify-center p-4" onMouseDown={onClose}>
      <div
        className="bg-white rounded-3xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <h2 className="text-lg font-black text-[#122027]">Scan Wrike for job numbers</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X className="w-5 h-5" /></button>
        </div>

        {phase === "scanning" && (
          <div className="flex-1 flex flex-col items-center justify-center py-20 gap-3 text-[#768994]">
            <RefreshCw className="w-6 h-6 animate-spin text-[#1cc1a5]" />
            <p className="font-bold text-sm">Reading the Wrike folder tree…</p>
          </div>
        )}

        {phase === "done" && (
          <div className="flex-1 flex flex-col items-center justify-center py-20 gap-3">
            <CheckCircle2 className="w-10 h-10 text-emerald-500" />
            <p className="font-black text-[#122027]">Added {savedCount} {savedCount === 1 ? "job" : "jobs"} to the Job Book.</p>
            <button onClick={onApplied} className="mt-2 px-5 py-2 bg-[#1cc1a5] hover:bg-[#17a892] text-white text-sm font-bold rounded-xl">
              Done
            </button>
          </div>
        )}

        {(phase === "review" || phase === "saving") && (
          <>
            <div className="px-6 py-3 border-b border-slate-100 flex flex-wrap items-center gap-3 text-[11px] font-bold">
              <span className="text-emerald-600">{newOnes.length} new</span>
              <span className="text-[#768994]">{dupes.length} already in book</span>
              {archivedHidden > 0 && <span className="text-slate-400">{archivedHidden} archived hidden</span>}
              <span className="text-[#122027]">{candidates.length} job codes / {totalFolders} folders</span>
              <label className="ml-auto flex items-center gap-1.5 text-[#122027] cursor-pointer">
                <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} className="accent-[#1cc1a5]" />
                Active only
              </label>
              {/* The fix result was previously computed and never shown, so a
                  partial run looked identical to a clean one. */}
              {fixedCount > 0 && !error && (
                <span className="text-emerald-600">✓ Fixed {fixedCount}</span>
              )}
              {error && <span className="text-rose-500">⚠ {error}</span>}
            </div>

            {(corrections.length > 0 || redundantRows.length > 0) && (
              <div className="border-b border-amber-100 bg-amber-50/60">
                <div className="px-6 py-2.5 flex items-center gap-3">
                  <span className="text-[11px] font-bold text-amber-700">
                    {corrections.length > 0 && (
                      <>
                        {corrections.length} existing {corrections.length === 1 ? "entry disagrees" : "entries disagree"} with Wrike — filed under the wrong film, describing different work, or with the folder name stuck in the job number. These are in the book already, which is why they don’t show as new.
                      </>
                    )}
                    {redundantRows.length > 0 && (
                      <>
                        {corrections.length > 0 ? " " : ""}
                        {redundantRows.length} duplicate {redundantRows.length === 1 ? "entry says" : "entries say"} nothing the properly filed row doesn’t — a bare code, or the same description minus its region prefix — so fixing removes {redundantRows.length === 1 ? "it" : "them"}.
                      </>
                    )}
                  </span>
                  <button onClick={() => setShowCorrections(v => !v)}
                    className="ml-auto shrink-0 px-3 py-1.5 bg-white border border-amber-300 hover:border-amber-400 text-amber-700 text-[11px] font-bold rounded-lg transition-colors">
                    {showCorrections ? "Hide" : "Review"}
                  </button>
                  <button onClick={fixMisfilmed} disabled={phase === "saving"}
                    className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white text-[11px] font-bold rounded-lg transition-colors">
                    Fix {corrections.length + redundantRows.length}
                  </button>
                </div>
                {showCorrections && (
                  <div className="max-h-52 overflow-y-auto border-t border-amber-100 px-6 py-2">
                    <table className="w-full text-[11px]">
                      <tbody>
                        {corrections.map((c) => (
                          <tr key={c.code} className="align-top">
                            <td className="py-1 pr-3 font-mono font-black text-amber-700 whitespace-nowrap">{c.code}</td>
                            <td className="py-1 pr-2 text-slate-400 line-through truncate max-w-[240px]"
                                title={existingByCode[c.code]?.job_number}>
                              {existingByCode[c.code]?.job_number || "—"}
                            </td>
                            <td className="py-1 text-[#122027] truncate max-w-[240px]" title={c.jobNumber}>
                              → {c.jobNumber}
                            </td>
                          </tr>
                        ))}
                        {/* Duplicate stubs aren't rewritten, they're removed —
                            show them here too so Review really is every change. */}
                        {redundantRows.map((r) => (
                          <tr key={`stub-${r.id}`} className="align-top">
                            <td className="py-1 pr-3 font-mono font-black text-amber-700 whitespace-nowrap">
                              {scanCodeOf(r.job_number)}
                            </td>
                            <td className="py-1 pr-2 text-slate-400 line-through truncate max-w-[240px]"
                                title={r.job_number}>
                              {r.job_number}
                            </td>
                            <td className="py-1 text-slate-500 italic truncate max-w-[240px]"
                                title={existingByCode[scanCodeOf(r.job_number)]?.job_number}>
                              → duplicate, removed (kept: {existingByCode[scanCodeOf(r.job_number)]?.job_number})
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {newOnes.length === 0 ? (
              <div className="flex-1 flex items-center justify-center py-16 text-center text-[#768994] italic text-sm px-8">
                {error
                  ? "Scan failed — see above."
                  : totalFolders === 0
                  ? "Wrike returned no folders — the connection isn’t authorised in this environment."
                  : candidates.length === 0
                  ? `Walked ${totalFolders} folders but found no XY job codes.`
                  : "No new job numbers found. The Job Book is already up to date."}
              </div>
            ) : (
              <>
                <div className="px-6 py-2.5 flex items-center gap-3 border-b border-slate-100">
                  <label className="flex items-center gap-2 text-[11px] font-black text-[#768994] cursor-pointer shrink-0">
                    <input type="checkbox" checked={allShownSelected} onChange={toggleAllShown} className="accent-[#1cc1a5]" />
                    Select shown
                  </label>
                  <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#768994]" />
                    <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter…"
                      className="w-full pl-8 pr-3 py-1.5 text-[12px] border border-slate-200 rounded-lg outline-none focus:border-[#1cc1a5]" />
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto">
                  <table className="w-full text-[12px]">
                    <thead className="sticky top-0 bg-slate-50 z-10">
                      <tr className="text-left text-[9px] font-black uppercase tracking-widest text-[#768994]">
                        <th className="px-4 py-2 w-8"></th>
                        <th className="px-2 py-2">Code</th>
                        <th className="px-2 py-2">Film</th>
                        <th className="px-2 py-2">Region</th>
                        <th className="px-2 py-2">Client</th>
                        <th className="px-2 py-2">Description</th>
                        <th className="px-2 py-2">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((c) => (
                        <tr key={c.code} className="border-b border-slate-50 hover:bg-slate-50/60 cursor-pointer" onClick={() => toggle(c.code)}>
                          <td className="px-4 py-2"><input type="checkbox" checked={!!selected[c.code]} onChange={() => toggle(c.code)} className="accent-[#1cc1a5]" onClick={(e) => e.stopPropagation()} /></td>
                          <td className="px-2 py-2 font-black font-mono text-[#1cc1a5]">{c.code}</td>
                          <td className="px-2 py-2 font-bold text-[#122027] truncate max-w-[140px]" title={c.jobNumber}>{c.filmTitle || "—"}</td>
                          <td className="px-2 py-2">
                            {c.region
                              ? <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-[#12a0e1]/10 text-[#12a0e1]">{c.region}</span>
                              : <span className="text-slate-300">—</span>}
                          </td>
                          <td className="px-2 py-2 text-slate-600">{c.client || <span className="text-slate-300">—</span>}</td>
                          <td className="px-2 py-2 text-slate-500 truncate max-w-[180px]" title={c.projectDescription}>{c.projectDescription || "—"}</td>
                          <td className="px-2 py-2 text-slate-400 whitespace-nowrap tabular-nums">{c.createdDate || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="px-6 py-3 border-t border-slate-100 flex items-center justify-between">
                  <p className="text-[11px] text-[#768994] font-medium">Taken from the folder title, prefixed with the region its studio folder sits under — existing rows are never touched.</p>
                  <button onClick={apply} disabled={selectedCount === 0 || phase === "saving"}
                    className="flex items-center gap-1.5 px-5 py-2 bg-[#1cc1a5] hover:bg-[#17a892] disabled:bg-slate-200 disabled:text-slate-400 text-white text-sm font-bold rounded-xl transition-[background-color] ease-[cubic-bezier(0.16,1,0.3,1)]">
                    {phase === "saving" ? <><RefreshCw className="w-4 h-4 animate-spin" /> Saving…</> : <><Plus className="w-4 h-4" /> Add {selectedCount} to Job Book</>}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Job Book Section ───────────────────────────────────────────────────────────
// Exported: also rendered standalone as the PMs' "Job Book" page (JobBook.jsx).
export function JobBookSection({ setActiveTab }) {
  const JOBBOOK_COLS = [
    { key: "job_number",  label: "Job #",               px: 110 },
    { key: "date",        label: "Date",                px: 90  },
    { key: "client",      label: "Client",              px: 140 },
    { key: "office",      label: "Office",              px: 70  },
    { key: "pd",          label: "P/D",                 px: 60  },
    { key: "film",        label: "Film Title",          px: 160 },
    { key: "project",     label: "Project Description", px: 220 },
    { key: "costs",       label: "Costs",               px: 90  },
    { key: "ordered_by",  label: "Ordered By",          px: 120 },
    { key: "billed_to",   label: "Billed To",           px: 120 },
    { key: "status",      label: "Status",              px: 110 },
    { key: "done",        label: "Done",                px: 70  },
    { key: "actions",     label: "",                    px: 90  },
  ];
  const { widths: jbWidths, resizeHandle: jbHandle } = useColumnResize("mgmt-jobbook-cols", JOBBOOK_COLS);

  const [jobs, setJobs]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [search, setSearch]     = useState("");
  const [monthFilter, setMonthFilter] = useState(() => new Date().toISOString().slice(0, 7));
  const [showModal, setShowModal] = useState(false);
  const [showScan, setShowScan] = useState(false);
  const [editJob, setEditJob]   = useState(null);
  const [saving, setSaving]     = useState(false);
  const [clients, setClients]   = useState([]);
  const [films, setFilms]       = useState([]);
  const [workCategories, setWorkCategories] = useState([]);
  const [descs, setDescs]       = useState([]);
  const [page, setPage]         = useState(0);
  const PER_PAGE = 50;

  // ── Bulk edit ────────────────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkField, setBulkField] = useState("client");
  const [bulkValue, setBulkValue] = useState("");
  const [bulkBusy, setBulkBusy]   = useState(false);

  const loadRef = useCallback(async () => {
    const [c, f, cat, d] = await Promise.all([
      supabase.from("clients").select("name").order("name"),
      supabase.from("films").select("title, created_at").order("created_at", { ascending: false }),
      supabase.from("job_work_categories").select("name").order("name"),
      supabase.from("project_descriptions").select("description").order("description"),
    ]);
    setClients((c.data || []).map(x => x.name));
    setFilms((f.data || []).map(x => x.title));
    setWorkCategories((cat.data || []).map(x => x.name));
    setDescs((d.data || []).map(x => x.description));
  }, []);

  const loadJobs = useCallback(async () => {
    setLoading(true);
    // The whole book — this table paginates client-side, so a 1000-row read
    // just made every page past the first one lie.
    const data = await selectAll("jobs", "*", (q) => {
      if (!monthFilter) return q;
      const start = monthFilter + "-01";
      const end = new Date(monthFilter + "-01");
      end.setMonth(end.getMonth() + 1);
      return q.gte("start_date", start).lt("start_date", end.toISOString().slice(0, 10));
    });
    // selectAll orders by id ascending (its pagination depends on it); the book
    // reads newest-first.
    setJobs(data.slice().reverse());
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
    // supabase-js resolves rather than throws on a database error, so an
    // unchecked write here closed the modal and reported nothing while the row
    // was rejected. That already happened for a duplicate job number; with
    // jobs_job_code_key it also happens for a duplicate CODE under a different
    // label, which is exactly the case someone editing a job is most likely to
    // hit. Keep the modal open and say why.
    const { error } = editJob?.id
      ? await supabase.from("jobs").update(payload).eq("id", editJob.id)
      : await supabase.from("jobs").insert(payload);
    setSaving(false);
    if (error) {
      notify(
        error.code === "23505"
          ? `Job number “${form.job_number}” clashes with a job already in the book — the same XY code can only be filed once.`
          : "Couldn't save the job: " + error.message,
        "error"
      );
      return;
    }
    setShowModal(false); setEditJob(null);
    await loadJobs();
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

  // Columns that can be set across many rows at once. `type` drives the value
  // control; `list` supplies a datalist of existing values for free-text fields.
  const BULK_FIELDS = [
    { key: "client",              label: "Client",              type: "text",   list: clients },
    { key: "status",             label: "Status",              type: "select", opts: JOB_STATUSES },
    { key: "print_digital",       label: "Print / Digital",     type: "select", opts: ["Digital", "Print", "XYi"] },
    { key: "office",              label: "Office",              type: "text" },
    { key: "film_title",          label: "Film Title",          type: "text",   list: films },
    { key: "project_description", label: "Project Description", type: "text",   list: descs },
    { key: "ordered_by",          label: "Ordered By",          type: "text" },
    { key: "billed_to",           label: "Billed To",           type: "text" },
    { key: "start_date",          label: "Start Date",          type: "date" },
    { key: "job_done",            label: "Done",                type: "bool" },
  ];
  const activeBulkField = BULK_FIELDS.find((f) => f.key === bulkField) || BULK_FIELDS[0];

  // Selection is over the *filtered* set (across pages), so a search + "select
  // all" lets you retag a whole studio's worth of imported rows in one go.
  const filteredIds = useMemo(() => filtered.map((j) => j.id), [filtered]);
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => selectedIds.has(id));
  const toggleRow = (id) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const toggleAllFiltered = () =>
    setSelectedIds(allFilteredSelected ? new Set() : new Set(filteredIds));
  const clearSelection = () => setSelectedIds(new Set());

  const applyBulk = async () => {
    if (!selectedIds.size) return;
    let val;
    if (activeBulkField.type === "bool") val = bulkValue === "yes";
    else if (activeBulkField.type === "date") val = bulkValue || null;
    else val = bulkValue.trim() === "" ? null : bulkValue.trim();

    const ok = await confirmAction({
      title: `Set ${activeBulkField.label} on ${selectedIds.size} job${selectedIds.size === 1 ? "" : "s"}?`,
      message:
        val === null
          ? `This clears ${activeBulkField.label} on every selected row.`
          : `Every selected row's ${activeBulkField.label} becomes “${activeBulkField.type === "bool" ? (val ? "Done" : "Not done") : val}”.`,
      confirmLabel: "Apply to all",
    });
    if (!ok) return;

    setBulkBusy(true);
    const ids = [...selectedIds];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { error: err } = await supabase.from("jobs").update({ [bulkField]: val }).in("id", chunk);
      if (err) { setBulkBusy(false); await confirmAction({ title: "Bulk update failed", message: err.message, confirmLabel: "OK" }); return; }
    }
    setBulkBusy(false);
    clearSelection();
    setBulkValue("");
    await loadJobs();
  };

  const bulkDelete = async () => {
    if (!selectedIds.size) return;
    const n = selectedIds.size;
    const ok = await confirmAction({
      title: `Delete ${n} job${n === 1 ? "" : "s"}?`,
      message: `${n} Job Book row${n === 1 ? "" : "s"} will be permanently removed. This can't be undone. (Rescanning Wrike re-imports them.)`,
      confirmLabel: `Delete ${n}`,
      danger: true,
    });
    if (!ok) return;
    setBulkBusy(true);
    const ids = [...selectedIds];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { error: err } = await supabase.from("jobs").delete().in("id", chunk);
      if (err) { setBulkBusy(false); await confirmAction({ title: "Bulk delete failed", message: err.message, confirmLabel: "OK" }); return; }
    }
    setBulkBusy(false);
    clearSelection();
    await loadJobs();
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
            className="w-full pl-9 pr-4 py-2 text-sm border border-[#dce4ec] rounded-xl outline-none focus:border-[#1cc1a5] bg-white"
          />
        </div>
        <button onClick={() => setShowScan(true)}
          className="flex items-center gap-1.5 px-4 py-2 bg-white border border-[#dce4ec] hover:border-[#1cc1a5] text-[#122027] text-sm font-bold rounded-xl transition-[border-color] ease-[cubic-bezier(0.16,1,0.3,1)] shrink-0">
          <RefreshCw className="w-4 h-4 text-[#1cc1a5]" /> Scan Wrike
        </button>
        <button onClick={() => setActiveTab?.("jobsSetup")}
          className="flex items-center gap-1.5 px-4 py-2 bg-[#1cc1a5] hover:bg-[#17a892] text-white text-sm font-bold rounded-xl transition-[background-color] ease-[cubic-bezier(0.16,1,0.3,1)] shrink-0">
          <Plus className="w-4 h-4" /> Add Jobs
        </button>
      </div>

      {showScan && (
        <StudioJobScanModal
          onClose={() => setShowScan(false)}
          onApplied={async () => { setShowScan(false); await loadJobs(); }}
        />
      )}

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

      {selectedIds.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 bg-[#1cc1a5]/[0.06] border border-[#1cc1a5]/30 rounded-2xl px-4 py-2.5">
          <span className="text-[11px] font-black text-[#1cc1a5]">{selectedIds.size} selected</span>
          <button onClick={clearSelection} className="text-[11px] font-bold text-[#768994] hover:text-rose-500">Clear</button>
          <span className="text-[11px] font-bold text-[#768994] ml-2">Set</span>
          <select value={bulkField} onChange={(e) => { setBulkField(e.target.value); setBulkValue(""); }}
            className="text-[12px] font-bold border border-[#dce4ec] rounded-lg px-2 py-1.5 bg-white outline-none focus:border-[#1cc1a5]">
            {BULK_FIELDS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
          <span className="text-[11px] font-bold text-[#768994]">to</span>
          {activeBulkField.type === "select" ? (
            <select value={bulkValue} onChange={(e) => setBulkValue(e.target.value)}
              className="text-[12px] font-bold border border-[#dce4ec] rounded-lg px-2 py-1.5 bg-white outline-none focus:border-[#1cc1a5] min-w-[120px]">
              <option value="">— (clear)</option>
              {activeBulkField.opts.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : activeBulkField.type === "bool" ? (
            <select value={bulkValue} onChange={(e) => setBulkValue(e.target.value)}
              className="text-[12px] font-bold border border-[#dce4ec] rounded-lg px-2 py-1.5 bg-white outline-none focus:border-[#1cc1a5]">
              <option value="">—</option>
              <option value="yes">Done</option>
              <option value="no">Not done</option>
            </select>
          ) : activeBulkField.type === "date" ? (
            <input type="date" value={bulkValue} onChange={(e) => setBulkValue(e.target.value)}
              className="text-[12px] font-bold border border-[#dce4ec] rounded-lg px-2 py-1.5 bg-white outline-none focus:border-[#1cc1a5]" />
          ) : (
            <>
              <input list={`bulk-${activeBulkField.key}`} value={bulkValue} onChange={(e) => setBulkValue(e.target.value)}
                placeholder="value (blank = clear)"
                className="text-[12px] font-medium border border-[#dce4ec] rounded-lg px-2.5 py-1.5 bg-white outline-none focus:border-[#1cc1a5] min-w-[180px]" />
              {activeBulkField.list && (
                <datalist id={`bulk-${activeBulkField.key}`}>
                  {activeBulkField.list.map(v => <option key={v} value={v} />)}
                </datalist>
              )}
            </>
          )}
          <button onClick={applyBulk} disabled={bulkBusy}
            className="ml-auto flex items-center gap-1.5 px-4 py-1.5 bg-[#1cc1a5] hover:bg-[#17a892] disabled:bg-slate-200 disabled:text-slate-400 text-white text-[12px] font-bold rounded-lg transition-[background-color] ease-[cubic-bezier(0.16,1,0.3,1)]">
            {bulkBusy ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Applying…</> : `Apply to ${selectedIds.size}`}
          </button>
          <button onClick={bulkDelete} disabled={bulkBusy} title="Delete selected rows"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-rose-200 hover:bg-rose-50 hover:border-rose-300 disabled:opacity-40 text-rose-600 text-[12px] font-bold rounded-lg transition-[background-color,border-color] ease-[cubic-bezier(0.16,1,0.3,1)]">
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16 gap-2 text-[#768994]">
          <RefreshCw className="w-4 h-4 animate-spin" /> Loading jobs…
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-[#dce4ec]">
          <table className="w-full text-xs [&_td]:overflow-hidden" style={{ tableLayout: "fixed", minWidth: `${JOBBOOK_COLS.reduce((s, c) => s + jbWidths[c.key], 0)}px` }}>
            <colgroup>
              {JOBBOOK_COLS.map(c => <col key={c.key} style={{ width: jbWidths[c.key] }} />)}
            </colgroup>
            <thead>
              <tr className="bg-[#0d1b22] border-b border-white/10">
                {JOBBOOK_COLS.map(c => (
                  <th key={c.key} className="relative px-3 py-2.5 text-left text-[9px] font-black uppercase tracking-widest text-white border-r border-white/5 last:border-r-0 whitespace-nowrap overflow-hidden">
                    {c.key === "job_number" ? (
                      <span className="flex items-center gap-2">
                        <input type="checkbox" checked={allFilteredSelected} onChange={toggleAllFiltered}
                          title="Select all filtered" className="accent-[#1cc1a5]" />
                        {c.label}
                      </span>
                    ) : c.label}
                    {jbHandle(c.key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paginated.length === 0 ? (
                <tr><td colSpan={JOBBOOK_COLS.length} className="text-center py-12 text-[#768994] italic">No jobs found</td></tr>
              ) : paginated.map(j => (
                <tr key={j.id} className={`border-b border-[#dce4ec] last:border-0 transition-colors ${selectedIds.has(j.id) ? "bg-[#1cc1a5]/5" : "hover:bg-slate-50/50"} ${j.job_done ? "opacity-50" : ""}`}>
                  <td className="px-3 py-2.5">
                    <span className="flex items-start gap-2">
                      <input type="checkbox" checked={selectedIds.has(j.id)} onChange={() => toggleRow(j.id)} className="accent-[#1cc1a5] mt-0.5 shrink-0" />
                      <span className="font-black text-[#1cc1a5] font-mono">{j.job_number}</span>
                    </span>
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
          clients={clients} films={films} workCategories={workCategories} descs={descs}
          onSave={handleSave} onClose={() => { setShowModal(false); setEditJob(null); }}
          saving={saving}
        />
      )}
    </div>
  );
}

// ── Jobs Feed ─────────────────────────────────────────────────────────────────
// Exported: also rendered inside the PMs' standalone Job Book page (JobBook.jsx).
// ── Week helpers (ISO weeks, Monday-start) ───────────────────────────────────
// The feed is read week-by-week ("view by week"), so the period pickers are
// weeks rather than months. ISO week numbering matches the numbering the
// reports this view replaces already use.
const mondayOf = (d) => {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return m;
};
const isoWeekNo = (d) => {
  // Shift to the Thursday of the same week — the ISO rule that decides which
  // year (and therefore which week 1) a boundary week belongs to.
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
};
const isoDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// How far back the week pickers reach. 18 months covers the current and prior
// financial year, which is as far as anyone reads this feed back.
const WEEKS_BACK = 78;

// Filter-bar dropdown. Wraps StrictSelect — the app's one dropdown — so these
// read and behave like every other picker (searchable, portaled so it opens
// over the table rather than being clipped by it, correct under the app-wide
// zoom). StrictSelect speaks plain strings, so this adapts the {value,label}
// pairs the filters hold: the label round-trips back to its value on pick.
// `allLabel` is the clear-to-everything row; pass null where there's no "all"
// state (Fixed Cost, the unbilled toggle).
function FeedSelect({ value, onChange, options, allLabel = "All", className = "w-[170px]" }) {
  const labels = useMemo(
    () => (allLabel !== null ? [allLabel, ...options.map(o => o.label)] : options.map(o => o.label)),
    [options, allLabel]
  );
  // Empty value = the "all" row. An unknown value (a filter whose option list
  // hasn't loaded yet) shows the placeholder rather than a stale label.
  const current = !value
    ? (allLabel ?? "")
    : (options.find(o => o.value === value)?.label ?? "");

  return (
    <StrictSelect
      className={className}
      value={current}
      options={labels}
      placeholder={allLabel ?? "Select…"}
      limit={200}
      onChange={(label) => {
        if (allLabel !== null && label === allLabel) return onChange("");
        onChange(options.find(o => o.label === label)?.value ?? "");
      }}
    />
  );
}

// Header names the importer accepts, per field. The first alias in each list
// is what the feed's own export writes (COLS labels joined), so a file exported
// from this screen re-imports unchanged; the rest are the spellings a
// hand-built spreadsheet tends to use.
const IMPORT_HEADERS = {
  job_number:          ["Job #", "Job Number", "Job No"],
  date:                ["Date"],
  client:              ["Client"],
  office:              ["Off.", "Office"],
  print_digital:       ["P/D", "Print/Digital", "Print Digital"],
  film_title:          ["Film", "Film Title"],
  job_category:        ["Job Cat.", "Job Category", "Job Work Category"],
  project_description: ["Project Description"],
  category:            ["Item Category", "Category"],
  client_amends:       ["CA", "Client Amends"],
  is_3d:               ["3D"],
  costs:               ["Costs", "Fixed Cost"],
  ordered_by:          ["Ordered By"],
  billed_to:           ["Billed To"],
  worked_on:           ["Worked On By", "Worked On", "Staff"],
  time_spent:          ["Time", "Time Spent"],
  additional_time:     ["Extra", "Extra Time", "Additional Time"],
};
// Rate, OT and Total are exported but never imported — they're derived from
// positions and the row's own hours, so reading them back in would let a stale
// file overwrite a live calculation.
const IMPORT_IGNORED = ["Rate", "Hourly Rate", "OT", "Over Time", "Total"];

// Standard rate for anyone without one of their own on their profile.
const DEFAULT_HOURLY_RATE = 150;
const fmtMoney = (n) => (n == null || isNaN(n) ? "—" : `$${Number(n).toFixed(2)}`);

// A task's job number and film both live inside the composed job label
// ("Forgotten Island : XY025164, INT - Titles"), which is authoritative — the
// task's own film_title column can lag a rename. Shared by the filters, the
// cells and the export so all three agree on what a row's film is.
const feedJobNo = (e) => {
  const s = e.job_number || "";
  // Everything between the film separator (when there is one) and the
  // description — a label can be "Film : XY1, Desc", "XY1, Desc" or bare "XY1".
  const colon = s.indexOf(" : ");
  const after = colon < 0 ? s : s.slice(colon + 3);
  const comma = after.indexOf(",");
  return (comma > 0 ? after.slice(0, comma) : after).trim();
};
const feedFilm = (e) => {
  const colon = (e.job_number || "").indexOf(" : ");
  return colon > 0 ? e.job_number.slice(0, colon).trim() : (e.film_title || "");
};
// The description as it actually reads on the folder — the tail of the job
// label, after the code. The task's own project_description column is a copy
// taken when the time was logged and goes stale when a job is renamed, so the
// label wins and the column is only a fallback.
const feedDesc = (e) => {
  const s = e.job_number || "";
  const comma = s.indexOf(",", s.indexOf(" : ") + 1);
  const fromLabel = comma > 0 ? s.slice(comma + 1).trim() : "";
  return fromLabel || e.project_description || e._job?.project_description || "";
};

// Decimal hours from a stored duration — the shared parser, so this agrees
// with what the grid displays and with what the Tracker/Legacy pages compute.
// It used to read a bare integer as MINUTES, which mattered here more than
// anywhere: this feeds the rate × hours money column, so a "2" (two hours,
// which is what the 0.25-step dropdown writes) was billed as 0.03 hours.
const hoursOf = parseTimeToHours;

// CSV import for the feed. Pick a file → it's parsed in the browser and sent
// to the Worker for a dry run → the plan comes back and is shown in full →
// only then does confirming write anything. Nothing is inserted from the
// browser directly: `tasks` is per-user RLS'd, so a team-wide import has to go
// through the service-role endpoint.
function ImportModal({ onClose, onImported }) {
  const [fileName, setFileName] = useState("");
  const [parseError, setParseError] = useState(null);
  const [unmatchedHeaders, setUnmatchedHeaders] = useState([]);
  const [rows, setRows] = useState(null);
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState(null);
  const [done, setDone] = useState(null);

  const post = async (payload) => {
    const res = await fetch("/api/jobs-feed/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        body.error === "not_connected" ? "Wrike session expired — reconnect in Profile → Settings."
        : body.error === "too_many_rows" ? `That file has more rows than the ${body.max}-row limit.`
        : body.detail || body.error || `Import failed (${res.status})`
      );
    }
    return body;
  };

  const handleFile = async (file) => {
    if (!file) return;
    setFileName(file.name);
    setParseError(null); setPlan(null); setRows(null); setApplyError(null);
    try {
      const grid = parseCsv(await file.text());
      const { rows: mapped, unmatched } = mapCsvRows(grid, IMPORT_HEADERS);
      if (!mapped.length) throw new Error("No data rows under the header.");
      // Rate/OT/Total are expected to be there and expected to be ignored —
      // listing them as unrecognised would read as a problem.
      const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      const ignored = new Set(IMPORT_IGNORED.map(norm));
      setUnmatchedHeaders(unmatched.filter((h) => !ignored.has(norm(h))));
      setRows(mapped);
      setBusy(true);
      setPlan((await post({ rows: mapped, dryRun: true })).plan);
    } catch (e) {
      setParseError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!rows || busy) return;
    setBusy(true); setApplyError(null);
    try {
      const res = await post({ rows, dryRun: false });
      setDone(res.plan);
      onImported?.();
    } catch (e) {
      setApplyError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const Stat = ({ n, label, tone = "" }) => (
    <div className="flex-1 min-w-[110px] px-3 py-2.5 rounded-xl border border-[#dce4ec] bg-white">
      <p className={`text-lg font-black leading-none ${tone || "text-[#122027]"}`}>{n}</p>
      <p className="text-[10px] font-bold uppercase tracking-wider text-[#768994] mt-1">{label}</p>
    </div>
  );

  return (
    <WrikeApplyShell title="Import into Project/Time"
      subtitle="A CSV shaped like this screen's own export" accent="#1cc1a5" onClose={onClose}>
      <div className="px-6 py-5 overflow-y-auto flex-1 space-y-4">
        {done ? (
          <div className="py-4 space-y-3 text-center">
            <CheckCircle2 className="w-10 h-10 text-[#1cc1a5] mx-auto" />
            <p className="text-sm font-bold text-[#122027]">
              Imported {done.inserted} row{done.inserted === 1 ? "" : "s"}.
            </p>
            <p className="text-xs text-[#768994]">
              {done.jobsToCreate.length ? `${done.jobsToCreate.length} job${done.jobsToCreate.length === 1 ? "" : "s"} created · ` : ""}
              {done.jobsToUpdate.length ? `${done.jobsToUpdate.length} updated · ` : ""}
              {done.duplicates ? `${done.duplicates} duplicate${done.duplicates === 1 ? "" : "s"} skipped · ` : ""}
              {done.errors.length ? `${done.errors.length} skipped` : "no errors"}.
            </p>
          </div>
        ) : (
          <>
            <div>
              <label className="flex items-center gap-3 px-4 py-3 border-2 border-dashed border-[#dce4ec] hover:border-[#1cc1a5] rounded-2xl cursor-pointer transition-colors">
                <UploadCloud className="w-4 h-4 text-[#768994] shrink-0" />
                <span className="text-sm font-bold text-[#122027]">
                  {fileName || "Choose a CSV file…"}
                </span>
                <input type="file" accept=".csv,text/csv" className="hidden"
                  onChange={(e) => handleFile(e.target.files?.[0])} />
              </label>
              <p className="text-[11px] text-[#768994] mt-2 leading-snug">
                Same columns as Export to Excel. Client Amends and 3D take <b>Y</b>/<b>N</b>.
                Rate, OT and Total are ignored — they're worked out from the position rates.
              </p>
            </div>

            {busy && !plan && (
              <p className="flex items-center gap-2 text-sm text-[#768994]">
                <Loader2 className="w-4 h-4 animate-spin" /> Checking the file…
              </p>
            )}

            {parseError && (
              <p className="flex items-start gap-2 text-sm text-rose-600">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {parseError}
              </p>
            )}

            {unmatchedHeaders.length > 0 && (
              <div className="px-3 py-2 bg-[#f4b740]/10 border border-[#f4b740]/30 rounded-xl">
                <p className="text-[11px] font-bold text-[#8a6d1a]">
                  Columns not recognised (ignored): {unmatchedHeaders.join(", ")}
                </p>
              </div>
            )}

            {plan && (
              <div className="space-y-3">
                <div className="flex gap-2 flex-wrap">
                  <Stat n={plan.toInsert} label="To import" tone="text-[#1cc1a5]" />
                  <Stat n={plan.duplicates} label="Duplicates skipped" />
                  <Stat n={plan.errors.length} label="Rows skipped" tone={plan.errors.length ? "text-rose-500" : ""} />
                  <Stat n={plan.jobsToCreate.length} label="Jobs created" />
                  <Stat n={plan.jobsToUpdate.length} label="Jobs updated" />
                </div>

                {plan.unknownStaff.length > 0 && (
                  <div className="px-3 py-2 bg-[#f4b740]/10 border border-[#f4b740]/30 rounded-xl">
                    <p className="text-[11px] font-bold text-[#8a6d1a] mb-1">
                      No profile matches these names — their rows import with nobody attached,
                      so they'll show "—" under Worked On By and bill at the default rate:
                    </p>
                    <p className="text-[11px] text-[#8a6d1a]">{plan.unknownStaff.join(", ")}</p>
                  </div>
                )}

                {plan.jobsToCreate.length > 0 && (
                  <div className="px-3 py-2 bg-[#12a0e1]/5 border border-[#12a0e1]/20 rounded-xl">
                    <p className="text-[11px] font-bold text-[#0d8bc4] mb-1">
                      New Job Book entries will be created for:
                    </p>
                    <p className="text-[11px] text-[#0d8bc4] font-mono break-words">
                      {plan.jobsToCreate.slice(0, 25).join(", ")}
                      {plan.jobsToCreate.length > 25 ? ` … +${plan.jobsToCreate.length - 25} more` : ""}
                    </p>
                  </div>
                )}

                {plan.jobsToUpdate.length > 0 && (
                  <div className="px-3 py-2 bg-[#f4b740]/10 border border-[#f4b740]/30 rounded-xl">
                    <p className="text-[11px] font-bold text-[#8a6d1a] mb-1">
                      These existing jobs will have Office / P-D / Job Cat. / Costs / Ordered By /
                      Billed To <b>overwritten</b> from the file:
                    </p>
                    <p className="text-[11px] text-[#8a6d1a] font-mono break-words">
                      {plan.jobsToUpdate.slice(0, 25).join(", ")}
                      {plan.jobsToUpdate.length > 25 ? ` … +${plan.jobsToUpdate.length - 25} more` : ""}
                    </p>
                  </div>
                )}

                {plan.errors.length > 0 && (
                  <div className="border border-[#dce4ec] rounded-xl overflow-hidden">
                    <p className="px-3 py-2 text-[11px] font-bold text-[#122027] bg-slate-50 border-b border-[#dce4ec]">
                      Skipped rows
                    </p>
                    <div className="max-h-40 overflow-y-auto divide-y divide-[#f0f4f8]">
                      {plan.errors.slice(0, 100).map((e) => (
                        <p key={e.line} className="px-3 py-1.5 text-[11px] text-[#768994]">
                          <span className="font-mono font-bold text-[#122027]">Line {e.line}</span> — {e.reason}
                        </p>
                      ))}
                    </div>
                  </div>
                )}

                {applyError && (
                  <p className="flex items-start gap-2 text-sm text-rose-600">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {applyError}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="px-6 py-4 border-t border-[#dce4ec] flex items-center justify-end gap-2 shrink-0">
        <button onClick={onClose}
          className="px-5 py-2.5 text-sm font-bold text-[#768994] hover:text-[#122027] bg-white border border-[#dce4ec] rounded-xl transition-[color] ease-[cubic-bezier(0.16,1,0.3,1)]">
          {done ? "Close" : "Cancel"}
        </button>
        {!done && (
          <button onClick={apply} disabled={busy || !plan || plan.toInsert === 0}
            className="flex items-center gap-2 px-6 py-2.5 bg-[#1cc1a5] hover:bg-[#17a98f] text-white text-sm font-bold rounded-xl transition-[background-color] ease-[cubic-bezier(0.16,1,0.3,1)] disabled:opacity-40">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            Import {plan?.toInsert || 0} row{plan?.toInsert === 1 ? "" : "s"}
          </button>
        )}
      </div>
    </WrikeApplyShell>
  );
}

export function JobsFeedSection() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  // Period — a week range, defaulting to the current week at both ends.
  const [weekFrom, setWeekFrom] = useState("");
  const [weekTo, setWeekTo] = useState("");
  // The rest of the filter bar. "" means "all" for every one of these; the
  // legacy screen's unbilled-hours / billing-times / submitted-only controls
  // have no equivalent data in TimeHub (tasks carries no billed or submitted
  // flag), so they're deliberately absent rather than shown inert.
  const [jobNoFilter, setJobNoFilter] = useState("");
  const [clientFilter, setClientFilter] = useState("");
  const [deptFilter, setDeptFilter] = useState("");
  const [filmFilter, setFilmFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [staffFilter, setStaffFilter] = useState("");
  const [officeFilter, setOfficeFilter] = useState("");
  const [fixedCostFilter, setFixedCostFilter] = useState("Both"); // Both | Yes | No
  const [showImport, setShowImport] = useState(false);
  // Matches the report this replaces, which defaults to leaving unbilled time
  // (waiting time and anything else zero-rated) out of the totals.
  const [includeUnbilled, setIncludeUnbilled] = useState(false);

  // Filter dropdowns read the reference tables, not just the values that
  // happen to appear in the loaded rows — a client with no logged time yet is
  // still a client you'd want to filter to (and see the empty result).
  const [refLists, setRefLists] = useState({ clients: [], films: [], departments: [], categories: [] });
  useEffect(() => {
    Promise.all([
      supabase.from("clients").select("name").order("name"),
      supabase.from("films").select("title").order("title"),
      supabase.from("job_departments").select("name").order("name"),
      supabase.from("job_categories").select("name").order("name"),
    ]).then(([c, f, d, cat]) => setRefLists({
      clients: (c.data || []).map(x => x.name),
      films: (f.data || []).map(x => x.title),
      departments: (d.data || []).map(x => x.name),
      categories: (cat.data || []).map(x => x.name),
    }));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    // Read through the Worker's service-role endpoint, not supabase directly:
    // the tasks table has a per-user RLS policy, so a browser query would only
    // return the caller's own rows. This management feed must show everyone's.
    //
    // "date" is a text column with mixed historical formats (dd/mm/yyyy and
    // ISO), so filtering it at the DB level is unreliable (lexicographic string
    // compare). Fetch everything and filter by month client-side after
    // normalising to ISO.
    let allTasks = [];
    try {
      const res = await fetch("/api/jobs-feed");
      if (res.ok) allTasks = await res.json();
      else console.error("[JobsFeed] /api/jobs-feed failed", res.status);
    } catch (e) {
      console.error("[JobsFeed] /api/jobs-feed error", e);
    }

    const toIso = (d) => {
      if (!d) return null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
      const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
    };

    // Everything is filtered client-side below — the endpoint returns the whole
    // table either way, so narrowing here would only mean refetching on every
    // filter change.
    const tasks = [...(allTasks || [])];

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

    // `select("*")` for positions and job_categories on purpose: naming the
    // rate columns would make the whole read fail (and blank out every name in
    // the table) on a deploy that lands before the rates migration does.
    const [{ data: profiles }, { data: jobs }, { data: positions }, { data: cats }] = await Promise.all([
      userIds.length
        ? supabase.from("profiles").select("wrike_user_id, first_name, last_name, department, position_id").in("wrike_user_id", userIds)
        : Promise.resolve({ data: [] }),
      jobNums.length
        ? selectAll("jobs", "job_number, office, print_digital, job_work_category, ordered_by, billed_to, fixed_cost",
                    (q) => q.in("job_number", jobNums)).then((data) => ({ data }))
        : Promise.resolve({ data: [] }),
      supabase.from("positions").select("*"),
      supabase.from("job_categories").select("*"),
    ]);

    const profileMap = Object.fromEntries((profiles || []).map(p => [p.wrike_user_id, p]));
    const jobMap = Object.fromEntries((jobs || []).map(j => [j.job_number, j]));
    const rateByPosition = Object.fromEntries(
      (positions || []).map(p => [p.id, p.hourly_rate != null ? Number(p.hourly_rate) : DEFAULT_HOURLY_RATE])
    );
    const catMap = Object.fromEntries((cats || []).map(c => [c.name, c]));

    setEntries(tasks.map(t => {
      const p = profileMap[t.wrike_user_id];
      const cat = catMap[t.category];
      // Rate follows the work, not the worker: a category that bills at
      // another position's rate (a designer proofreading bills the Proofreader
      // rate) wins over the logger's own position. Unbilled categories are
      // zero-rated outright.
      const unbilled = !!cat?.unbilled;
      const positionId = cat?.rate_position_id || p?.position_id;
      return {
        ...t,
        _iso: toIso(t.date),
        _name: p ? cleanFullName(p.first_name, p.last_name) : "—",
        _dept: p?.department || "",
        _unbilled: unbilled,
        _rate: unbilled ? 0 : (rateByPosition[positionId] ?? DEFAULT_HOURLY_RATE),
        _job: jobMap[t.job_number] || {},
      };
    }));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Every week from the current one back, newest first — the option set shared
  // by both period pickers.
  const weekOptions = useMemo(() => {
    const start = mondayOf(new Date());
    return Array.from({ length: WEEKS_BACK }, (_, i) => {
      const m = new Date(start);
      m.setDate(m.getDate() - i * 7);
      const end = new Date(m);
      end.setDate(end.getDate() + 6);
      return {
        key: isoDate(m),
        start: isoDate(m),
        end: isoDate(end),
        label: `${m.toLocaleDateString("en-GB", { month: "long", year: "numeric" })} (Week:${isoWeekNo(m)})`,
      };
    });
  }, []);

  // Default both ends to the current week once the options exist.
  useEffect(() => {
    if (!weekOptions.length) return;
    setWeekFrom(f => f || weekOptions[0].key);
    setWeekTo(t => t || weekOptions[0].key);
  }, [weekOptions]);

  // The picked range, normalised — picking an "until" week earlier than the
  // "view" week reads as a range either way rather than showing nothing.
  const range = useMemo(() => {
    const a = weekOptions.find(w => w.key === weekFrom);
    const b = weekOptions.find(w => w.key === weekTo);
    if (!a || !b) return null;
    return a.start <= b.start ? { from: a.start, to: b.end } : { from: b.start, to: a.end };
  }, [weekOptions, weekFrom, weekTo]);

  // Values present in the feed, for the two dropdowns with no reference table
  // of their own (Staff and Office).
  const optionsFor = useCallback((pick) => {
    const seen = new Set();
    entries.forEach(e => { const v = pick(e); if (v) seen.add(v); });
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [entries]);

  const staffOptions = useMemo(() => optionsFor(e => (e._name === "—" ? "" : e._name)), [optionsFor]);
  const officeOptions = useMemo(() => optionsFor(e => e._job?.office), [optionsFor]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const jobQ = jobNoFilter.trim().toLowerCase();
    return entries.filter(e => {
      // Rows with an unparseable date can't be placed in a week, so a week
      // range excludes them rather than silently dragging them along.
      if (range && !(e._iso && e._iso >= range.from && e._iso <= range.to)) return false;
      if (!includeUnbilled && e._unbilled) return false;
      if (jobQ && !feedJobNo(e).toLowerCase().includes(jobQ)) return false;
      if (clientFilter && e.client !== clientFilter) return false;
      if (deptFilter && e._dept !== deptFilter) return false;
      if (filmFilter && feedFilm(e) !== filmFilter) return false;
      if (categoryFilter && e.category !== categoryFilter) return false;
      if (staffFilter && e._name !== staffFilter) return false;
      if (officeFilter && (e._job?.office || "") !== officeFilter) return false;
      if (fixedCostFilter !== "Both") {
        const hasFixed = e._job?.fixed_cost != null && Number(e._job.fixed_cost) > 0;
        if (fixedCostFilter === "Yes" ? !hasFixed : hasFixed) return false;
      }
      if (q && !(
        (e.job_number || "").toLowerCase().includes(q) ||
        (e.client || "").toLowerCase().includes(q) ||
        (e.film_title || "").toLowerCase().includes(q) ||
        (e._name || "").toLowerCase().includes(q) ||
        (e.project_description || "").toLowerCase().includes(q)
      )) return false;
      return true;
    });
  }, [entries, search, range, includeUnbilled, jobNoFilter, clientFilter, deptFilter,
      filmFilter, categoryFilter, staffFilter, officeFilter, fixedCostFilter]);

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
  // Any stored shape → "H:MM", via the shared parser/formatter so this column
  // can't disagree with the same row on the Legacy or Tracker pages.
  const fmtNum = (n) => secondsToHM(parseTimeToSeconds(n), "—");

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

  const { widths, resizeHandle } = useColumnResize("mgmt-jobsfeed-cols", COLS);

  const getCellValue = (e, key) => {
    const j = e._job || {};
    switch (key) {
      case "job_number":          return feedJobNo(e) || "—";
      case "date":                return fmtDate(e.date);
      case "client":              return e.client || "—";
      case "office":              return j.office || "—";
      case "print_digital":       return j.print_digital || "—";
      case "film_title":          return feedFilm(e) || "—";
      case "job_category":        return j.job_work_category || "—";
      case "project_description": return feedDesc(e) || "—";
      case "category":            return e.category || "—";
      case "client_amends":       return e.client_amends ? <Check className="w-3.5 h-3.5 text-emerald-500 mx-auto" /> : "";
      case "is_3d":               return e.is_3d ? <Check className="w-3.5 h-3.5 text-emerald-500 mx-auto" /> : "";
      case "costs":               return j.fixed_cost != null ? `£${parseFloat(j.fixed_cost).toFixed(2)}` : "—";
      case "ordered_by":          return j.ordered_by || "—";
      case "billed_to":           return j.billed_to || "—";
      case "worked_on":           return e._name;
      case "hourly_rate":         return fmtMoney(e._rate);
      case "time_spent":          return fmtNum(e.time_spent);
      case "extra_time":          return fmtNum(e.additional_time);
      // No over-time column on tasks — nothing to read, so it's a constant
      // rather than a number that looks derived.
      case "over_time":           return "0.00";
      // Rate × every hour on the row (logged + additional). The rows this
      // replaces only ever carried logged time, so the two agree there.
      case "total": {
        const hrs = hoursOf(e.time_spent) + hoursOf(e.additional_time);
        return hrs > 0 ? fmtMoney(e._rate * hrs) : "—";
      }
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
  // Exports whatever the filter bar is currently showing, not the full
  // unfiltered table.
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
    const scope = range ? `${range.from}_to_${range.to}` : "All";
    a.download = `ProjectTime_${scope}_${new Date().toISOString().split("T")[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Filter bar. Two rows, mirroring the report this replaces: the period
          on top, then the narrowing filters. Client / Dept / Film / Categories
          list their whole reference table, so a client with no logged time is
          still selectable (and honestly returns nothing); Staff and Office have
          no table of their own and list what's in the feed. "(All …)" clears. */}
      <div className="rounded-2xl border border-[#dce4ec] bg-[#fbfdff] px-4 py-3 flex flex-col gap-2.5">
        <div className="flex items-center gap-2 flex-wrap text-sm text-[#33454f]">
          <span className="font-bold text-[#122027]">View Week</span>
          <FeedSelect value={weekFrom} onChange={setWeekFrom} className="w-[215px]" allLabel={null}
            options={weekOptions.map(w => ({ value: w.key, label: w.label }))} />
          <span className="font-bold text-[#122027]">Until</span>
          <FeedSelect value={weekTo} onChange={setWeekTo} className="w-[215px]" allLabel={null}
            options={weekOptions.map(w => ({ value: w.key, label: w.label }))} />
          <span className="text-[#768994]">and</span>
          <FeedSelect value={includeUnbilled ? "Do" : "Do Not"} onChange={v => setIncludeUnbilled(v === "Do")}
            allLabel={null} className="w-[110px]"
            options={[{ value: "Do Not", label: "Do Not" }, { value: "Do", label: "Do" }]} />
          <span className="text-[#768994]">include unbilled hours.</span>
          <span className="text-[#768994]">Office is</span>
          <FeedSelect value={officeFilter} onChange={setOfficeFilter} allLabel="All Offices" className="w-[150px]"
            options={officeOptions.map(o => ({ value: o, label: o }))} />
        </div>

        <div className="flex items-center gap-2 flex-wrap text-sm text-[#33454f]">
          <label className="flex items-center gap-1.5">
            <span className="text-[#768994]">Job No:</span>
            <input value={jobNoFilter} onChange={e => setJobNoFilter(e.target.value)}
              placeholder="(All Jobs)"
              className="w-[120px] border border-[#dce4ec] rounded-xl px-3 py-2.5 text-sm font-bold text-[#122027] outline-none focus:border-[#12a0e1] hover:border-[#12a0e1] bg-white placeholder-[#b0bec5] placeholder:font-medium transition-colors" />
          </label>
          <span className="text-[#768994]">Client:</span>
          <FeedSelect value={clientFilter} onChange={setClientFilter} allLabel="(All Clients)" className="w-[200px]"
            options={refLists.clients.map(o => ({ value: o, label: o }))} />
          <span className="text-[#768994]">Dept:</span>
          <FeedSelect value={deptFilter} onChange={setDeptFilter} allLabel="(All Departments)" className="w-[185px]"
            options={refLists.departments.map(o => ({ value: o, label: o }))} />
          <span className="text-[#768994]">Film:</span>
          <FeedSelect value={filmFilter} onChange={setFilmFilter} allLabel="(All Films)" className="w-[200px]"
            options={refLists.films.map(o => ({ value: o, label: o }))} />
          <span className="text-[#768994]">Categories:</span>
          <FeedSelect value={categoryFilter} onChange={setCategoryFilter} allLabel="All Categories" className="w-[200px]"
            options={refLists.categories.map(o => ({ value: o, label: o }))} />
          <span className="text-[#768994]">Staff:</span>
          <FeedSelect value={staffFilter} onChange={setStaffFilter} allLabel="All Staff" className="w-[170px]"
            options={staffOptions.map(o => ({ value: o, label: o }))} />
          <span className="text-[#768994]">Fixed Cost:</span>
          <FeedSelect value={fixedCostFilter} onChange={setFixedCostFilter} allLabel={null} className="w-[100px]"
            options={[{ value: "Both", label: "Both" }, { value: "Yes", label: "Yes" }, { value: "No", label: "No" }]} />
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#b0bec5]" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search job, client, film, person…"
            className="w-full pl-9 pr-3 py-2 border border-[#dce4ec] rounded-xl text-sm text-[#122027] outline-none focus:border-[#1cc1a5] bg-white"
          />
        </div>
        <div className="flex items-center gap-3 ml-auto">
          <span className="text-xs font-bold text-[#768994]">
            {loading ? "Loading…" : `${filtered.length} entr${filtered.length === 1 ? "y" : "ies"}`}
          </span>
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-white border border-[#dce4ec] hover:border-[#1cc1a5] text-[#122027] text-xs font-bold rounded-xl transition-[border-color] ease-[cubic-bezier(0.16,1,0.3,1)]"
          >
            <UploadCloud className="w-3.5 h-3.5" />
            Import CSV
          </button>
          <button
            onClick={exportToExcel}
            disabled={loading || filtered.length === 0}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-white border border-[#dce4ec] hover:border-slate-300 text-[#122027] text-xs font-bold rounded-xl transition-[border-color] ease-[cubic-bezier(0.16,1,0.3,1)] disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            Export to Excel
          </button>
        </div>
      </div>

      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onImported={load}
        />
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-[#dce4ec] shadow-sm">
        <table className="border-collapse text-[11px] w-full" style={{ tableLayout: "fixed", minWidth: `${COLS.reduce((s, c) => s + widths[c.key], 0)}px` }}>
          <colgroup>
            {COLS.map(c => <col key={c.key} style={{ width: widths[c.key] }} />)}
          </colgroup>
          <thead>
            <tr>
              {COLS.map(c => (
                <th
                  key={c.key}
                  className="relative px-2 py-2.5 text-center font-black uppercase tracking-widest text-[9px] text-white bg-[#0d1b22] border-r border-white/5 last:border-r-0 whitespace-nowrap overflow-hidden"
                >
                  {Array.isArray(c.label) ? c.label.map((l, i) => <span key={i} className="block leading-tight">{l}</span>) : c.label}
                  {resizeHandle(c.key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={COLS.length} className="px-4 py-8 text-center text-[#768994]">Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={COLS.length} className="px-4 py-8 text-center text-[#768994]">No entries for this period</td></tr>
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
                      className={`px-2 py-1.5 border-r border-[#f0f4f8] last:border-r-0 overflow-hidden ${isCheck ? "text-center" : ""} ${isMono ? "font-mono text-[10px]" : ""} ${noWrap ? "whitespace-nowrap" : ""} text-[#122027]`}
                    >
                      <span className={`block leading-snug ${noWrap ? "truncate" : ""} ${c.key === "job_number" ? "font-black text-[#1cc1a5]" : "font-medium"}`}>
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
      {/* Card gap tightens while a group is open, for the same reason its
          siblings condense: every pixel above the open group pushes its
          children further down the page. */}
      <div className={`flex flex-col ${expandedGroup ? "gap-2.5" : "gap-4"}`}>
        {NAV_GROUPS.map((group) => {
          const isOpen = expandedGroup === group.id;
          // A group with exactly one destination has nothing to unfold —
          // an accordion revealing a single row you then click again is
          // pure friction. Go straight there, and read as navigation (no
          // `open` prop) rather than as an expand/collapse toggle.
          const singleItem = group.items.length === 1;
          // Once any group is open, every other top-level row shrinks and
          // drops its description. Supporting Content alone has seven
          // children, and at full height the siblings above/below it pushed
          // those off the bottom of the viewport — the html{zoom:1.1} in
          // tailwind.css makes the effective viewport ~10% shorter again, so
          // there was less room than a 1080p screen suggests.
          const isCondensed = !!expandedGroup && !isOpen;
          return (
            <div key={group.id} className="bg-white rounded-3xl border border-[#dce4ec] shadow-sm overflow-hidden">
              <HubRow
                section={group}
                onClick={() => (singleItem ? onOpenItem(group.items[0].id) : onToggleGroup(group.id))}
                open={singleItem ? undefined : isOpen}
                condensed={isCondensed}
                first
              />
              <div className={`grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}>
                <div className="overflow-hidden min-h-0">
                  <div className="bg-slate-50 border-t border-[#dce4ec]">
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
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

    </div>
  );
}

// ── People section ──────────────────────────────────────────────────────────
// Hourly rate cell. Local while focused so the field stays typeable, written
// back on blur (or Enter). Blank clears to the standard rate rather than to
// null, which would read as "free" in the feed's Total.
function RateInput({ value, onCommit }) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const shown = editing ? draft : (value == null ? String(DEFAULT_HOURLY_RATE) : String(Number(value)));
  // Presentation only, derived from the prop that already drives `shown`: a
  // position with no rate of its own bills at the studio default, and until now
  // looked identical to one deliberately set to that same number. Dashed and
  // muted reads as "inherited", solid as "set here".
  const isDefault = value == null;

  const commit = () => {
    setEditing(false);
    const n = parseFloat(draft);
    const next = isNaN(n) || n < 0 ? DEFAULT_HOURLY_RATE : n;
    if (next !== Number(value)) onCommit(next);
  };

  return (
    <div className="relative">
      <span className={`absolute left-3 top-1/2 -translate-y-1/2 text-xs font-bold select-none pointer-events-none transition-colors ${
        isDefault ? "text-[#cbd5e1]" : "text-[#b0bec5]"
      }`}>$</span>
      <input
        type="number" min="0" step="0.01"
        value={shown}
        onFocus={() => { setDraft(value == null ? String(DEFAULT_HOURLY_RATE) : String(Number(value))); setEditing(true); }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        title={isDefault ? `No rate set — bills at the studio default of $${DEFAULT_HOURLY_RATE}/hr` : "Hourly rate"}
        className={`w-full pl-7 pr-2 py-2 rounded-xl border bg-white outline-none
                    font-display text-[15px] font-bold tabular-nums tracking-tight
                    transition-colors focus:border-[#12a0e1] ${
          isDefault ? "border-dashed border-[#dce4ec] text-[#9aa8b4]" : "border-[#dce4ec] text-[#122027]"
        }`}
      />
    </div>
  );
}

// ── Positions & Rates ────────────────────────────────────────────────────────
// One page, because a position and what it bills at are one thought. They used
// to be two: adding "Retoucher" on the Positions page then walking to the Rates
// page to say what it costs, with the same list of names rendered on both.
// The rate now sits on the position's own row.
//
// Item Category Overrides stay underneath rather than on a page of their own —
// they answer the same question ("what does this hour cost?") for the cases
// where the answer isn't the logger's position: some work bills at another
// position's rate (a designer proofreading bills the Proofreader rate) and
// some doesn't bill at all (waiting time).
function PositionsAndRatesSection() {
  return (
    <div className="space-y-10">
      <div>
        {/* No explainer paragraph here: this page is used by colleagues who
            already know how rates work. The dashed-vs-solid rate convention
            lives in RateInput's own tooltip instead of a standing legend. */}
        <SimpleListSection
          table="positions"
          labelField="title"
          label="Positions"
          placeholder="e.g. Creative Director…"
          renderRowExtra={(item, patchItem) => (
            <div className="w-32 shrink-0">
              <RateInput
                value={item.hourly_rate}
                onCommit={async (v) => {
                  patchItem(item.id, { hourly_rate: v });
                  await supabase.from("positions").update({ hourly_rate: v }).eq("id", item.id);
                }}
              />
            </div>
          )}
        />
      </div>
      <ItemCategoryOverrides />
    </div>
  );
}

function ItemCategoryOverrides() {
  const [positions, setPositions] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showAllCategories, setShowAllCategories] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [pos, cats] = await Promise.all([
      supabase.from("positions").select("*").order("title"),
      supabase.from("job_categories").select("*").order("name"),
    ]);
    setPositions(pos.data || []);
    setCategories(cats.data || []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const patchCategory = async (id, patch) => {
    setCategories(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c));
    await supabase.from("job_categories").update(patch).eq("id", id);
  };

  // Default to just the categories that actually override something — the rest
  // bill at the logger's own position and would be 60-odd rows of "same as
  // usual". Search or "Show all" reaches the whole list, since any of them can
  // be given an override.
  const visibleCategories = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q) return categories.filter(c => (c.name || "").toLowerCase().includes(q));
    if (showAllCategories) return categories;
    return categories.filter(c => c.rate_position_id || c.unbilled);
  }, [categories, search, showAllCategories]);

  const positionOptions = useMemo(
    () => positions.map(p => ({ value: String(p.id), label: p.title })),
    [positions]
  );

  if (loading) return <p className="text-sm font-bold text-[#768994] py-10 text-center">Loading…</p>;

  return (
    <div>
        <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
          <p className="text-[10px] font-black uppercase tracking-widest text-[#768994]">Item category overrides</p>
          <div className="flex items-center gap-2">
            <button type="button"
              onClick={() => { setShowAllCategories(s => !s); setSearch(""); }}
              className={`shrink-0 px-3.5 py-2.5 rounded-xl border text-xs font-bold transition-[background-color,border-color,color] ease-[cubic-bezier(0.16,1,0.3,1)] ${
                showAllCategories && !search.trim()
                  ? "bg-[#12a0e1]/10 border-[#12a0e1] text-[#12a0e1]"
                  : "bg-white border-[#dce4ec] text-[#768994] hover:border-slate-300"
              }`}>
              Show all {categories.length}
            </button>
            <div className="relative w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#b0bec5]" />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search item categories…"
                className="w-full pl-9 pr-3 py-2.5 border border-[#dce4ec] rounded-xl text-sm text-[#122027] placeholder-[#b0bec5] outline-none focus:border-[#1cc1a5] bg-white transition-colors" />
            </div>
          </div>
        </div>
        <p className="text-xs text-[#768994] mb-3">
          {search.trim() || showAllCategories
            ? "Every item category — set a position to give one its own rate, or mark it unbilled."
            : "Categories that don't bill at the logger's own position rate. Show all or search to add another."}
        </p>
        {visibleCategories.length === 0 ? (
          <p className="text-sm text-[#768994] bg-slate-50 border border-dashed border-[#dce4ec] rounded-2xl px-4 py-8 text-center">
            {search.trim() ? "No item category matches that." : "No overrides set."}
          </p>
        ) : (
          <div className="space-y-1.5">
            {visibleCategories.map(c => (
              <div key={c.id}
                className={`flex items-center gap-3 p-3.5 bg-white border rounded-2xl
                            transition-[transform,box-shadow,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]
                            hover:-translate-y-px hover:shadow-[0_6px_18px_-8px_rgba(18,32,39,0.18)] ${
                  c.unbilled ? "border-[#f4b740]/40" : "border-[#dce4ec] hover:border-slate-300"
                }`}>
                <span className="flex-1 min-w-0 text-[15px] font-semibold text-[#122027] truncate">{c.name}</span>
                {/* The comment below has always said the select goes muted when
                    a category is unbilled, but nothing ever applied it — the
                    override sat at full strength next to the badge overriding
                    it. Now it actually dims. */}
                <FeedSelect
                  value={c.rate_position_id ? String(c.rate_position_id) : ""}
                  onChange={(v) => patchCategory(c.id, { rate_position_id: v ? Number(v) : null })}
                  allLabel="Logger's own position"
                  className={`w-[220px] shrink-0 transition-opacity duration-300 ${c.unbilled ? "opacity-40" : ""}`}
                  options={positionOptions}
                />
                {/* Unbilled wins over any rate override, so the select goes
                    muted rather than pretending it still applies. */}
                <button type="button"
                  onClick={() => patchCategory(c.id, { unbilled: !c.unbilled })}
                  className={`shrink-0 px-3 py-2.5 rounded-xl border text-xs font-bold transition-[background-color,border-color,color] ease-[cubic-bezier(0.16,1,0.3,1)] ${
                    c.unbilled
                      ? "bg-[#f4b740]/10 border-[#f4b740] text-[#8a6d1a]"
                      : "bg-white border-[#dce4ec] text-[#768994] hover:border-slate-300"
                  }`}>
                  Unbilled
                </button>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

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
      <div className="flex items-stretch bg-white border border-[#dce4ec] rounded-2xl overflow-hidden
                      hover:border-slate-300 hover:-translate-y-px hover:shadow-[0_8px_22px_-10px_rgba(18,32,39,0.22)]
                      transition-[transform,box-shadow,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]">
        {/* Flush to the card's own edges (top/bottom/left), full height —
            clipped to the card's rounded-2xl by the parent's overflow-hidden
            rather than rounding the image itself, so it reads as one card
            with a portrait on the left, not a small avatar floating in
            padding. */}
        {p.avatar_url ? (
          <img src={p.avatar_url} alt={fullName} className="w-28 sm:w-32 shrink-0 object-cover" />
        ) : (
          <div className="w-28 sm:w-32 shrink-0 bg-gradient-to-br from-[#12a0e1] to-[#1cc1a5] text-white flex items-center justify-center font-display font-bold text-2xl tracking-tight">
            {initials}
          </div>
        )}
        <div className="flex-1 min-w-0 flex items-center gap-3 p-3.5">
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
                <span className="font-display text-[17px] font-bold text-[#122027] tracking-tight truncate">{fullName}</span>
                <Pencil className="w-3 h-3 shrink-0 text-slate-300 opacity-0 group-hover/name:opacity-100 transition-opacity" />
              </button>
            )}
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
                      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                      onAnimationComplete={() => setSettled(prev => ({ ...prev, [group.label]: true }))}
                      style={{ overflow: settled[group.label] ? "visible" : "hidden" }}
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
  animate: { x: 0, opacity: 1, transition: { duration: 0.22, ease: [0.16, 1, 0.3, 1] } },
  exit: (dir) => ({ x: dir > 0 ? -28 : 28, opacity: 0, transition: { duration: 0.16, ease: [0.16, 1, 0.3, 1] } }),
};

// A film's bulk campaign, opened straight from the Films list instead of going
// to Bulk Campaign and re-picking studio + film.
//
// It renders the real JobsSetupSection with its pickers locked, rather than a
// read-only imitation: activate, push, re-tag and the session review all work
// exactly as they do on the Bulk Campaign page, because they ARE that page. A
// separate view would have been a second implementation to keep in step, and
// would have drifted the first time either side changed. (Defined here rather
// than in its own file purely because importing JobsSetupSection from outside
// Management would form an import cycle.)
//
// The only thing this adds is resolving the film's studio, which the films
// table doesn't store — a film project's parent folder in Wrike IS its studio.
function FilmCampaignModal({ filmTitle, onClose }) {
  const [studio, setStudio] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        if (!localStorage.getItem("wrike_user_id")) {
          throw new Error("Wrike isn't connected — connect it in Profile → Settings first.");
        }
        const byId = await fetchAllFolders();
        const loc = findFilmLocation(byId, filmTitle);
        if (!loc) throw new Error(`No “${filmTitle}” project found in Wrike. It may not have been created there yet.`);
        if (!loc.studio) throw new Error(`Found “${filmTitle}” in Wrike, but it isn't inside a studio folder — can't tell which template applies.`);
        if (!alive) return;
        setStudio(loc.studio);
      } catch (e) {
        if (alive) setError(e.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [filmTitle]);

  return (
    <div
      className="fixed inset-0 z-[9999] bg-[#122027]/60 backdrop-blur-sm flex items-start justify-center p-4 sm:p-8 overflow-y-auto"
      onMouseDown={onClose}
    >
      <div
        className="bg-white rounded-3xl shadow-2xl w-full max-w-6xl my-4 flex flex-col overflow-hidden border border-[#dce4ec]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-5 pb-4 border-b border-[#dce4ec] flex items-start justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <p className="text-[9px] font-black uppercase tracking-widest text-[#12a0e1] mb-0.5">
              Bulk campaign · live from Wrike
            </p>
            <h2 className="text-xl font-black text-[#122027] truncate flex items-center gap-2">
              <Film className="w-4 h-4 text-[#768994] shrink-0" />
              {filmTitle}
            </h2>
            {studio && <p className="text-xs text-[#768994] mt-0.5">{studio}</p>}
          </div>
          <button onClick={onClose}
            className="p-2 hover:bg-slate-100 rounded-xl text-slate-400 hover:text-slate-600 transition-colors shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-5">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[#768994]">
              <Loader2 className="w-4 h-4 animate-spin" /> Finding “{filmTitle}” in Wrike…
            </div>
          ) : error ? (
            <div className="py-12 text-center">
              <p className="text-sm font-bold text-red-500">{error}</p>
            </div>
          ) : (
            <JobsSetupSection initialStudio={studio} initialFilm={filmTitle} lockPickers />
          )}
        </div>
      </div>
    </div>
  );
}

export default function Management({ wrikeUserId, department, wrikeData = [] }) {
  // expandedGroup is purely a display toggle — which group's items are
  // unfolded inline on the hub, an accordion, not a navigation state.
  // activeTab is the real navigation: null means "still on the hub"
  // (accordion open or not), a value means "showing that item's content".
  const [expandedGroup, setExpandedGroup] = useState(null);
  // Seeded from the hash so a refresh or a shared link opens straight onto the
  // section instead of dropping you back on the hub.
  const [activeTab, setActiveTab] = useState(sectionFromHash);
  // Film whose bulk campaign is open in a modal (from the Films tab).
  const [campaignFilm, setCampaignFilm] = useState(null);
  // Tracks which way the content panel should slide: forward opening an
  // item, backward returning to the hub.
  const [navDirection, setNavDirection] = useState(1);

  const toggleGroup = (id) => setExpandedGroup((g) => (g === id ? null : id));

  // The open item lives in the hash's second segment (`#management/films`), so
  // it's a history entry of its own: back leaves an item for the hub instead of
  // leaving Administration altogether, and a section can be linked to. App.jsx
  // reads only the first segment, so it stays on "management" throughout.
  const setSectionHash = (id, replace) => {
    const hash = id ? `#management/${id}` : "#management";
    if (window.location.hash === hash) return;
    if (replace) window.history.replaceState({}, "", hash);
    else window.history.pushState({}, "", hash);
  };

  const openItem = (id) => { setNavDirection(1); setActiveTab(id); setSectionHash(id); };
  // The accordion stays exactly as it was — going back doesn't collapse
  // the group you were just looking at.
  const backToHub = () => { setNavDirection(-1); setActiveTab(null); setSectionHash(null); };
  // Same, but guarantees the group is open on arrival. Identical to backToHub
  // when you drilled in through the accordion; the difference shows on a deep
  // link (sessionStorage openAdminSection), where no group was ever expanded.
  const backToGroup = (groupId) => { setNavDirection(-1); setExpandedGroup(groupId); setActiveTab(null); setSectionHash(null); };

  // Back/forward between sections. The browser has already changed the hash by
  // the time this fires, so it only mirrors — never writes history back.
  useEffect(() => {
    const onHashChange = () => {
      const next = sectionFromHash();
      setNavDirection(next ? 1 : -1);
      setActiveTab(next);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Escape goes up one level — an open item back to the hub, the same as the
  // breadcrumb (so it pushes history and Forward returns).
  //
  // It defers to anything with a stronger claim on the key. Modals, the command
  // palette and StrictSelect's click-catcher are all high-z layers that cover
  // the viewport, and while one is up Escape belongs to it, not to navigation —
  // closing a half-filled import or job form by unmounting the whole section
  // would throw away typed input. Likewise a focused field, where Escape means
  // "cancel this edit".
  //
  // Both halves of the test matter. z alone isn't enough: QuickActions' bubble
  // is a permanent fixed z-[100], so height alone would mean Escape never
  // fired. Coverage alone isn't enough either, since the page itself is
  // full-height. An overlay is both.
  useEffect(() => {
    if (!activeTab) return;
    const overlayOnScreen = () => {
      for (const el of document.querySelectorAll('[class*="z-["]')) {
        const z = /z-\[(\d+)\]/.exec(el.getAttribute("class") || "");
        if (!z || Number(z[1]) < 50) continue;
        const r = el.getBoundingClientRect();
        if (r.width >= window.innerWidth * 0.8 && r.height >= window.innerHeight * 0.8) return true;
      }
      return false;
    };
    const onKeyDown = (e) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target;
      if (t?.isContentEditable) return;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(t?.tagName)) return;
      if (overlayOnScreen()) return;
      backToHub();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // One-shot deep link: another page (e.g. Jobs Setup's "Manage films") can stash
  // a section id before switching to #management, and we open it straight away.
  useEffect(() => {
    let target = null;
    try { target = sessionStorage.getItem("openAdminSection"); sessionStorage.removeItem("openAdminSection"); } catch { /* ignore */ }
    // replace, not push: the entry the caller created by setting #management is
    // the one that should carry the section, otherwise Back lands on an empty
    // Administration hub the user never actually visited.
    if (target) { setNavDirection(1); setActiveTab(target); setSectionHash(target, true); }
  }, []);

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

      <div className="max-w-[1800px] mx-auto px-4 sm:px-6 pt-6 pb-6">
        {/* Breadcrumb bar. This is page chrome, not panel content, so it sits
            outside the sliding panel — and it has to sit outside the
            overflow-hidden that clipping the slide requires, because
            position:sticky does nothing inside a clipped ancestor. Being
            sticky is the point: Films and Studio Analytics are both long
            enough that the way back used to scroll off the top, leaving no
            exit without scrolling all the way up again.
            The negative margins let the blurred background bleed to the
            content column's edges while the padding keeps the crumbs aligned
            with the panel below. */}
        {nav && (
          <div className="sticky top-0 z-30 -mx-4 sm:-mx-6 mb-4 px-4 sm:px-6 py-3
                          bg-slate-100/85 supports-[backdrop-filter]:bg-slate-100/70 backdrop-blur-md
                          border-b border-[#dce4ec]">
            <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
              <button
                onClick={backToHub}
                className="flex items-center gap-1.5 text-xs font-bold text-[#768994] hover:text-[#122027] bg-white border border-[#dce4ec] hover:border-slate-300 rounded-xl px-3 py-2 shadow-sm transition-[border-color,color] ease-[cubic-bezier(0.16,1,0.3,1)] shrink-0"
              >
                <ChevronLeft className="w-4 h-4" /> Administration
              </button>
              {/* The group crumb goes back to the hub with that group open —
                  which is where you came from, except on a deep link, where
                  nothing was expanded yet. */}
              <ChevronRight className="w-3.5 h-3.5 text-[#b0bec5] shrink-0 hidden sm:block" />
              <button
                onClick={() => backToGroup(nav.group.id)}
                className="hidden sm:block text-xs font-bold text-[#768994] hover:text-[#122027] transition-colors shrink-0 truncate"
              >
                {nav.group.label}
              </button>
              <ChevronRight className="w-3.5 h-3.5 text-[#b0bec5] shrink-0 hidden sm:block" />
              <div className={`w-8 h-8 rounded-xl bg-gradient-to-br ${nav.group.gradient} flex items-center justify-center text-white shadow-sm shrink-0`}>
                <nav.item.icon className="w-4 h-4" />
              </div>
              <h2 className="font-display text-lg sm:text-xl font-bold text-[#122027] tracking-tight truncate">{nav.item.label}</h2>
            </div>
          </div>
        )}

        {/* The hub (with its accordion) and an open item's content are the
            only two panels that ever swap — the accordion itself doesn't
            trigger this, it's a height animation inside the hub panel.
            overflow-hidden clips the 28px travel so nothing peeks past the
            edge mid-transition. */}
        <div className="overflow-hidden">
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

            {/* The item's actual content. Its heading and the way back now
                live in the sticky breadcrumb above, outside this panel. */}
            {nav && (
              <div>
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
                  {activeTab === "films"      && <SimpleListSection table="films" labelField="title" label="Films" placeholder="Film title…" wrikeFilmSync onItemClick={setCampaignFilm} />}
                  {activeTab === "clients"    && <SimpleListSection table="clients" labelField="name" label="Clients" quickFilters={STUDIO_GROUPS} quickFilterLabel="Filter by studio" />}
                  {activeTab === "categories" && <SimpleListSection table="job_categories" labelField="name" label="Item Categories" groups={CATEGORY_GROUPS} />}
                  {/* Territory-prefixed like project descriptions, so it reuses
                      their group chips rather than the Digital/Print ones. */}
                  {activeTab === "work-categories" && <SimpleListSection table="job_work_categories" labelField="name" label="Job Work Categories" placeholder="e.g. AUS - Publicity…" groups={DESCRIPTION_GROUPS} />}
                  {activeTab === "descs"      && <SimpleListSection table="project_descriptions" labelField="description" label="Project Type Descriptions" isLong quickFilters={DESC_QUICK_FILTERS} quickFilterLabel="Filter by territory" groups={DESCRIPTION_GROUPS} />}
                  {activeTab === "rates"      && <PositionsAndRatesSection />}
                  {activeTab === "translations" && <TranslationCountriesSection />}
                  {activeTab === "departments"  && <SimpleListSection table="job_departments" labelField="name" label="Departments" placeholder="e.g. Print…" />}
                  {activeTab === "orgchart"     && <OrgChart />}
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
        </div>
      </div>

      {campaignFilm && (
        <FilmCampaignModal filmTitle={campaignFilm} onClose={() => setCampaignFilm(null)} />
      )}
    </div>
  );
}
