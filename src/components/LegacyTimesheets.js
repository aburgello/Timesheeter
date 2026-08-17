import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useCallback,
} from "react";
import { useLegacyRows, getCurrentWeekStart, hmToHours } from "../hooks/useLegacyRows";
import { useColumnResize } from "../lib/useColumnResize";
import { layoutRect, layoutViewport } from "../utils/zoom";
import { useJobLookup } from "../hooks/useJobLookup";
import {
  supabase,
  setWrikeUserId as stampWrikeUserId,
  fetchExistingTimelogIds,
  whenIdentityReady,
  selectAll,
} from "../lib/supabaseClient";
import { subscribeToWrikeTaskEvents } from "../lib/wrikeWebhookSubscription";
import { fetchTasksByIds } from "../hooks/useWrikeCache";
import {
  RefreshCw,
  XCircle,
  FileSpreadsheet,
  ChevronDown,
  Tag,
  Search,
  Check,
  ChevronRight,
  CheckCircle,
  Lock,
  LayoutList,
  X,
  AlertCircle,
  Copy,
  Plus,
  Layers,
  Calendar,
  Database,
} from "lucide-react";
import {
  TERRITORIES,
  CATEGORIES,
  TERRITORY_FLAGS,
  FILM_MAPPINGS,
  normalizeName,
} from "../constants.js";
import { resolveJobNumber } from "../utils/wrikeHelpers";
import { resolveCountries } from "../utils/countryCodes";
import { getFolderCountries, getFolderFamily, buildChildToParents, jobFolderDescription } from "../lib/wrikeEnrich";
import { fetchFolderDictionary } from "../hooks/useMotionBoardTasks";
import { countryFieldIds, warmCountryFields } from "../lib/countryField";
import { secondsToHM } from "../utils/timeHelpers";
import { COLUMNS, DAYS, TIME_OPTIONS, getDarkTagStyle } from "./legacy/legacyConstants";
import PageHeader, { pageHeaderActionClass } from "./shared/PageHeader";
import TableSearchableSelect from "./legacy/TableSearchableSelect";
import MultiCountrySelect from "./shared/MultiCountrySelect";
import { toIsoDate } from "../utils/dates";
import {
  splitTerritories,
  joinTerritories,
  territoryFlags,
  territoryKey,
  territoryCode,
  toTimesheetTerritories,
} from "../utils/territories";
import { useTimesheetPrefs } from "../hooks/useTimesheetPrefs";
import { mergeMultiCountryRows } from "../utils/mergeMultiCountry";
import { defaultCategoryForTask, categoryFamilyForTask } from "../utils/categoryFamily";
import PullDefaultsPopover from "./legacy/PullDefaultsPopover";

// A grid textarea that grows to fit its text instead of hiding it.
//
// The description and notes cells were rows={2} with overflow-hidden, so a
// three-line entry — "INTL DIGITAL Outdoor Campaign Markets" is exactly three —
// lost its last line silently: no scrollbar, no ellipsis, and no way to read the
// rest short of clicking in and arrowing down.
//
// Height comes off scrollHeight, reset to auto first so deleting text shrinks it
// back. Keyed to `value` rather than to typing, so it also follows text that
// arrives from a Wrike pull or the job lookup's autofill. Because `rows` still
// sets the natural height, scrollHeight can't fall below two lines, and cells
// with short descriptions stay the height they are today.
//
// Module level, not nested in LegacyTimesheet: a component redefined on every
// render is a new type each time, which would remount these on every keystroke
// and take the caret with it.
function AutoGrowTextarea({ value, ...rest }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    // Add the borders back. scrollHeight covers content + padding but not
    // border, while Tailwind's preflight puts these on border-box — so
    // assigning scrollHeight straight across leaves the content box short by
    // the border and still clips the last line's descenders. Measured: 2px on
    // these cells, which is precisely the sort of "nearly right" that put a
    // line of text out of reach in the first place.
    const cs = getComputedStyle(el);
    const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    el.style.height = `${el.scrollHeight + border}px`;
  }, [value]);
  return <textarea ref={ref} value={value} {...rest} />;
}

// The category picker in the batch-edit bar. Its own compact list rather than
// TableSearchableSelect: that component's menu is built for a table cell and
// anchored to it, and this one has to open UPWARD out of a floating bar sitting
// at the foot of the table.
function BatchCategoryPicker({ onPick, pinned = [] }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) { setSearch(""); return; }
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filtered = search
    ? CATEGORIES.filter((c) => c.toLowerCase().includes(search.toLowerCase()))
    : CATEGORIES;

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-white/10 hover:bg-white/20 transition-colors"
      >
        <Tag className="w-3.5 h-3.5" />
        Set category
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 w-[300px]">
          <div className="w-full bg-white text-[#122027] border border-[#dce4ec] rounded-2xl shadow-xl overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-200">
            <div className="p-2.5 pb-2">
              <div className="flex items-center gap-2 bg-slate-50 border border-[#dce4ec] rounded-xl px-2.5 py-1.5">
                <Search className="w-3.5 h-3.5 text-[#768994] shrink-0" />
                <input
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search categories…"
                  className="w-full bg-transparent text-xs outline-none placeholder:text-[#768994]"
                />
              </div>
            </div>
            <div className="max-h-56 overflow-y-auto overscroll-contain px-2 pb-2">
              {/* Same shortlist as the row dropdown, and only while unfiltered
                  — once you are searching, a shortlist above the matches is
                  just a duplicate of some of them. */}
              {!search && pinned.length > 0 && (
                <>
                  <p className="px-2.5 pt-1 pb-1 text-[9px] font-black uppercase tracking-widest text-[#12a0e1]">
                    Most used
                  </p>
                  {pinned.map((c) => (
                    <button
                      key={`pinned-${c}`}
                      onClick={() => { onPick(c); setOpen(false); }}
                      className="w-full text-left px-2.5 py-1.5 rounded-lg text-[11px] font-bold hover:bg-slate-50 transition-colors truncate"
                    >
                      {c}
                    </button>
                  ))}
                  <div className="my-1 border-t border-slate-100" />
                </>
              )}
              {filtered.map((c) => (
                <button
                  key={c}
                  onClick={() => { onPick(c); setOpen(false); }}
                  className="w-full text-left px-2.5 py-1.5 rounded-lg text-[11px] hover:bg-slate-50 transition-colors truncate"
                >
                  {c}
                </button>
              ))}
              {filtered.length === 0 && (
                <p className="px-2.5 py-3 text-[11px] text-[#768994] text-center">
                  No category matches “{search}”.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function LegacyTimesheet({ wrikeData, isAdmin = false }) {
  // Drag-resizable column configs (persisted per table).
  const WRIKE_TS_COLS = [
    { key: "title",    label: "Assignment Title", px: 320 },
    { key: "status",   label: "Status",           px: 140 },
    { key: "category", label: "Category Link",    px: 240 },
    { key: "jobkey",   label: "Job Key",          px: 160 },
    { key: "due",      label: "Due Date",         px: 110 },
    { key: "location", label: "Location",         px: 160 },
    ...["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => ({ key: `day_${d}`, label: d, px: 64 })),
  ];
  const { widths: wtWidths, resizeHandle: wtHandle } = useColumnResize("legacy-wrike-ts-cols", WRIKE_TS_COLS);

  // Default widths mirror the previous per-cell w-[…] classes so the layout is
  // unchanged until the user drags.
  const CONSOL_PX = {
    "Job Number": 240, "Client": 140, "Film Title": 150, "Project Description": 220,
    "Country": 140, "Category": 180, "Client Amends": 72, "Notes": 140,
    "3D": 48, "Time Spent": 92, "Add. Time": 88,
  };
  // These four hold a checkbox or a short time dropdown, never prose. They're
  // pinned at the width they need — no drag grip, and any wider width saved in
  // storage is ignored — so squeezing only clips the control ("none" became
  // "n…") without buying the text columns much room.
  const CONSOL_FIXED = new Set(["Client Amends", "3D", "Time Spent", "Add. Time"]);
  const CONSOL_COLS = COLUMNS.map((c, i) => ({
    key: `c${i}`,
    label: c,
    px: CONSOL_PX[c] || 140,
    fixed: CONSOL_FIXED.has(c),
  }));
  // Job Number and Add. Time keep their width and stay pinned to the
  // edges; everything between them is squeezed to whatever the window leaves,
  // so a narrow laptop scales the table down instead of pushing the last
  // columns off the right where nobody finds them.
  const consolScrollRef = useRef(null);
  const { widths: consolWidths, resizeHandle: consolHandle } = useColumnResize(
    "legacy-consol-cols",
    CONSOL_COLS,
    { fitTo: consolScrollRef, keepFirst: true, keepLast: true }
  );
  const consolTotal = CONSOL_COLS.reduce((s, c) => s + consolWidths[c.key], 0);

  const [activeDay, setActiveDay] = useState(() => {
    return localStorage.getItem("xyi_legacy_activeDay") || "Monday";
  });

  // How this member wants pulled rows to arrive — their default category and
  // whether markets get merged into one entry. Stored on their profile, so
  // these follow them between machines; see hooks/useTimesheetPrefs.js.
  const { defaultCategory, groupMultiCountry, setPrefs } = useTimesheetPrefs();

  // useLegacyRows is initialised after showToast below

  const [frozenDays, setFrozenDays] = useState(() => {
    const saved = localStorage.getItem("xyi_legacy_frozenDays");
    return saved ? JSON.parse(saved) : {};
  });

  useEffect(() => {
    localStorage.setItem("xyi_legacy_activeDay", activeDay);
  }, [activeDay]);

  // rows are now synced to Supabase via useLegacyRows

  useEffect(() => {
    localStorage.setItem("xyi_legacy_frozenDays", JSON.stringify(frozenDays));
  }, [frozenDays]);

  // Auto-detect new week on mount. frozenDays is keyed by weekday name only
  // ("Monday", not "the Monday of week X"), so it has to be cleared whenever
  // the week rolls over — otherwise a day frozen last week (e.g. to lock a
  // submitted timesheet) stays frozen for every future occurrence of that
  // weekday, silently blocking pulls/edits for the new week too.
  useEffect(() => {
    const current = getCurrentWeekStart();
    const stored = localStorage.getItem("xyi_last_week_start");
    if (stored && stored !== current) {
      setNewWeekBanner(true);
      setFrozenDays({});
    }
    localStorage.setItem("xyi_last_week_start", current);
  }, []);

  const [isPulling, setIsPulling] = useState(false);
  const [newWeekBanner, setNewWeekBanner] = useState(false);
  const [showDebugPull, setShowDebugPull] = useState(false);
  const [debugDate, setDebugDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().split("T")[0];
  });
  // Debug Pull is granted per person on profiles.can_debug_pull, so a second
  // pair of hands can recover a missed day without also being handed the
  // Administration modal, the raw Wrike explorer and the Canvas scan — which is
  // everything else `isAdmin` opens. Read here rather than in App because this
  // button is the only thing it gates; there is nothing to lift.
  //
  // Starts false and can only turn on: a member who does not have it never sees
  // the control flicker in and out, and the one who does waits a tick for it.
  const [canDebugPull, setCanDebugPull] = useState(false);
  useEffect(() => {
    const uid = localStorage.getItem("wrike_user_id");
    if (!uid) return;
    let alive = true;
    (async () => {
      await whenIdentityReady();
      if (!alive) return;
      const { data } = await supabase
        .from("profiles")
        .select("can_debug_pull")
        .eq("wrike_user_id", uid)
        .maybeSingle();
      if (alive && data?.can_debug_pull) setCanDebugPull(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const [jsonCopied, setJsonCopied] = useState(false);

  const [wrikeFullName, setWrikeFullName] = useState("");
  const [wrikeUserId, setWrikeUserId] = useState("");

  const [localWrikeTasks, setLocalWrikeTasks] = useState([]);
  const [isSyncingJobs, setIsSyncingJobs] = useState(false);
  const activeWrikeData =
    localWrikeTasks.length > 0 ? localWrikeTasks : wrikeData;

  const [activeDropdown, setActiveDropdown] = useState(null);

  // --- Toast ---
  const [toast, setToast] = useState({
    show: false,
    message: "",
    type: "error",
  });
  const showToast = (message, type = "error") =>
    setToast({ show: true, message, type });

  // Initialised here so showToast is available to pass in
  const {
    rows,
    setRows,
    loading: rowsLoading,
    addRow,
    addRows,
    updateRow,
    deleteRow,
    weekStart,
    justSaved,
  } = useLegacyRows(showToast, wrikeUserId);

  // Job Book lookup — lets guessed job/film/client be overridden by admin-curated
  // data, and self-populates Job Book from real usage the first time a job is seen.
  const jobLookup = useJobLookup();
  useEffect(() => {
    if (!toast.show) return;
    const t = setTimeout(
      () => setToast({ show: false, message: "", type: "error" }),
      4000
    );
    return () => clearTimeout(t);
  }, [toast.show]);

  // Today's real calendar day name (for modal column locking)
  const todayDayName = React.useMemo(() => {
    const d = new Date().getDay();
    return DAYS[d === 0 ? 6 : d - 1];
  }, []);

  // --- Dynamic week date range ---
  const weekDateRange = React.useMemo(() => {
    const now = new Date();
    const day = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const fmt = (d) =>
      d.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
    return `${fmt(monday)} – ${fmt(sunday)}`;
  }, []);

  // --- Per-day hour totals ---
  const getDayTotal = (day) =>
    rows
      .filter((r) => r.dayOfWeek === day)
      .reduce((sum, r) => {
        // hmToHours (not parseFloat) — timeSpent may be "H:MM" (Wrike pulls,
        // unrounded) or a decimal string (manual TIME_OPTIONS picks)
        const t =
          r.timeSpent === "none" || !r.timeSpent ? 0 : hmToHours(r.timeSpent);
        const a =
          r.additionalTime === "none" || !r.additionalTime
            ? 0
            : hmToHours(r.additionalTime);
        return sum + t + a;
      }, 0);

  // Formats a decimal-hours total as "H:MM" — decimal hours (e.g. "4.17h" for
  // 4h10m) read like hundredths to a human, so display the same H:MM shape
  // used everywhere else in the app instead.
  // "0:00" rather than "none" for an empty day — this is a running total, not
  // a row's value.
  const formatDayTotal = (hours) => secondsToHM(hours * 3600, "0:00");

  // --- Add blank row ---
  const handleAddRow = () => {
    if (frozenDays[activeDay]) return;
    addRow({
      id: Date.now() + Math.floor(Math.random() * 1000),
      taskId: null,
      dayOfWeek: activeDay,
      jobNumber: "",
      client: "",
      filmTitle: "",
      projectDescription: "",
      territory: "",
      category: "",
      clientAmends: false,
      notes: "",
      is3D: false,
      timeSpent: "none",
      additionalTime: "none",
    });
  };

  // Add one new entry (row) into a job group while consolidated — inherits the
  // group's job/client/film, leaves territory/category/time blank to fill in.
  // This is what lets you add times without leaving consolidated view.
  const addEntryToGroup = (g, extra = {}) => {
    if (frozenDays[activeDay]) return;
    addRow({
      id: Date.now() + Math.floor(Math.random() * 1000),
      taskId: null,
      dayOfWeek: activeDay,
      jobNumber: g.jobNumber || "",
      client: g.client || "",
      filmTitle: g.filmTitle || "",
      projectDescription: g.projectDescription || "",
      territory: "",
      category: "",
      clientAmends: false,
      notes: "",
      is3D: false,
      timeSpent: "none",
      additionalTime: "none",
      ...extra,
    });
    setCollapsedGroups((prev) => ({ ...prev, [g.jobNumber]: false })); // ensure visible
  };

  // Multi-country: ONE entry covering every country picked, so the time is
  // logged once for the work rather than duplicated per market. The company
  // timesheet site takes several countries on a single row, so this exports
  // straight across — see handleCopyJSON.
  const addMultiCountryEntry = (g, countries, extra = {}) => {
    if (frozenDays[activeDay] || !countries?.length) return;
    addEntryToGroup(g, { territory: joinTerritories(countries), ...extra });
    setAddEntryFor(null);
  };

  const [isWrikeModalOpen, setIsWrikeModalOpen] = useState(false);
  const [modalTab, setModalTab] = useState("timesheet");
  const [showReminderModal, setShowReminderModal] = useState(false);
  const [wrikeTimesheetData, setWrikeTimesheetData] = useState({});
  const [wrikeWeeklyLogs, setWrikeWeeklyLogs] = useState([]);
  const [expandedGroups, setExpandedGroups] = useState({});
  const [isFetchingModalData, setIsFetchingModalData] = useState(false);

  useEffect(() => {
    if (!wrikeFullName) {
      fetch("/api/wrike/contacts?me=true")
        .then((res) => res.json())
        .then((json) => {
          if (json.data && json.data.length > 0) {
            const user = json.data[0];
            setWrikeFullName(
              `${user.firstName || ""} ${user.lastName || ""}`.trim()
            );
            setWrikeUserId(user.id);
            stampWrikeUserId(user.id);
          }
        })
        .catch(() => console.error("Failed to fetch user name"));
    }
  }, [wrikeFullName]);

  useEffect(() => {
    if (wrikeUserId && localWrikeTasks.length === 0) {
      handleSyncMyJobs(true);
    }
  }, [wrikeUserId]);

  // Extracted out of handleSyncMyJobs's map() so the webhook patch effect
  // below can produce an identically-shaped task from a single incoming id,
  // not just from a full batch sync. parseWrikeDescription is defined further
  // down this component — safe to reference here since this callback only
  // ever runs later (on sync or on a webhook event), by which point the
  // whole component body (and parseWrikeDescription's const binding) has
  // already executed for this render.
  // Parent tasks for any subtasks in a batch, keyed by id.
  //
  // A subtask is where both of the deliberate country rules go quiet: Wrike
  // gives it no folder membership of its own (parentIds is the PARENT's
  // business), and production writes the market code on the parent — the task
  // people actually record time against — not on every subtask beneath it. So
  // a subtask of "ODY_CN_EmperorCinema", sitting in a folder called
  // "China 🇨🇳", could see neither the name nor the folder and fell through to
  // whatever its custom fields happened to say.
  //
  // The Tracker gets this for free by inverting subTaskIds across its cache of
  // the whole workspace (see enrichTasks). Legacy can't: it only ever holds
  // MY tasks, and the parent of my subtask is often somebody else's, so it
  // simply isn't in the batch to invert. Asking for the parents by id is the
  // reliable way round — one batched call, only when subtasks are present,
  // deduped and coalesced by fetchTasksByIds.
  const fetchParentTasks = useCallback(async (tasks) => {
    const have = new Map(tasks.map((t) => [t.id, t]));
    const missing = [
      ...new Set(tasks.flatMap((t) => t.superTaskIds || [])),
    ].filter((id) => !have.has(id));

    if (missing.length) {
      try {
        for (const p of await fetchTasksByIds(missing)) have.set(p.id, p);
      } catch {
        /* parents unavailable → subtasks fall back to their custom fields */
      }
    }
    return have;
  }, []);

  const enrichLegacyTask = useCallback(
    (task, statusDict, parentById) => {
      const parent = (task.superTaskIds || [])
        .map((id) => parentById?.get(id))
        .find(Boolean);
      const parsed = parseWrikeDescription(task.description);
      let projectName = task.title.split(/[_|-]/)[0].trim();
      if (parsed.extractedPathData) {
        const parts = parsed.extractedPathData.split("/");
        const digIdx = parts.findIndex((p) => p === "DIGITAL");
        if (digIdx > 0 && parts[digIdx - 1]) {
          projectName = decodeURIComponent(parts[digIdx - 1])
            .replace(/[_|-]/g, " ")
            .trim();
        }
      }
      return {
        ...task,
        extractedPathData: parsed.extractedPathData,
        notesText: parsed.notesText,
        projectName,
        // Rule 2: the code ending the parent task's name.
        parentTaskTitle: parent?.title || task.parentTaskTitle || "",
        // Rule 3, for subtasks: the folders the PARENT sits in, used only when
        // the task carries none of its own. Kept as its own field rather than
        // written over parentIds, which means one specific thing to Wrike and
        // is read elsewhere.
        superTaskParentIds: task.parentIds?.length ? [] : parent?.parentIds || [],
        customStatusName: task.customStatusId
          ? statusDict[task.customStatusId] || task.status
          : task.status,
        assignees: wrikeFullName.split(" ")[0],
        dueDate: task.dates && task.dates.due ? task.dates.due : null,
        createdDate: task.createdDate,
      };
    },
    [wrikeFullName]
  );

  // Last-built status-id → name map, reused by the webhook patch below so an
  // incoming single-task event doesn't need to refetch /api/wrike/workflows.
  const statusDictRef = useRef({});

  // The folder tree, held for the life of the page. Localisation campaigns put
  // the market in a folder rather than in the task name — an hour on
  // "ODY_CN_EmperorCinema", which sits in a folder called "China 🇨🇳", is the
  // case — and only Generate Today's Timesheet ever fetched the tree to read
  // it. Pull Wrike Times and Sync My Jobs built their rows without it, so
  // those rows silently skipped the folder rule and fell through to whatever
  // the task's custom fields happened to say. It lives beside the resolver's
  // one funnel (guessFieldsFromTask) now, so no path can miss it again.
  //
  // fetchFolderDictionary reads the tree the last sync cached in Supabase and
  // only crawls Wrike when that copy is missing or sparse, so this costs one
  // select — cheap enough to warm on mount and await on click.
  const folderTreeRef = useRef({ folderDictionary: {}, childToParent: {} });
  const ensureFolderTree = useCallback(async (seed) => {
    if (seed && Object.keys(seed).length) {
      folderTreeRef.current = {
        folderDictionary: seed,
        childToParent: buildChildToParents(seed),
      };
      return;
    }
    if (Object.keys(folderTreeRef.current.folderDictionary).length) return;
    try {
      const { folderDictionary } = await fetchFolderDictionary();
      folderTreeRef.current = {
        folderDictionary,
        childToParent: buildChildToParents(folderDictionary),
      };
    } catch {
      /* no dictionary → countries fall back to the task name / custom field */
    }
  }, []);

  // Both warmed on mount so rows built off a webhook patch — which arrives
  // without anyone clicking anything — resolve their countries in full.
  useEffect(() => {
    ensureFolderTree();
    warmCountryFields();
  }, [ensureFolderTree]);

  // Near-instant updates: a webhook event only carries a changed task's id,
  // so batches of ids (debounced, see wrikeWebhookSubscription.js) get
  // refetched and merged into localWrikeTasks here — cheap, one small
  // request per edit rather than the bulk two-query sync "Sync My Jobs" does.
  useEffect(() => {
    if (!wrikeUserId) return;
    // Share fetchTasksByIds with the other webhook subscribers rather than
    // issuing a bespoke request: it collapses all of them onto one fetch per
    // changed task, and it degrades fields per-task on Wrike's field-visibility
    // 400s (which this handler used to just swallow, silently dropping the
    // edit). Its field set is a superset of what enrichLegacyTask reads.
    const handleWebhookTaskIds = async (ids) => {
      if (!ids.length) return;
      const changed = await fetchTasksByIds(ids);
      if (!changed.length) return;

      // Same parent lookup the bulk sync does, so a task edited into existence
      // by a webhook resolves its country the same way one pulled by hand does.
      const parentById = await fetchParentTasks(changed);

      setLocalWrikeTasks((prev) => {
        const map = new Map(prev.map((t) => [t.id, t]));
        changed.forEach((t) => {
          if (t.responsibleIds?.includes(wrikeUserId)) {
            map.set(t.id, enrichLegacyTask(t, statusDictRef.current, parentById));
          } else {
            map.delete(t.id); // reassigned away from me
          }
        });
        return [...map.values()];
      });
    };

    return subscribeToWrikeTaskEvents(handleWebhookTaskIds);
  }, [wrikeUserId, enrichLegacyTask, fetchParentTasks]);

  const handleSyncMyJobs = async (silent = false) => {
    if (!wrikeUserId) {
      if (!silent)
        showToast(
          "Wrike not connected. Please connect it in Profile → Settings."
        );
      return null;
    }

    setIsSyncingJobs(true);
    try {
      await Promise.all([ensureFolderTree(), warmCountryFields()]);

      const wfRes = await fetch("/api/wrike/workflows");
      const wfJson = await wfRes.json();
      const statusDict = {};
      if (wfJson.data) {
        wfJson.data.forEach((wf) => {
          if (wf.customStatuses) {
            wf.customStatuses.forEach((st) => {
              statusDict[st.id] = st.name;
            });
          }
        });
      }
      statusDictRef.current = statusDict;

      // superTaskIds is what tells us a task is a subtask at all — see
      // fetchParentTasks for why the parent has to be looked up rather than
      // inverted out of this batch.
      const fieldsFilter = encodeURIComponent(
        "[customFields,parentIds,superTaskIds,description]"
      );
      const responsiblesFilter = encodeURIComponent(`["${wrikeUserId}"]`);

      let rawTasks = [];
      let nextPageToken = null;
      let hasMore = true;

      // QUERY 1: Fetch ALL Active Tasks
      const activeStatusFilter = encodeURIComponent('["Active"]');
      while (hasMore) {
        let url = `/api/wrike/tasks?responsibles=${responsiblesFilter}&status=${activeStatusFilter}&fields=${fieldsFilter}&pageSize=1000`;
        if (nextPageToken) url += `&nextPageToken=${nextPageToken}`;

        const res = await fetch(url);
        if (!res.ok) throw new Error(`Wrike API Error: ${res.status}`);

        const json = await res.json();
        rawTasks = [...rawTasks, ...(json.data || [])];
        nextPageToken = json.nextPageToken;
        hasMore = !!nextPageToken;
      }

      // QUERY 2: Fetch Recently Completed Tasks
      const completedStatusFilter = encodeURIComponent('["Completed"]');
      const lookback = new Date();
      lookback.setDate(lookback.getDate() - 7);
      const formattedDate = lookback.toISOString().split(".")[0] + "Z";
      const dateFilter = encodeURIComponent(`{"start":"${formattedDate}"}`);

      nextPageToken = null;
      hasMore = true;
      while (hasMore) {
        let url = `/api/wrike/tasks?responsibles=${responsiblesFilter}&status=${completedStatusFilter}&fields=${fieldsFilter}&updatedDate=${dateFilter}&pageSize=1000`;
        if (nextPageToken) url += `&nextPageToken=${nextPageToken}`;

        const res = await fetch(url);
        if (!res.ok) throw new Error(`Wrike API Error: ${res.status}`);

        const json = await res.json();
        const existingIds = new Set(rawTasks.map((t) => t.id));
        const newCompleted = (json.data || []).filter(
          (t) => !existingIds.has(t.id)
        );

        rawTasks = [...rawTasks, ...newCompleted];
        nextPageToken = json.nextPageToken;
        hasMore = !!nextPageToken;
      }

      const parentById = await fetchParentTasks(rawTasks);
      const enrichedTasks = rawTasks.map((task) =>
        enrichLegacyTask(task, statusDict, parentById)
      );

      setLocalWrikeTasks(enrichedTasks);
      return enrichedTasks;
    } catch (err) {
      console.error(err);
      if (!silent)
        showToast(
          "Failed to sync your personal jobs. See console for details."
        );
      return null;
    } finally {
      setIsSyncingJobs(false);
    }
  };

  // Every job number the Job Book holds, matched against instead of the old
  // hardcoded DEFAULT_JOBS constant.
  //
  // That constant held 343 strings against the book's 949, and — worse — its
  // descriptions had drifted from the Wrike folder names the scan derives the
  // book's from. resolveJobNumber compared a task's folder suffix against those
  // stale descriptions, decided the suffix added information, and spliced it
  // into the code position. Matching against the book instead means the
  // description came from the same folder as the suffix, so there is nothing to
  // add and the registered string is returned intact.
  //
  // Empty until the book loads; resolveJobNumber then returns the bare code,
  // which the Job Book override a few lines down resolves anyway.
  const bookJobNumbers = jobLookup?.jobNumbers || [];

  const guessFieldsFromTask = (linkedTask) => {
    if (!linkedTask)
      return { jobNumber: "", territory: "", category: "", notes: "" };

    const searchTarget = `${linkedTask.title || ""} ${
      linkedTask.projectName || ""
    } ${linkedTask.extractedPathData || ""} ${
      linkedTask.notesText || ""
    }`.toUpperCase();

    // Countries come from the same resolver the Tracker uses — the code at the
    // end of the task name, else the parent's, else the market folder, else the
    // Country custom field. This path used to run its own copy of the old
    // free-text scan that never even looked at custom fields, so a Legacy-pulled
    // row and a Tracker-pulled row could disagree about the same task. One rule
    // now, in one place.
    //
    // The folder rule is resolved here for every caller. Tasks that arrive with
    // it already worked out (the Tracker's cache, which enriches against the
    // tree at sync time) keep theirs untouched.
    // A subtask has no folders of its own, so it climbs from its parent's —
    // resolved at fetch time into superTaskParentIds (see fetchParentTasks).
    const folderCountries = linkedTask.folderCountries?.length
      ? linkedTask.folderCountries
      : getFolderCountries(
          linkedTask.parentIds?.length
            ? linkedTask
            : { ...linkedTask, parentIds: linkedTask.superTaskParentIds || [] },
          folderTreeRef.current.folderDictionary,
          folderTreeRef.current.childToParent
        );
    const guessedTerritory = joinTerritories(
      resolveCountries(
        { ...linkedTask, folderCountries },
        linkedTask.parentTaskTitle || "",
        { countryFieldIds: countryFieldIds() }
      )
    );

    let guessedJob = "";
    let rawPrefix = "";

    if (linkedTask.customFields && linkedTask.customFields.length > 0) {
      const jobField = linkedTask.customFields.find(
        (cf) =>
          cf.value &&
          typeof cf.value === "string" &&
          cf.value.match(/(XY\d{5,6})/i)
      );
      if (jobField) {
        // Custom field value may carry a suffix beyond the base code — see
        // resolveJobNumber for what happens to it and why.
        const cfMatch = jobField.value.match(/(XY\d{5,6}(?:_[A-Za-z0-9]+)*)/i);
        const fullCode = cfMatch[1].toUpperCase();
        rawPrefix = fullCode.match(/XY\d{5,6}/i)[0];
        guessedJob = resolveJobNumber(fullCode, bookJobNumbers);
      }
    }

    if (!rawPrefix) {
      const xyMatch = searchTarget.match(/(XY\d{5,6}(?:_[A-Za-z0-9]+)*)/i);
      if (xyMatch) {
        const fullCode = xyMatch[1].toUpperCase();
        rawPrefix = fullCode.match(/XY\d{5,6}/i)[0];
        guessedJob = resolveJobNumber(fullCode, bookJobNumbers);
      } else {
        const rawSplit = linkedTask.title?.split(/[_|-]/)[0]?.trim();
        for (const job of bookJobNumbers) {
          const shortJob = job.split("-")[0].trim().toUpperCase();
          if (shortJob.length > 3 && searchTarget.includes(shortJob)) {
            guessedJob = job;
            rawPrefix = shortJob;
            break;
          }
        }
        if (!rawPrefix) rawPrefix = rawSplit || "";
      }
    }

    // Category, best evidence first.
    //
    // 1. The Wrike status, but ONLY when it is spelled exactly like one of the
    //    65 CATEGORIES. In practice that never happens — Wrike's statuses are
    //    workflow states ("Delivering", "Backlog", "Motion", "Active") and the
    //    categories are billing lines ("Print - Retouching") — so this is very
    //    nearly dead code. It stays because if a workflow IS ever named to
    //    match, that is a deliberate statement about the work and beats
    //    everything below it.
    //
    // 2. The member's own default — with its Print/Digital half decided by the
    //    job rather than fixed. A discipline is stable (Daisy proofreads);
    //    which family it belongs to is a property of the job, and the job says
    //    so itself because print and digital work sit in their own Wrike
    //    folders. So a "Print - Proofreading" default pulls a task from a
    //    DIGITAL folder as "Digital - Proofreading". Only ever swaps across a
    //    matched pair, never changes the discipline, and leaves the default
    //    alone when the path claims neither or both. See utils/categoryFamily.
    //
    // 3. The keyword rules, for members who have set no default. Unchanged
    //    behaviour, so nobody's pull changes until they opt in.
    // Which discipline the TREE says this is, resolved once for both branches
    // below. Same folders and same subtask fallback as the country climb above:
    // a subtask has no folder membership of its own, so it reads its parent's.
    const folderFamily = getFolderFamily(
      linkedTask.parentIds?.length
        ? linkedTask
        : { ...linkedTask, parentIds: linkedTask.superTaskParentIds || [] },
      folderTreeRef.current.folderDictionary,
      folderTreeRef.current.childToParent
    );

    let guessedCategory =
      linkedTask.customStatusName || linkedTask.status || "";
    if (!CATEGORIES.includes(guessedCategory)) {
      // The tree first, then the task's text — see categoryFamilyForTask. The
      // keyword branch used to ask `searchTarget.includes("PRINT")` directly,
      // which is the substring read that made "Sprint 1" a print job; it now
      // reads the same resolved answer the default branch does.
      const family = categoryFamilyForTask(folderFamily, searchTarget);
      if (defaultCategory)
        guessedCategory = defaultCategoryForTask(
          defaultCategory,
          searchTarget,
          folderFamily
        );
      else if (family === "Print")
        guessedCategory = "Print - Production/Localisation";
      else if (
        searchTarget.includes("REVISION") ||
        searchTarget.includes("AMEND")
      )
        guessedCategory = "Digital - Client Revisions/Amends";
      else guessedCategory = "Digital - Production/Localisation";
    }

    // What Wrike's own folder name says this job is. Empty when the task sits
    // under no folder carrying this code — a job folder that was never renamed,
    // or a tree we couldn't load — in which case everything below degrades to
    // what it did before.
    const folderDescription = jobFolderDescription(
      linkedTask,
      guessedJob,
      folderTreeRef.current.folderDictionary,
      folderTreeRef.current.childToParent
    );

    // Description, most authoritative first:
    //   1. the canonical job string's own comma part, when we matched one
    //   2. the job FOLDER's name in Wrike — what the job is
    //   3. the task's name with the code stripped — what this piece of work is
    // 3 is a genuinely worse answer than 2 and only survives as a fallback; it
    // must never reach the Job Book (see the callers' synthesis).
    let cleanDescription = "";
    if (guessedJob && guessedJob.includes(",")) {
      cleanDescription = guessedJob
        .substring(guessedJob.indexOf(",") + 1)
        .trim();
    } else if (folderDescription) {
      cleanDescription = folderDescription;
    } else if (rawPrefix) {
      const escapedPrefix = rawPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const prefixRegex = new RegExp(`^.*?${escapedPrefix}[,\\s:\\-]*`, "i");
      cleanDescription = (linkedTask.title || "").replace(prefixRegex, "").trim();
    }

    if (!cleanDescription) cleanDescription = linkedTask.title || "";

    return {
      jobNumber: guessedJob,
      territory: guessedTerritory,
      category: guessedCategory,
      notes: cleanDescription,
      // Kept separate from `notes` on purpose: callers may only build a Job
      // Book entry from a description Wrike's folder tree vouched for.
      folderDescription,
    };
  };

  const getLogHoursForTaskAndDay = (taskId, targetDay) => {
    const dayNames = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];
    let totalHours = 0;

    wrikeWeeklyLogs.forEach((log) => {
      if (log.taskId === taskId) {
        // Parse as a LOCAL date. A bare "2026-08-04" is parsed as UTC midnight,
        // so west of Greenwich getDay() lands on the previous weekday and the
        // hours show up in the wrong column.
        const dayKey = String(log.trackedDate || "").split("T")[0];
        const logDay = dayNames[new Date(`${dayKey}T00:00:00`).getDay()];
        if (logDay === targetDay) {
          totalHours += log.hours;
        }
      }
    });

    // Exact hours, not toFixed(1). The caller turns this into minutes, and
    // rounding to one decimal first meant every quarter-hour was reported
    // wrong: 0.25h became "0.3" and displayed as 18m, 2.75h as 2h 48m.
    return totalHours > 0 ? totalHours : null;
  };

  const getTaskSortValues = (t) => {
    const due = t.dueDate ? new Date(t.dueDate).getTime() : Infinity;
    const created = t.createdDate ? new Date(t.createdDate).getTime() : 0;
    return { due, created };
  };

  const handleOpenWrikeModal = async () => {
    if (!wrikeFullName || !wrikeUserId) {
      showToast("Still loading your Wrike profile — please wait a moment.");
      return;
    }

    setIsWrikeModalOpen(true);
    setModalTab("timesheet");
    setIsFetchingModalData(true);

    try {
      const now = new Date();

      const toLocalDateStr = (d) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
          2,
          "0"
        )}-${String(d.getDate()).padStart(2, "0")}`;
      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      const tomorrow = new Date(now);
      tomorrow.setDate(now.getDate() + 1);
      const todayStr = toLocalDateStr(now);
      const yesterdayStr = toLocalDateStr(yesterday);
      const tomorrowStr = toLocalDateStr(tomorrow);

      const fieldsFilter = encodeURIComponent(
        "[customFields,parentIds,superTaskIds,description]"
      );

      // --- STEP 1: Fetch this reporting week's timelogs ---
      // The modal draws a Mon–Sun grid, but this used to keep only today's and
      // yesterday's logs — so any hour tracked earlier in the week rendered as
      // "—" in its column, on a panel headed "CURRENT REPORTING WEEK". Keep the
      // whole week the grid actually shows.
      const weekStartStr = getCurrentWeekStart();          // Monday, local
      const weekEnd = new Date(`${weekStartStr}T00:00:00`);
      weekEnd.setDate(weekEnd.getDate() + 6);              // Sunday
      const weekEndStr = toLocalDateStr(weekEnd);

      const timelogRes = await fetch(`/api/wrike/contacts/${wrikeUserId}/timelogs`);
      const timelogJson = await timelogRes.json();
      const logs = (timelogJson.data || []).filter((l) => {
        const d = l.trackedDate?.split("T")[0];
        return d && d >= weekStartStr && d <= weekEndStr;  // ISO dates sort lexically
      });
      setWrikeWeeklyLogs(logs);

      // One cached lookup, used twice below:
      //  · folderDictionary — localisation campaigns carry the market in the
      //    folder tree, not the task name ("PP3 - CHI - DOOH - Batch 1 - POST"
      //    lives in a folder called "Chile" and ends in "POST"), and these
      //    tasks already come back with parentIds so the climb is free.
      //  · statusDictionary — resolves customStatusId to the workflow label
      //    ("Delivered"), which is what the status badge is meant to show.
      let folderDictionary = {}, statusDictionary = {}, childToParent = {};
      try {
        ({ folderDictionary, statusDictionary } = await fetchFolderDictionary());
        childToParent = buildChildToParents(folderDictionary);
        // Share it with guessFieldsFromTask rather than let it read the same
        // cached tree a second time.
        ensureFolderTree(folderDictionary);
      } catch {
        /* no dictionary → countries fall back to the task name / custom field */
      }

      // Every task with time against it ANYWHERE in the week, not just today.
      // This used to be today-only, which meant a task logged on Monday had its
      // hours in `logs` but no row in the grid to show them against — so the
      // week's earlier columns were permanently empty however much had been
      // tracked.
      const weekLoggedTaskIds = [...new Set(logs.map((l) => l.taskId).filter(Boolean))];

      // --- STEP 2: Fetch the week's logged tasks ---
      // Each task is fetched independently so one failure never blocks the
      // rest, and they go out together rather than one-at-a-time — serially
      // this was one round trip per task, which a full week makes slow enough
      // to notice.
      // Strategy per task:
      //   A) Try with fields= (gives custom fields, description, parentIds)
      //   B) If that 400s (e.g. unassigned tasks on some Wrike plans), retry bare
      //      — we still get title/status/dates, which is enough to show the row.
      const timelogRaw = (
        await Promise.all(
          weekLoggedTaskIds.map(async (taskId) => {
            try {
              let res = await fetch(`/api/wrike/tasks/${taskId}?fields=${fieldsFilter}`);
              if (!res.ok) res = await fetch(`/api/wrike/tasks/${taskId}`);
              if (!res.ok) {
                console.warn(`Could not fetch timelog task ${taskId}: ${res.status}`);
                return [];
              }
              const json = await res.json();
              return json.data || [];
            } catch (err) {
              console.warn(`Failed to fetch timelog task ${taskId}:`, err);
              return [];
            }
          })
        )
      ).flat();
      const timelogParentById = await fetchParentTasks(timelogRaw);
      const timelogTasks = timelogRaw.map((t) =>
        enrichWrikeTask(t, statusDictionary, timelogParentById)
      );

      // --- STEP 3: Fetch assigned tasks due today/tomorrow ---
      let assignedTasks = await handleSyncMyJobs(true);
      if (!assignedTasks) assignedTasks = activeWrikeData || [];

      // Matching used to be `assignees.includes(firstName)` for arrays and an
      // exact `=== firstName` for strings — but enrichTasks joins assignees
      // into a comma-separated list of FULL names, so the string branch never
      // matched anyone and the whole assigned-tasks step was silently empty for
      // most people. Compare emoji-stripped full names (normalizeName), which
      // is how the rest of the app identifies people.
      const meNormalized = normalizeName(wrikeFullName);
      const isAssignedToMe = (t) => {
        const raw = Array.isArray(t.assignees) ? t.assignees : String(t.assignees || "").split(",");
        return raw.some((n) => {
          const name = normalizeName(n);
          return name === meNormalized || name === normalizeName(wrikeFullName.split(" ")[0]);
        });
      };

      const assignedFiltered = assignedTasks.filter((t) => {
        if (!isAssignedToMe(t)) return false;

        const customStatus = (
          t.customStatusName ||
          t.status ||
          ""
        ).toLowerCase();
        const isDone =
          customStatus.includes("delivered") ||
          customStatus.includes("completed") ||
          customStatus === "cancelled";

        const dueStr = t.dueDate ? t.dueDate.split("T")[0] : null;

        if (isDone) return dueStr === todayStr || dueStr === tomorrowStr;
        if (t.status !== "Active") return false;
        if (dueStr) return dueStr >= yesterdayStr && dueStr <= tomorrowStr;

        const createdStr = t.createdDate ? t.createdDate.split("T")[0] : null;
        return createdStr === todayStr;
      });

      // --- STEP 4: Merge — timelog tasks take priority, assigned tasks fill the rest ---
      const timelogTaskIds = new Set(timelogTasks.map((t) => t.id));
      const mergedTasks = [
        ...timelogTasks,
        ...assignedFiltered.filter((t) => !timelogTaskIds.has(t.id)),
      ];

      const myTasks = mergedTasks;

      const grouped = {};
      const newExpanded = {};

      myTasks.forEach((task) => {
        task.folderCountries = getFolderCountries(task, folderDictionary, childToParent);
        const fields = guessFieldsFromTask(task);

        let client = "";
        // Job number "Film Name : CODE, Description" is the ground truth — prefer it over
        // task.projectName, which comes from fragile Wrike folder tree-climbing and can
        // misfire on shared/multi-parent folder structures.
        let filmTitle = "";
        // Split on " : " (space-colon-space) specifically, not the first bare colon — film
        // titles can contain their own colon (e.g. "Paw Patrol: The Dino Movie : XY025793, ...").
        if ((fields.jobNumber || "").includes(" : ")) {
          filmTitle = fields.jobNumber.split(" : ")[0].trim();
        }
        if (!filmTitle) filmTitle = task?.projectName || "";
        const searchTitle = (task?.title || "").toUpperCase();
        // Check FILM_MAPPINGS — match by value against jobNumber or filmTitle
        const _filmMatch2 = Object.entries(FILM_MAPPINGS).find(
          ([, v]) =>
            (fields.jobNumber || "")
              .toLowerCase()
              .startsWith(v.toLowerCase()) ||
            (filmTitle || "").toLowerCase().startsWith(v.toLowerCase())
        );
        if (_filmMatch2) filmTitle = _filmMatch2[1];

        const pathUpper = (task.extractedPathData || "").toUpperCase();

        if (pathUpper.includes("UNIVERSAL")) {
          const terr = (fields.territory || "").toUpperCase();
          if (terr === "UK" || terr === "UNITED KINGDOM")
            client = "Universal Pictures UK";
          else if (terr === "AUSTRALIA" || terr === "AU" || terr === "AUS")
            client = "Universal Pictures Australia";
          else client = "Universal Pictures International";
        } else if (pathUpper.includes("PARAMOUNT"))
          client = "Paramount Pictures";
        else if (pathUpper.includes("SONY")) client = "Sony Pictures";

        if (
          !filmTitle ||
          filmTitle === "Unknown Project" ||
          searchTitle.includes("SHOWREEL") ||
          searchTitle.includes("INTERNAL") ||
          searchTitle.includes("PITCH")
        ) {
          filmTitle = "XYi Unbilled";
          if (!client) client = "Internal";
        }

        // Job Book override — an admin-curated record beats any guess above
        const known2 = jobLookup?.getJob?.(fields.jobNumber);
        if (known2?.film_title) filmTitle = known2.film_title;
        if (known2?.client) client = known2.client;
        // Upgrade a bare/suffixed code to Job Book's canonical
        // "Film : CODE, Description" string so it reads consistently with jobs
        // that carried the full string from Wrike.
        if (known2?.job_number && (known2.job_number.includes(" : ") || !(fields.jobNumber || "").includes(" : "))) {
          // Job Book is authoritative — adopt its registered number whenever the
          // code is on file (canonical wins; a bare row won't downgrade a
          // canonical guess). The scanner-backfilled book makes this the primary
          // match, not a fallback.
          fields.jobNumber = known2.job_number;
        } else if (
          fields.folderDescription &&
          fields.jobNumber &&
          !fields.jobNumber.includes(" : ") &&
          filmTitle &&
          filmTitle !== "XYi Unbilled"
        ) {
          // Same rule as the pull path: the canonical string may only be built
          // from Wrike's own folder name, never from the task title. See the
          // long note in handlePullTimes for what the task-title version cost.
          const bare = (fields.jobNumber.match(/XY\d{5,6}/i) || [])[0];
          if (bare) {
            fields.jobNumber = `${filmTitle} : ${bare}, ${fields.folderDescription}`;
          }
        }
        jobLookup?.ensureJob?.(fields.jobNumber, { filmTitle, client });

        const groupName = fields.jobNumber || "Others (No Job Number)";
        if (!grouped[groupName]) {
          grouped[groupName] = [];
          newExpanded[groupName] = true;
        }

        grouped[groupName].push({
          ...task,
          wrikeCategory: fields.category,
          wrikeJob: fields.jobNumber,
          wrikeLocation: fields.territory,
          wrikeStatus: task.customStatusName || task.status,
          client: client,
          filmTitle: filmTitle,
          projectDescription: fields.notes,
          dueDate: task.dueDate,
          createdDate: task.createdDate,
        });
      });

      setWrikeTimesheetData(grouped);
      setExpandedGroups(newExpanded);
    } catch (err) {
      console.error(err);
      showToast("Failed to fetch Wrike data. Check your token and connection.");
    } finally {
      setIsFetchingModalData(false);
    }
  };

  const toggleGroup = (groupName) => {
    setExpandedGroups((prev) => ({
      ...prev,
      [groupName]: !prev[groupName],
    }));
  };

  const handleModalCategoryChange = (groupName, taskId, newCategory) => {
    setWrikeTimesheetData((prev) => {
      const groupTasks = prev[groupName].map((t) =>
        t.id === taskId ? { ...t, wrikeCategory: newCategory } : t
      );
      return { ...prev, [groupName]: groupTasks };
    });

    rows
      .filter((r) => r.taskId === taskId)
      .forEach((r) => updateRow(r.id, "category", newCategory));
  };

  const handleModalTimeChange = (task, dayOfWeek, value) => {
    const existingRow = rows.find(
      (r) => r.taskId === task.id && r.dayOfWeek === dayOfWeek
    );

    if (value === "none") {
      if (existingRow) {
        deleteRow(existingRow.id);
      }
      return;
    }

    if (existingRow) {
      updateRow(existingRow.id, "timeSpent", value);
      updateRow(existingRow.id, "category", task.wrikeCategory);
    } else {
      const newRow = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        taskId: task.id,
        dayOfWeek,
        jobNumber: task.wrikeJob,
        client: task.client,
        filmTitle: task.filmTitle,
        projectDescription: task.projectDescription,
        territory: task.wrikeLocation,
        category: task.wrikeCategory,
        clientAmends: false,
        is3D: false,
        timeSpent: value,
        additionalTime: "none",
      };
      addRow(newRow);
    }
  };

  const unloggedTasks = React.useMemo(() => {
    if (Object.keys(wrikeTimesheetData).length === 0) return [];

    const allModalTasks = Object.values(wrikeTimesheetData).flat();
    return allModalTasks.filter((task) => {
      const wrikeHours = getLogHoursForTaskAndDay(task.id, activeDay);
      const localRow = rows.find(
        (r) => r.taskId === task.id && r.dayOfWeek === activeDay
      );

      return !wrikeHours && (!localRow || localRow.timeSpent === "none");
    });
  }, [wrikeTimesheetData, rows, wrikeWeeklyLogs, activeDay]);

  const renderDayCell = (task, dayOfWeek) => {
    const wrikeHours = getLogHoursForTaskAndDay(task.id, dayOfWeek);
    const localRow = rows.find(
      (r) => r.taskId === task.id && r.dayOfWeek === dayOfWeek
    );
    const localValue = localRow ? localRow.timeSpent : "none";
    const isActive = localValue !== "none";
    const isToday = dayOfWeek === todayDayName;
    const isLocked = !isToday;

    return (
      <td
        className={`px-1 py-1.5 border-r border-[#263143] text-center group/cell transition-[background-color,opacity] ${
          isToday
            ? "bg-[#12a0e1]/8"
            : isActive
            ? "bg-[#1e293b]/40"
            : "opacity-30"
        }`}
        title={
          isLocked ? `Can only log time for today (${todayDayName})` : undefined
        }
      >
        <div className="flex flex-col items-center gap-1">
          <div className="mx-auto w-11 h-7 relative flex items-center justify-center">
            {isLocked ? (
              <span
                className={`text-[11px] font-bold ${
                  isActive ? "text-slate-400" : "text-slate-700"
                }`}
              >
                {isActive ? localValue : "—"}
              </span>
            ) : (
              <TableSearchableSelect
                options={TIME_OPTIONS}
                value={localValue}
                onChange={(val) => handleModalTimeChange(task, dayOfWeek, val)}
                placeholder="+"
                dropdownId={`wrike-day-${task.id}-${dayOfWeek}`}
                activeDropdown={activeDropdown}
                setActiveDropdown={setActiveDropdown}
                isTime={true}
                isDarkModal={true}
              />
            )}
          </div>
          {wrikeHours &&
            (() => {
              const totalMins = Math.round(wrikeHours * 60);
              const h = Math.floor(totalMins / 60);
              const m = totalMins % 60;
              const label =
                h > 0 && m > 0 ? `${h}h ${m}m` : h > 0 ? `${h}h` : `${m}m`;
              return (
                <div
                  className="text-[10px] font-bold text-emerald-400 bg-emerald-400/10 rounded px-1 leading-tight whitespace-nowrap"
                  title="Wrike Synced Time"
                >
                  {label} ✓
                </div>
              );
            })()}
        </div>
      </td>
    );
  };

  // Shared helper: parses Wrike HTML description into plain text + path data
  const parseWrikeDescription = (htmlString) => {
    if (!htmlString) return { notesText: "", extractedPathData: "" };
    let extractedPathData = "";
    const plainText = htmlString.replace(/<[^>]*>?/gm, " ");
    const folderMatches = plainText.match(/\/Volumes\/[^\s]+/gi);
    if (folderMatches) extractedPathData = folderMatches.join(" ");
    const xyMatch = plainText.match(/(XY\d{5,6})/i);
    if (xyMatch && !extractedPathData.includes(xyMatch[1]))
      extractedPathData += " " + xyMatch[1];
    const rawText = htmlString
      .replace(/<table[\s\S]*?<\/table>/i, "")
      .replace(/<[^>]*>/g, "")
      .trim();
    return {
      notesText: rawText,
      extractedPathData: extractedPathData.toUpperCase(),
    };
  };

  // Shared helper: enrich a raw Wrike task object the same way handleSyncMyJobs does
  // `statusDictionary` maps customStatusId -> the workflow label. Without it
  // this fell back to task.status, which is Wrike's fixed Active/Completed
  // lifecycle — so a timelog-fetched row's badge read "Completed" while the
  // identical task pulled through the assigned path read "Delivered".
  const enrichWrikeTask = (task, statusDictionary = {}, parentById) => {
    const parent = (task.superTaskIds || [])
      .map((id) => parentById?.get(id))
      .find(Boolean);
    const parsed = parseWrikeDescription(task.description);
    let projectName = task.title.split(/[_|-]/)[0].trim();
    if (parsed.extractedPathData) {
      const parts = parsed.extractedPathData.split("/");
      const digIdx = parts.findIndex((p) => p === "DIGITAL");
      if (digIdx > 0 && parts[digIdx - 1])
        projectName = decodeURIComponent(parts[digIdx - 1])
          .replace(/[_|-]/g, " ")
          .trim();
    }
    return {
      ...task,
      extractedPathData: parsed.extractedPathData,
      notesText: parsed.notesText,
      projectName,
      // Rules 2 and 3 for subtasks — see fetchParentTasks.
      parentTaskTitle: parent?.title || task.parentTaskTitle || "",
      superTaskParentIds: task.parentIds?.length ? [] : parent?.parentIds || [],
      customStatusName:
        (task.customStatusId && statusDictionary[task.customStatusId]) || task.status,
      // Mark as unassigned-recovery so we know this task was fetched because
      // the user was removed from it — keeps all metadata intact
      assignees: ["__recovered__"],
      dueDate: task.dates?.due ?? null,
      createdDate: task.createdDate,
    };
  };

  // Fetch task details for IDs missing from the local task list (e.g. user
  // logged time then was removed as a responsible). Returns an updated copy of
  // the task array with the recovered tasks appended.
  const fetchMissingTasks = async (currentTasks, logEntries) => {
    const existingIds = new Set(currentTasks.map((t) => t.id));
    const missingIds = [...new Set(logEntries.map((l) => l.taskId))].filter(
      (id) => !existingIds.has(id)
    );
    if (missingIds.length === 0) return currentTasks;

    const fieldsFilter = encodeURIComponent(
      "[customFields,parentIds,superTaskIds,description]"
    );
    // Collected raw, then enriched in one pass at the end: the parent lookup
    // that subtask countries need is worth doing once for the whole recovery,
    // not per 100-id chunk.
    let rawRecovered = [];

    // Same A/B strategy STEP 2 of handleSyncMyJobs uses: `fields=` 400s for
    // tasks the caller isn't a responsible on, and this path exists precisely
    // to recover those. Without the retry a 400 left `json.data` undefined and
    // the whole chunk was dropped in silence — `res.json()` on an error body
    // doesn't throw, so the catch below never fired and nothing was logged.
    // Every timelog in that chunk then found no task and produced a blank row
    // (no job number, "Internal"/"XYi Unbilled", no territory).
    const fetchChunk = async (ids) => {
      let res = await fetch(`/api/wrike/tasks/${ids.join(",")}?fields=${fieldsFilter}`);
      if (!res.ok) res = await fetch(`/api/wrike/tasks/${ids.join(",")}`);
      if (!res.ok) return null;
      const json = await res.json();
      return json.data || null;
    };

    for (let i = 0; i < missingIds.length; i += 100) {
      const chunk = missingIds.slice(i, i + 100);
      try {
        const data = await fetchChunk(chunk);
        if (data) {
          rawRecovered = [...rawRecovered, ...data];
          continue;
        }
        // A batch request is all-or-nothing: one unreadable id fails all 100
        // with it. Fall back to one call per id so a single bad task costs
        // only its own row.
        for (const id of chunk) {
          const one = await fetchChunk([id]).catch(() => null);
          if (one) rawRecovered = [...rawRecovered, ...one];
          else console.warn("Could not recover timelog task:", id);
        }
      } catch (err) {
        console.warn("Failed to recover missing tasks chunk:", chunk, err);
        // Don't abort the whole pull — continue with whatever we have
      }
    }

    const parentById = await fetchParentTasks(rawRecovered);
    return [
      ...currentTasks,
      ...rawRecovered.map((t) => enrichWrikeTask(t, {}, parentById)),
    ];
  };

  const dismissNewWeekBanner = () => setNewWeekBanner(false);

  const handlePullTimes = async (dateStr = null) => {
    if (!wrikeUserId) {
      showToast("Please connect Wrike in Profile → Settings first.");
      return;
    }

    setIsPulling(true);
    try {
      // Awaited here too, not just in the sync below: that call can bail early
      // (no Wrike user, a failed fetch) and this path then builds its rows off
      // activeWrikeData regardless — with no tree, those rows would be exactly
      // the ones that skipped the folder rule before.
      await Promise.all([ensureFolderTree(), warmCountryFields()]);

      let currentTasks = await handleSyncMyJobs(true);
      if (!currentTasks) currentTasks = activeWrikeData;

      // Use contacts-scoped endpoint — avoids the broken trackedDate query param
      // Filter to target date(s) client-side using local date strings
      const localIso = (d) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
          d.getDate()
        ).padStart(2, "0")}`;
      const now = new Date();
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      // A normal pull covers today *and* yesterday, so time logged after the
      // last pull of the previous day still lands without needing a debug
      // pull. The admin debug pull stays single-date — it's for targeting one
      // specific day. Anything already pulled is skipped by
      // existingTimelogIds below, and frozen days are dropped when grouping,
      // so widening the window can't duplicate or overwrite yesterday's rows.
      const targetDates =
        typeof dateStr === "string" && dateStr
          ? [dateStr]
          : [localIso(yesterday), localIso(now)];
      const targetDateSet = new Set(targetDates);

      const res = await fetch(`/api/wrike/contacts/${wrikeUserId}/timelogs`);
      const json = await res.json();
      const logs = (json.data || []).filter((l) =>
        targetDateSet.has(l.trackedDate?.split("T")[0])
      );

      // Recover any tasks where the user was removed as a responsible —
      // their timelogs still exist but the task won't appear in handleSyncMyJobs
      currentTasks = await fetchMissingTasks(currentTasks, logs);

      // Fetch existing timelog IDs across ALL sources so we don't duplicate
      // entries that were already pulled in Tracker (or vice versa). Passing
      // no source is deliberate: Tracker's own pull already scans all sources,
      // so scoping Legacy to source="legacy" here was the asymmetry that let a
      // timelog already pulled by Tracker get re-added as a duplicate Legacy
      // row. The helper splits comma-joined ids, so Legacy's aggregated
      // "id1,id2,id3" rows are matched at the individual-id level too.
      const existingTimelogIds = await fetchExistingTimelogIds(wrikeUserId);

      const newRows = [];
      const dayNames = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
      ];

      // Group logs by taskId + dayOfWeek so we sum hours before rounding.
      // 2 × 2-min logs for the same task → 4 min total → 0.5h, not 0.5 + 0.5 = 1h.
      const grouped = {};
      logs.forEach((log) => {
        if (existingTimelogIds.has(log.id)) return;
        const [ly, lm, ld] = log.trackedDate
          .split("T")[0]
          .split("-")
          .map(Number);
        const logDate = new Date(ly, lm - 1, ld);
        const dayOfWeek = dayNames[logDate.getDay()];
        if (frozenDays[dayOfWeek]) return;
        const key = `${log.taskId}_${dayOfWeek}`;
        if (!grouped[key]) {
          grouped[key] = { log, logDate, dayOfWeek, totalHours: 0, notes: "", allIds: [] };
        }
        grouped[key].allIds.push(log.id);
        grouped[key].totalHours += log.hours;
        if (!grouped[key].notes && log.comment)
          grouped[key].notes = log.comment;
      });

      Object.values(grouped).forEach(
        ({ log, logDate, dayOfWeek, totalHours, notes, allIds }) => {
          const task = currentTasks.find((t) => t.id === log.taskId);
          const guessed = guessFieldsFromTask(task);

          let client = "";
          // Job number "Film Name : CODE, Description" is the ground truth — prefer it over
          // task.projectName, which comes from fragile Wrike folder tree-climbing and can
          // misfire on shared/multi-parent folder structures.
          let filmTitle = "";
          // Split on " : " (space-colon-space) specifically, not the first bare colon — film
          // titles can contain their own colon (e.g. "Paw Patrol: The Dino Movie : XY025793, ...").
          if ((guessed.jobNumber || "").includes(" : ")) {
            filmTitle = guessed.jobNumber.split(" : ")[0].trim();
          }
          if (!filmTitle) filmTitle = task?.projectName || "";
          if (
            filmTitle &&
            filmTitle === filmTitle.toUpperCase() &&
            filmTitle !== filmTitle.toLowerCase()
          ) {
            filmTitle = filmTitle.replace(
              /\w\S*/g,
              (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()
            );
          }
          const searchTitle = (task?.title || "").toUpperCase();
          // Check FILM_MAPPINGS — match by value against jobNumber or filmTitle
          const _filmMatch1 = Object.entries(FILM_MAPPINGS).find(
            ([, v]) =>
              (guessed.jobNumber || "")
                .toLowerCase()
                .startsWith(v.toLowerCase()) ||
              (filmTitle || "").toLowerCase().startsWith(v.toLowerCase())
          );
          if (_filmMatch1) filmTitle = _filmMatch1[1];

          if (task) {
            const pathUpper = (task.extractedPathData || "").toUpperCase();
            if (pathUpper.includes("UNIVERSAL")) {
              const terr = (guessed.territory || "").toUpperCase();
              if (terr === "UK" || terr === "UNITED KINGDOM")
                client = "Universal Pictures UK";
              else if (terr === "AUSTRALIA" || terr === "AU" || terr === "AUS")
                client = "Universal Pictures Australia";
              else client = "Universal Pictures International";
            } else if (pathUpper.includes("PARAMOUNT"))
              client = "Paramount Pictures";
            else if (pathUpper.includes("SONY")) client = "Sony Pictures";
          }

          if (
            !filmTitle ||
            filmTitle === "Unknown Project" ||
            searchTitle.includes("SHOWREEL") ||
            searchTitle.includes("INTERNAL") ||
            searchTitle.includes("PITCH")
          ) {
            filmTitle = "XYi Unbilled";
            if (!client) client = "Internal";
          }

          // Job Book override — an admin-curated record beats any guess above
          const known1 = jobLookup?.getJob?.(guessed.jobNumber);
          if (known1?.film_title) filmTitle = known1.film_title;
          if (known1?.client) client = known1.client;
          // Upgrade a bare "XY025716" to Job Book's canonical
          // "Film : XY025716, Description" string so pulled rows read
          // consistently with those that carried the full string from Wrike.
          if (known1?.job_number && (known1.job_number.includes(" : ") || !(guessed.jobNumber || "").includes(" : "))) {
            // Job Book is authoritative — adopt its registered number whenever
            // the code is on file (canonical wins; a bare row won't downgrade a
            // canonical guess). Backfilled book = primary match, not a fallback.
            guessed.jobNumber = known1.job_number;
          } else if (
            guessed.folderDescription &&
            guessed.jobNumber &&
            !guessed.jobNumber.includes(" : ") &&
            filmTitle &&
            filmTitle !== "XYi Unbilled"
          ) {
            // Brand-new job with no Job Book record yet. Build the canonical
            // string ONLY out of what Wrike's folder tree says, which is the
            // same source scanStudioJobNumbers reconciles the book against — so
            // this row and any later scan cannot disagree.
            //
            // This used to synthesize from the TASK title, which describes a
            // piece of work rather than a job. It wrote rows like
            // "The Odyssey : XY026047, ODY_Print_Teaser1SHT_Birds_CMYK_KR" into
            // the book permanently: well-formed enough that the scan's film and
            // malformed-code checks both pass, so nothing ever flagged it, and
            // every later pull adopted it in preference to a fresh guess.
            //
            // The BARE code, not guessed.jobNumber: resolveJobNumber returns
            // its input untouched when the code isn't in the list, so an
            // unmatched code arrives here still carrying its suffix and used to
            // land in the string twice over.
            const bare = (guessed.jobNumber.match(/XY\d{5,6}/i) || [])[0];
            if (bare) {
              guessed.jobNumber = `${filmTitle} : ${bare}, ${guessed.folderDescription}`;
            }
          }
          // No folder description means no canonical string — the bare code is
          // registered as a stub instead. Deliberately conspicuous: a bare row
          // trips the Studio Scan's own malformed-code test and gets filled in
          // from the folder tree, which an invented-but-tidy string never would.
          // The timesheet bookmarklet resolves a bare code on its own (it
          // matches on the XY code when no option matches verbatim), so nothing
          // downstream needs the pretty form.
          jobLookup?.ensureJob?.(guessed.jobNumber, { filmTitle, client });

          newRows.push({
            id: Date.now() + Math.floor(Math.random() * 1000),
            wrikeTimelogId: allIds.join(","),
            taskId: task?.id,
            dayOfWeek,
            date: logDate.toLocaleDateString("en-GB"),
            jobNumber: guessed.jobNumber,
            client,
            filmTitle,
            projectDescription: guessed.notes,
            territory: guessed.territory,
            category: guessed.category,
            clientAmends: false,
            notes: notes || task?.title || "",
            is3D: false,
            timeSpent: secondsToHM(totalHours * 3600),
            additionalTime: "none",
            // Raw, unrounded hours, carried only so mergeMultiCountryRows can
            // sum before rounding. useTasks maps an explicit column whitelist,
            // so this never reaches Supabase — but it is stripped there anyway
            // rather than relying on that.
            _rawHours: totalHours,
          });
        }
      );

      const pulledRows = groupMultiCountry
        ? mergeMultiCountryRows(newRows)
        : newRows.map(({ _rawHours, ...r }) => r);

      if (pulledRows.length > 0) {
        addRows(pulledRows);
        // The grid only shows rows from the current week (weekStart) — a
        // debug pull for an older date saves fine but won't appear here, so
        // say so instead of implying it's now visible in the table below.
        const pulledBeforeThisWeek = pulledRows.some(
          (r) => (toIsoDate(r.date) || "") < weekStart
        );
        const n = pulledRows.length;
        // Report the merge when it did something, so a pull that turns six
        // market rows into two isn't mistaken for six missing timelogs.
        const mergedAway = newRows.length - n;
        const mergeNote = mergedAway > 0 ? ` (${newRows.length} market rows merged into ${n})` : "";
        showToast(
          pulledBeforeThisWeek
            ? `Pulled ${n} row${n !== 1 ? "s" : ""} from Wrike${mergeNote} — from a previous week, so it won't show in this grid. Check Jobs Feed to verify.`
            : `Pulled ${n} row${n !== 1 ? "s" : ""} from Wrike${mergeNote}.`,
          "success"
        );
      } else {
        showToast(
          targetDates.length > 1
            ? "No new or unfrozen times found for today or yesterday."
            : "No new or unfrozen times found for that date."
        );
      }
    } catch (err) {
      console.error(err);
      showToast("Failed to pull times: " + err.message);
    } finally {
      setIsPulling(false);
    }
  };

  const handleExportExcel = () => {
    if (rows.length === 0) {
      showToast("No data to export yet.");
      return;
    }

    const headers = ["Day", ...COLUMNS].join(",");
    const csvRows = rows.map((row) => {
      return [
        row.dayOfWeek,
        `"${row.jobNumber}"`,
        `"${row.client}"`,
        `"${row.filmTitle}"`,
        `"${row.projectDescription?.replace(/"/g, '""') || ""}"`,
        `"${row.territory}"`,
        `"${row.category}"`,
        row.clientAmends ? "Yes" : "No",
        `"${(row.notes ?? "").replace(/"/g, '""')}"`,
        row.is3D ? "Yes" : "No",
        row.timeSpent,
        row.additionalTime,
      ].join(",");
    });

    const csvContent = [headers, ...csvRows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `Timesheet_Export_${
      new Date().toISOString().split("T")[0]
    }.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyJSON = async () => {
    if (rows.length === 0) {
      showToast("No data to copy yet.");
      return;
    }

    try {
      const mappedTasks = rows.map((row) => {
        const rawSecs = row.rawSeconds ?? 0;
        const addSecs = row.additionalSeconds ?? 0;

        // A row can cover several markets; the destination site ticks one
        // checkbox per country on the same row, so send them all. Names go out
        // exactly as TERRITORIES holds them — that list mirrors the site's own
        // country names ("UK", not "United Kingdom"), and renaming them here
        // used to leave those rows with no country ticked at all. The one
        // exception is a value the site has no checkbox for at all, which
        // toTimesheetTerritories swaps for the nearest one it does have.
        const exportTerritories = toTimesheetTerritories(row.territory);

        return {
          id: row.id,
          taskId: row.taskId,
          jobNumber: row.jobNumber || "",
          // `territory` stays a string for older bookmarklets (they match it
          // against a single checkbox); `territories` is what current ones read.
          territory: exportTerritories.join(", "),
          territories: exportTerritories,
          category: row.category || "",
          notes:
            (row.projectDescription || "") +
            (row.notes ? ` | ${row.notes}` : ""),
          dayOfWeek: row.dayOfWeek || activeDay,
          rawSeconds: rawSecs,
          additionalSeconds: addSecs,
          is3D: !!row.is3D,
          clientAmends: !!row.clientAmends,
        };
      });

      const getConsolidatedTasks = (taskList) => {
        const consolidated = {};
        taskList.forEach((t) => {
          // territoryKey so "Belgium, France" and "France, Belgium" merge.
          //
          // The WHOLE job label, not just its code. Grouping on the code alone
          // was tried and backed out: it merges rows that describe genuinely
          // different pieces of work under one job ("CW LSQ Stairs" and "CW
          // Rotunda" on XY025957), and the studio wants those on the timesheet
          // as separate lines. Labels that differ only in spelling are fixed at
          // the source that writes them, not papered over here.
          const key = `${t.dayOfWeek}|${t.jobNumber}|${territoryKey(t.territory)}|${t.category}`;
          if (!consolidated[key]) {
            consolidated[key] = {
              ...t,
              rawSeconds: 0,
              additionalSeconds: 0,
              notesArray: [],
              subtaskCount: 0,
            };
          }
          consolidated[key].rawSeconds += t.rawSeconds || 0;
          consolidated[key].additionalSeconds += t.additionalSeconds || 0;
          consolidated[key].subtaskCount += 1;
          if (t.notes && !consolidated[key].notesArray.includes(t.notes)) {
            consolidated[key].notesArray.push(t.notes);
          }
        });

        // Exact seconds go out. How coarse a row may be is decided per *job* on
        // the timesheet site (a UK-folder job takes 0.25 steps, an INT one only
        // 0.5) and nothing here can know which — so the bookmarklet snaps each
        // row against its own dropdown instead of us guessing up front.
        return Object.values(consolidated).map((c) => ({
          ...c,
          notes: c.notesArray.filter(Boolean).join(" | "),
        }));
      };

      const exportData = {
        version: 7, // 7 = seconds are exact (the bookmarklet does the rounding)
        exportDate: new Date().toISOString(),
        tasks: getConsolidatedTasks(mappedTasks),
        rawTasks: mappedTasks,
        // No jobOptions field. It carried DEFAULT_JOBS, and the bookmarklet has
        // never read it — it resolves each row against the timesheet site's own
        // job dropdown, which is the only list that can be authoritative there.
      };

      const jsonString = JSON.stringify(exportData);

      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(jsonString);
      } else {
        const tempTextArea = document.createElement("textarea");
        tempTextArea.value = jsonString;
        tempTextArea.style.position = "absolute";
        tempTextArea.style.left = "-999999px";
        document.body.appendChild(tempTextArea);
        tempTextArea.select();
        document.execCommand("copy");
        document.body.removeChild(tempTextArea);
      }

      setJsonCopied(true);
      setTimeout(() => setJsonCopied(false), 3000);
    } catch (err) {
      console.error("Failed to copy JSON", err);
      showToast("Failed to copy JSON. Check browser clipboard permissions.");
    }
  };

  // updateRow(id, field, value) and deleteRow(id) are provided by useLegacyRows
  const handleUpdateRow = (id, field, value) => {
    if (frozenDays[activeDay]) return;
    // Picking a job fills client / film / description from the Job Book, exactly
    // like a Wrike pull does — so a manually-set job isn't left with blank
    // client & film columns.
    if (field === "jobNumber" && value) {
      const known = jobLookup?.getJob?.(value);
      if (known?.client) updateRow(id, "client", known.client);
      if (known?.film_title) updateRow(id, "filmTitle", known.film_title);
      const desc = value.includes(",") ? value.substring(value.indexOf(",") + 1).trim() : "";
      if (desc) updateRow(id, "projectDescription", desc);
    }
    updateRow(id, field, value);
  };

  const handleDeleteRow = (id) => {
    if (frozenDays[activeDay]) return;
    deleteRow(id);
  };

  const toggleFreeze = () => {
    setFrozenDays((prev) => ({
      ...prev,
      [activeDay]: !prev[activeDay],
    }));
  };

  // Clean a stored job number for display: if the Job Book has a canonical
  // "Film : CODE, Desc" for this code, show that instead of whatever polluted
  // string an old logged row carries (e.g. the bloated field value). Purely a
  // display fix — the row persists its clean value only if the user edits it.
  const canonicalJob = useCallback((jn) => {
    const known = jn && jobLookup?.getJob?.(jn);
    return known?.job_number?.includes(" : ") ? known.job_number : jn;
  }, [jobLookup]);
  const currentDayRows = useMemo(
    () => rows.filter((r) => r.dayOfWeek === activeDay).map((r) => ({ ...r, jobNumber: canonicalJob(r.jobNumber) })),
    [rows, activeDay, canonicalJob]
  );
  const isDayFrozen = frozenDays[activeDay] || false;

  const [consolidatedView, setConsolidatedView] = useState(true);

  // ── Batch edit ──────────────────────────────────────────────────────────
  // Row ids ticked for a bulk change. Real row ids only: the consolidated
  // group header is a read-only summary and never routes an edit, so ticking
  // one selects the subrows underneath it instead of itself.
  const [selectedRowIds, setSelectedRowIds] = useState(() => new Set());

  const toggleRowSelected = useCallback((id) => {
    setSelectedRowIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedRowIds(new Set()), []);

  // ── The categories this person actually uses ────────────────────────────
  // Needs no new column: `tasks` already holds every row they've logged, with
  // its category, and RLS scopes the read to them — the same trick recentJobs
  // below uses for job numbers.
  //
  // MOST USED, not most recent. People use a handful of categories over and
  // over, so frequency is the stable signal; a recency list would be dominated
  // by whatever one-off they happened to log last. Ties go to the more recent,
  // which is what makes a newly-adopted category climb instead of sitting
  // behind years of history at the same count.
  //
  // Capped at six. The point is to put the obvious answers within reach, not to
  // rebuild the list — beyond a handful it stops being a shortcut and becomes a
  // second list to read.
  const [topCategories, setTopCategories] = useState([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      await whenIdentityReady();
      if (!alive) return;
      const logged = await selectAll("tasks", "category, created_at", (q) =>
        q.not("category", "is", null)
      );
      if (!alive) return;
      const stats = new Map();
      for (const r of logged) {
        const c = (r.category || "").trim();
        // "⚠️ Unassigned" is the Tracker's placeholder for "nobody said", not a
        // category anyone chose, and it would otherwise top the list.
        if (!c || !CATEGORIES.includes(c)) continue;
        const s = stats.get(c) || { count: 0, at: "" };
        s.count += 1;
        if ((r.created_at || "") > s.at) s.at = r.created_at || "";
        stats.set(c, s);
      }
      const ranked = [...stats.entries()]
        .sort((a, b) => b[1].count - a[1].count || (a[1].at < b[1].at ? 1 : -1))
        .slice(0, 6)
        .map(([c]) => c);
      setTopCategories(ranked);
    })();
    return () => { alive = false; };
  }, []);

  // ── Job-number dropdown options: jobs we've actually logged, most-recent
  // first, then the static catalogue as a fallback. RLS scopes the tasks query
  // to the caller's own rows, so this is genuinely "jobs I've logged". Dates are
  // stored dd/mm/yyyy (or ISO), so parse before comparing — a string sort would
  // put 31/01 ahead of 01/12.
  // Dropdown options come from the Job Book (the curated, clean list) — NOT the
  // raw logged rows, which can still carry old polluted job strings. We only use
  // the logged rows to *order* the book by recency (the codes I've logged most
  // recently float to the top); the label always comes from the book, so a
  // deleted/renamed job never reappears from stale timesheet history.
  const [recentJobs, setRecentJobs] = useState([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      const codeKey = (j) => (j.match(/XY\d{5,6}/i)?.[0] || j).trim().toUpperCase();
      // All three tables are RLS-gated to `authenticated` (tasks additionally by
      // wrike_user_id), so this must wait for the session + identity stamp or it
      // returns empty on a first login.
      await whenIdentityReady();
      if (!alive) return;
      // selectAll on all three: each is past (or heading past) Supabase's 1000-row
      // response cap, which truncates without erroring. A partial `jobs` read is
      // what made recently-allocated jobs unselectable in the row dropdown.
      const [books, legacyTasks, films] = await Promise.all([
        selectAll("jobs", "job_number"),
        selectAll("tasks", "job_number, date", (q) =>
          q.eq("source", "legacy").not("job_number", "is", null)),
        selectAll("films", "title"),
      ]);
      if (!alive) return;
      // Real films from the DB — used to sink pseudo-"films" (e.g. a "2026" year
      // folder) below genuine titles in the dropdown grouping.
      const normFilm = (s) => (s || "").toLowerCase().replace(/[_\s]+/g, " ").trim();
      const realFilms = new Set(films.map((f) => normFilm(f.title)));
      // A group name like "2026" (a year folder) or a purely numeric/blank token
      // isn't a real film — sink those regardless of whether the films table read
      // succeeded. Confirmed DB films rank highest.
      const looksNonFilm = (film) => /^\d{2,4}$/.test(film.trim()) || !/[a-z]/i.test(film);
      const filmRank = (label) => {
        const film = (label.split(" : ")[0] || "").trim();
        if (realFilms.has(normFilm(film))) return 2;
        if (looksNonFilm(film)) return 0;
        return 1;
      };
      // Book: code -> best canonical label (prefer "Film : CODE, Desc").
      const bookLabel = {};
      books.forEach((r) => {
        const j = (r.job_number || "").trim();
        if (!j) return;
        const k = codeKey(j);
        if (!bookLabel[k] || (j.includes(" : ") && !bookLabel[k].includes(" : "))) bookLabel[k] = j;
      });
      // Recency: code -> most recent date it was logged.
      // Recency: code -> most recent date it was logged. Sorting ISO strings
      // is the whole point of the shared parser; no Date objects needed.
      const isoOf = (r) => r.work_date || toIsoDate(r.date) || "";
      const recency = {};
      legacyTasks.forEach((r) => {
        const k = codeKey(r.job_number || "");
        if (!k) return;
        const t = isoOf(r);
        if (!(k in recency) || t > recency[k]) recency[k] = t;
      });
      // Book jobs: real films first, then most-recently-logged, then alphabetical.
      const codes = Object.keys(bookLabel).sort((a, b) =>
        (filmRank(bookLabel[b]) - filmRank(bookLabel[a])) ||
        // recency holds ISO date strings, so compare them as strings — a
        // numeric subtraction here would yield NaN and scramble the order.
        (recency[b] || "").localeCompare(recency[a] || "") ||
        bookLabel[a].localeCompare(bookLabel[b])
      );
      setRecentJobs(codes.map((k) => bookLabel[k]));
    })();
    return () => { alive = false; };
  }, [rows.length]);

  // Book-first (recency-ordered), de-duped by XY code, with the static catalogue
  // appended so nothing that used to be selectable disappears. Finally, sink any
  // pseudo-film bucket (a year/numeric group name like "2026" the scan derived
  // from a year folder) BELOW real films — applied to the merged list so a real
  // film from the catalogue floats above a "2026" job from the book. Stable sort
  // keeps recency order within each bucket.
  const jobOptions = useMemo(() => {
    const seen = new Set();
    const out = [];
    const codeKey = (j) => (j.match(/XY\d{5,6}/i)?.[0] || j).toUpperCase();
    [...recentJobs, ...bookJobNumbers].forEach((j) => {
      const k = codeKey(j);
      if (!seen.has(k)) { seen.add(k); out.push(j); }
    });
    const nonFilm = (label) => {
      const f = (label.split(" : ")[0] || "").trim();
      return /^\d{2,4}$/.test(f) || !/[a-z]/i.test(f);
    };
    return out.sort((a, b) => (nonFilm(a) ? 1 : 0) - (nonFilm(b) ? 1 : 0));
    // bookJobNumbers, not just recentJobs: the book arrives after first paint,
    // so without it here the picker would keep whatever it built while the book
    // was still empty.
  }, [recentJobs, bookJobNumbers]);

  const [expandedSessions, setExpandedSessions] = useState({});
  const toggleSessions = (rowKey) =>
    setExpandedSessions((prev) => ({ ...prev, [rowKey]: !prev[rowKey] }));
  // Collapsed job groups in consolidated view (default: expanded, so you see
  // every territory/category subrow). Keyed by jobNumber.
  const [collapsedGroups, setCollapsedGroups] = useState({});
  const toggleJobGroup = (jobNumber) =>
    setCollapsedGroups((prev) => ({ ...prev, [jobNumber]: !prev[jobNumber] }));
  // Multi-country add: which job group's "add entry" popover is open, and the
  // countries currently ticked in it.
  const [addEntryFor, setAddEntryFor] = useState(null);
  const [addEntryPos, setAddEntryPos] = useState(null);
  const [multiCountrySel, setMultiCountrySel] = useState([]);
  const [countryQuery, setCountryQuery] = useState("");
  // Position the popover as position:fixed anchored to the "+" button so it
  // escapes the table's scroll container (which would otherwise clip it at the
  // table's bottom edge). layoutRect corrects for the app's html{zoom:1.1}.
  const openAddPopover = (jobNumber, e) => {
    if (addEntryFor === jobNumber) { setAddEntryFor(null); return; }
    const rect = layoutRect(e.currentTarget);
    const w = 256, estH = 380;
    // Layout pixels, matching layoutRect and the style this ends up in.
    const { vw, vh } = layoutViewport();
    let left = Math.max(8, Math.min(rect.right - w, vw - w - 8));
    const spaceBelow = vh - rect.bottom;
    const top = spaceBelow < estH && rect.top > spaceBelow
      ? Math.max(8, rect.top - estH)
      : rect.bottom + 6;
    setAddEntryPos({ left, top, width: w });
    setAddEntryFor(jobNumber);
    setMultiCountrySel([]);
    setCountryQuery("");
  };

  // Consolidated = grouped by Job Number. Each job bundles every territory /
  // category / session logged against it that day; those individual entries are
  // the group's editable subrows. (Previously grouped by the whole
  // job+territory+category triple, which fragmented one job across many rows.)
  const consolidatedRows = useMemo(() => {
    const groups = {};
    currentDayRows.forEach((row) => {
      const key = row.jobNumber || "(no job number)";
      if (!groups[key]) {
        groups[key] = {
          id: `grp:${key}`,           // stable key for the group header row
          isGroup: true,
          jobNumber: row.jobNumber,
          client: row.client,
          filmTitle: row.filmTitle,
          projectDescription: row.projectDescription,
          _rawSeconds: 0,
          _additionalSeconds: 0,
          _territories: new Set(),
          _categories: new Set(),
          _subRows: [],
        };
      }
      const g = groups[key];
      g._rawSeconds += row.rawSeconds ?? 0;
      g._additionalSeconds += row.additionalSeconds ?? 0;
      // A row can cover several markets, so count each one against the job.
      splitTerritories(row.territory).forEach((t) => g._territories.add(t));
      if (row.category) g._categories.add(row.category);
      // First non-empty client/film wins, so the header isn't blank when only
      // some sessions carry them.
      if (!g.client && row.client) g.client = row.client;
      if (!g.filmTitle && row.filmTitle) g.filmTitle = row.filmTitle;
      g._subRows.push(row);
    });
    return Object.values(groups).map((g) => ({
      ...g,
      rawSeconds: g._rawSeconds,
      additionalSeconds: g._additionalSeconds,
      timeSpent: secondsToHM(g._rawSeconds),
      additionalTime: secondsToHM(g._additionalSeconds),
      territories: [...g._territories],
      categories: [...g._categories],
    }));
  }, [currentDayRows]);

  // Flat list of what the tbody renders. Consolidated view emits a group-header
  // row followed by its editable subrows (unless the group is collapsed); flat
  // view emits each real row directly. Either way every item ultimately edits a
  // real row by its own id — the group header is a read-only summary and never
  // routes an edit.
  const renderItems = useMemo(() => {
    if (!consolidatedView) return currentDayRows.map((row) => ({ type: "row", row }));
    return consolidatedRows.flatMap((g) => {
      const collapsed = collapsedGroups[g.jobNumber];
      return [
        { type: "group", group: g },
        ...(collapsed ? [] : g._subRows.map((sub) => ({ type: "sub", row: sub, group: g }))),
      ];
    });
  }, [consolidatedView, currentDayRows, consolidatedRows, collapsedGroups]);

  const displayRows = consolidatedView ? consolidatedRows : currentDayRows;
  // Only the explicit per-day Lock blocks editing now — consolidated view is
  // fully editable (you edit real subrows, never the merged summary).
  const rowsAreEditable = !isDayFrozen;

  // Every real row the grid is currently showing, in either view. Consolidated
  // mode emits group headers too, and a collapsed group hides its subrows — so
  // this is derived from renderItems rather than from currentDayRows, and
  // "select all" means "all the rows you can actually see".
  const selectableIds = useMemo(
    () => renderItems.filter((i) => i.type !== "group").map((i) => i.row.id),
    [renderItems]
  );

  // Ids can vanish under a selection — a pull merges rows, a day changes, a
  // group collapses. Anything no longer on screen is dropped rather than left
  // to be silently included in the next bulk edit.
  useEffect(() => {
    setSelectedRowIds((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(selectableIds);
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [selectableIds]);

  const selectedCount = selectedRowIds.size;
  const allSelected = selectableIds.length > 0 && selectedCount === selectableIds.length;

  const toggleSelectAll = useCallback(() => {
    setSelectedRowIds((prev) =>
      prev.size === selectableIds.length ? new Set() : new Set(selectableIds)
    );
  }, [selectableIds]);

  // One field across every ticked row. Goes through handleUpdateRow so a bulk
  // change behaves exactly like typing into each cell — same frozen-day guard,
  // same Job Book side-effects, same save flash.
  const applyToSelected = useCallback(
    (field, value) => {
      for (const id of selectedRowIds) handleUpdateRow(id, field, value);
      clearSelection();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedRowIds, clearSelection]
  );
  const showConsolidationWarning =
    !consolidatedView &&
    currentDayRows.some(
      (r, _, arr) =>
        arr.filter(
          (x) =>
            x.jobNumber === r.jobNumber &&
            territoryKey(x.territory) === territoryKey(r.territory) &&
            x.category === r.category
        ).length > 1
    );

  const textAreaClass = `w-full bg-transparent border border-transparent hover:border-slate-300 focus:border-[#12a0e1] focus:ring-2 focus:ring-[#12a0e1]/20 outline-none text-[12px] text-[#122027] font-medium p-2 transition-[border-color,box-shadow] rounded-xl resize-none overflow-hidden leading-tight placeholder:text-slate-500 ${
    !rowsAreEditable ? "opacity-60 cursor-not-allowed" : ""
  }`;

  return (
    <div className="min-h-screen bg-slate-100 font-sans selection:bg-[#12a0e1]/30">
      {/* Toast */}
      {toast.show && (
        <div
          className={`fixed top-5 right-5 z-[99999] flex items-center gap-3 px-5 py-3.5 rounded-2xl shadow-2xl text-sm font-bold transition-[opacity,transform] animate-in fade-in slide-in-from-top-2 duration-300 ${
            toast.type === "error"
              ? "bg-rose-500 text-white"
              : "bg-[#1cc1a5] text-white"
          }`}
        >
          {toast.type === "error" ? (
            <AlertCircle className="w-4 h-4 shrink-0" />
          ) : (
            <CheckCircle className="w-4 h-4 shrink-0" />
          )}
          {toast.message}
        </div>
      )}
      {/* --- REMINDER MODAL --- */}
      {showReminderModal && (
        <div
          className="fixed inset-0 z-[100001] flex items-center justify-center p-4"
          onClick={() => setShowReminderModal(false)}
        >
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <div
            className="relative w-full max-w-md bg-gradient-to-b from-[#1c2333] to-[#141b28] border border-white/10 rounded-2xl shadow-2xl flex flex-col max-h-[80vh] animate-in fade-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Glossy top edge */}
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent" />
            {/* Header */}
            <div className="px-5 pt-5 pb-4 border-b border-white/5 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-bold text-white">
                  Anything left to log?
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  These tasks don't have hours yet for{" "}
                  <span className="text-slate-200">{activeDay}</span>
                </p>
              </div>
              <button
                onClick={() => setShowReminderModal(false)}
                className="text-slate-500 hover:text-white transition-colors mt-0.5 shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {/* Body */}
            <div className="p-4 space-y-2 overflow-visible">
              {unloggedTasks.length === 0 ? (
                <div className="text-center py-8">
                  <CheckCircle className="w-8 h-8 text-emerald-400 mx-auto mb-2 opacity-80" />
                  <p className="text-white font-semibold text-sm">All good!</p>
                  <p className="text-slate-500 text-xs mt-1">
                    Nothing missing for {activeDay}
                  </p>
                </div>
              ) : (
                unloggedTasks.map((task) => (
                  <div
                    key={task.id}
                    className="bg-white/[0.04] hover:bg-white/[0.07] border border-white/[0.07] rounded-xl p-3.5 flex items-center gap-3 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <p
                        className="text-sm font-semibold text-white truncate"
                        title={task.title}
                      >
                        {task.title}
                      </p>
                      <div className="flex flex-wrap gap-1.5 mt-1.5">
                        <span className={getDarkTagStyle(task.wrikeStatus)}>
                          {task.wrikeStatus}
                        </span>
                        <span className="text-slate-500 text-[11px]">
                          {task.wrikeCategory}
                        </span>
                        {task.wrikeLocation !== "⚠️ Unassigned" && (
                          <span className="text-slate-500 text-[11px]">
                            {TERRITORY_FLAGS[task.wrikeLocation]}{" "}
                            {task.wrikeLocation}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="w-24 shrink-0">
                      <TableSearchableSelect
                        options={TIME_OPTIONS}
                        value={"none"}
                        onChange={(val) =>
                          handleModalTimeChange(task, activeDay, val)
                        }
                        placeholder="none"
                        dropdownId={`reminder-time-${task.id}`}
                        activeDropdown={activeDropdown}
                        setActiveDropdown={setActiveDropdown}
                        isTime={true}
                        isDarkModal={true}
                      />
                    </div>
                  </div>
                ))
              )}
            </div>
            {/* Footer */}
            <div className="px-4 pb-4 pt-2 border-t border-white/5">
              <button
                onClick={() => setShowReminderModal(false)}
                className="w-full py-2 text-xs font-semibold text-slate-500 hover:text-slate-300 transition-colors rounded-xl hover:bg-white/5"
              >
                Got it, close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- DESIGN PACK: PREMIUM MODERN WRIKE TIMESHEET MODAL --- */}
      {isWrikeModalOpen && (
        <div className="fixed inset-0 z-[99999] bg-[#0b0f17]/95 backdrop-blur-xl flex flex-col text-slate-300 animate-in fade-in duration-200">
          {/* Header */}
          <div className="bg-[#121824]/90 border-b border-[#222f3e] px-8 py-5 flex justify-between items-center shrink-0 shadow-lg relative z-10 backdrop-blur-md">
            <div className="flex items-center gap-8">
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 rounded-full bg-[#12a0e1] shadow-[0_0_12px_#12a0e1]"></div>
                <h1 className="text-xl font-black text-white tracking-tight uppercase">
                  Wrike Hub
                </h1>
              </div>
              <div className="flex gap-1.5 p-1 bg-[#090d14] rounded-xl border border-[#1e293b]">
                <button
                  onClick={() => setModalTab("timesheet")}
                  className={`px-4 py-1.5 text-xs font-black tracking-wide uppercase transition-[background-color,color,box-shadow] rounded-lg ${
                    modalTab === "timesheet"
                      ? "bg-[#12a0e1] text-white shadow-md"
                      : "text-slate-500 hover:text-slate-300"
                  }`}
                >
                  My Timesheet
                </button>
                <button
                  onClick={() => setShowReminderModal(true)}
                  className="px-4 py-1.5 text-xs font-black tracking-wide uppercase transition-[color] rounded-lg flex items-center gap-2 text-slate-500 hover:text-slate-300"
                >
                  Reminders
                  {unloggedTasks.length > 0 && (
                    <span className="bg-amber-500/80 text-white text-[10px] font-black px-2 py-0.5 rounded-full leading-none">
                      {unloggedTasks.length}
                    </span>
                  )}
                </button>
              </div>
            </div>
            <button
              onClick={() => setIsWrikeModalOpen(false)}
              className="p-2.5 bg-[#1a2333] hover:bg-[#253247] border border-[#2d3d52] text-slate-400 hover:text-white rounded-xl transition-[background-color,color,box-shadow,transform] shadow-md active:scale-95"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Sub Header */}
          {modalTab === "timesheet" && (
            <div className="bg-[#121824]/50 border-b border-[#222f3e] px-8 py-3 flex items-center justify-between gap-6 text-xs font-bold uppercase tracking-wider shrink-0 text-slate-400">
              <span className="flex items-center gap-2.5">
                <div className="w-6 h-6 bg-gradient-to-tr from-[#12a0e1] to-[#1cc1a5] rounded-lg flex items-center justify-center text-white text-xs font-black shadow-md shadow-[#12a0e1]/10">
                  {wrikeFullName.charAt(0)}
                </div>
                <span className="text-slate-200">{wrikeFullName}</span>
              </span>
              <span className="flex items-center gap-2 bg-[#090d14] px-3 py-1.5 rounded-lg border border-[#1e293b]">
                <RefreshCw
                  className={`w-3.5 h-3.5 text-[#1cc1a5] ${
                    isFetchingModalData ? "animate-spin" : ""
                  }`}
                />
                Current Reporting Week
              </span>
            </div>
          )}

          {/* Table Container */}
          <div className="flex-1 overflow-auto bg-[#0b0f17] custom-scrollbar">
            {/* TIMESHEET TAB */}
            {modalTab === "timesheet" && (
              <table className="w-full text-left text-[12px] border-collapse whitespace-nowrap [&_td]:overflow-hidden" style={{ tableLayout: "fixed", minWidth: `${WRIKE_TS_COLS.reduce((s, c) => s + wtWidths[c.key], 0)}px` }}>
                <colgroup>
                  {WRIKE_TS_COLS.map((c) => <col key={c.key} style={{ width: wtWidths[c.key] }} />)}
                </colgroup>
                <thead className="bg-[#121824] text-slate-400 font-bold uppercase tracking-wider sticky top-0 z-20 shadow-md border-b border-[#222f3e]">
                  <tr>
                    <th className="relative px-5 py-3.5 border-r border-[#222f3e] overflow-hidden">
                      Assignment Title{wtHandle("title")}
                    </th>
                    <th className="relative px-5 py-3.5 border-r border-[#222f3e] overflow-hidden">
                      Status{wtHandle("status")}
                    </th>
                    <th className="relative px-5 py-3.5 border-r border-[#222f3e] overflow-hidden">
                      Category Link{wtHandle("category")}
                    </th>
                    <th className="relative px-5 py-3.5 border-r border-[#222f3e] overflow-hidden">
                      Job Key{wtHandle("jobkey")}
                    </th>
                    <th className="relative px-5 py-3.5 border-r border-[#222f3e] overflow-hidden">
                      Due Date{wtHandle("due")}
                    </th>
                    <th className="relative px-5 py-3.5 border-r border-[#222f3e] overflow-hidden">
                      Location{wtHandle("location")}
                    </th>
                    {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d, i) => {
                      const dayName = DAYS[i];
                      const isCurrent = todayDayName === dayName;
                      const isEnd = d === "Sa" || d === "Su";
                      return (
                        <th
                          key={d}
                          className={`relative px-4 py-3.5 border-r border-[#222f3e] text-center overflow-hidden last:border-r-0 ${
                            isCurrent
                              ? "bg-[#12a0e1]/15 text-[#38bdf8] font-black"
                              : isEnd
                              ? "text-rose-400/60"
                              : ""
                          }`}
                        >
                          {d}{wtHandle(`day_${d}`)}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1e293b]/60">
                  {isFetchingModalData ? (
                    <tr>
                      <td
                        colSpan="12"
                        className="text-center py-24 text-slate-500 font-medium italic"
                      >
                        Synchronizing week metrics with Wrike...
                      </td>
                    </tr>
                  ) : Object.keys(wrikeTimesheetData).length === 0 ? (
                    <tr>
                      <td
                        colSpan="12"
                        className="text-center py-24 text-slate-500 font-medium italic"
                      >
                        No workspace records detected.
                      </td>
                    </tr>
                  ) : (
                    Object.entries(wrikeTimesheetData)
                      // --- SMART SORTING ALGORITHM FOR GROUPS ---
                      .sort((a, b) => {
                        const minDueA = Math.min(
                          ...a[1].map((t) => getTaskSortValues(t).due)
                        );
                        const minDueB = Math.min(
                          ...b[1].map((t) => getTaskSortValues(t).due)
                        );

                        if (minDueA !== minDueB) return minDueA - minDueB;

                        const maxCreatedA = Math.max(
                          ...a[1].map((t) => getTaskSortValues(t).created)
                        );
                        const maxCreatedB = Math.max(
                          ...b[1].map((t) => getTaskSortValues(t).created)
                        );

                        if (maxCreatedA !== maxCreatedB)
                          return maxCreatedB - maxCreatedA;

                        return a[0].localeCompare(b[0]);
                      })
                      .map(([groupName, tasks]) => {
                        // --- SMART SORTING ALGORITHM FOR TASKS INSIDE GROUPS ---
                        const sortedTasks = [...tasks].sort((tA, tB) => {
                          const datesA = getTaskSortValues(tA);
                          const datesB = getTaskSortValues(tB);

                          if (datesA.due !== datesB.due)
                            return datesA.due - datesB.due;
                          return datesB.created - datesA.created;
                        });

                        return (
                          <React.Fragment key={groupName}>
                            {/* Group Header Row */}
                            <tr
                              className="bg-[#141b27] hover:bg-[#1a2436] transition-[background-color] cursor-pointer border-y border-[#222f3e]"
                              onClick={() => toggleGroup(groupName)}
                            >
                              <td
                                colSpan="6"
                                className="px-5 py-2.5 border-r border-[#222f3e] font-black text-slate-200 tracking-tight text-xs"
                              >
                                <div className="flex items-center gap-2.5">
                                  {expandedGroups[groupName] ? (
                                    <ChevronDown className="w-4 h-4 text-[#12a0e1]" />
                                  ) : (
                                    <ChevronRight className="w-4 h-4 text-slate-500" />
                                  )}
                                  <span>{groupName}</span>
                                  <span className="bg-[#090d14] text-slate-500 font-bold px-2 py-0.5 rounded-full text-[10px] border border-[#1e293b]">
                                    {tasks.length}
                                  </span>
                                </div>
                              </td>
                              {DAYS.map((d) => (
                                <td
                                  key={d}
                                  className={`border-r border-[#222f3e] last:border-r-0 ${
                                    todayDayName === d
                                      ? "bg-[#12a0e1]/8"
                                      : "bg-[#0f141f] opacity-40"
                                  }`}
                                ></td>
                              ))}
                            </tr>

                            {/* Child Rows */}
                            {expandedGroups[groupName] &&
                              sortedTasks.map((task) => {
                                const isAddedToActiveDay = rows.some(
                                  (r) =>
                                    r.taskId === task.id &&
                                    r.dayOfWeek === activeDay
                                );

                                return (
                                  <tr
                                    key={task.id}
                                    className={`transition-[background-color] group border-b border-[#1e293b]/40 ${
                                      isAddedToActiveDay
                                        ? "bg-[#10b981]/15 hover:bg-[#10b981]/25 border-l-2 border-l-[#10b981] shadow-[inset_0_0_15px_rgba(52,211,153,0.05)] text-emerald-100"
                                        : "hover:bg-[#121824]"
                                    }`}
                                  >
                                    <td
                                      className="px-5 py-3 border-r border-[#222f3e] truncate max-w-[320px] pl-10 font-medium"
                                      title={task.title}
                                    >
                                      {task.permalink ? (
                                        <a
                                          href={task.permalink}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="hover:text-[#12a0e1] transition-colors hover:underline underline-offset-2"
                                          onClick={(e) => e.stopPropagation()}
                                        >
                                          {task.title}
                                        </a>
                                      ) : (
                                        task.title
                                      )}
                                    </td>
                                    <td className="px-5 py-3 border-r border-[#222f3e] align-middle">
                                      <span
                                        className={getDarkTagStyle(
                                          task.wrikeStatus
                                        )}
                                      >
                                        {task.wrikeStatus}
                                      </span>
                                    </td>
                                    <td className="px-3 py-1 border-r border-[#222f3e] align-middle w-[240px]">
                                      <TableSearchableSelect
                                        options={CATEGORIES}
                                        value={task.wrikeCategory}
                                        onChange={(val) =>
                                          handleModalCategoryChange(
                                            groupName,
                                            task.id,
                                            val
                                          )
                                        }
                                        placeholder="Category"
                                        isGrouped={true}
                                        dropdownId={`modal-category-${task.id}`}
                                        activeDropdown={activeDropdown}
                                        setActiveDropdown={setActiveDropdown}
                                        isCategory={true}
                                        isDarkModal={true}
                                      />
                                    </td>
                                    <td className="px-5 py-3 border-r border-[#222f3e] font-mono text-[11px] text-slate-500 font-semibold">
                                      {task.wrikeJob}
                                    </td>
                                    <td className="px-5 py-3 border-r border-[#222f3e] w-[110px]">
                                      {task.dueDate ? (
                                        (() => {
                                          const [y, m, d] = task.dueDate
                                            .split("T")[0]
                                            .split("-")
                                            .map(Number);
                                          const due = new Date(y, m - 1, d);
                                          const today = new Date();
                                          today.setHours(0, 0, 0, 0);
                                          const diffDays = Math.round(
                                            (due - today) / 86400000
                                          );
                                          const label = due.toLocaleDateString(
                                            "en-GB",
                                            { day: "numeric", month: "short" }
                                          );
                                          const isOverdue = diffDays < 0;
                                          const isToday = diffDays === 0;
                                          const isTomorrow = diffDays === 1;
                                          return (
                                            <span
                                              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold border w-fit ${
                                                isOverdue
                                                  ? "bg-rose-500/10 text-rose-400 border-rose-500/20"
                                                  : isToday
                                                  ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                                                  : isTomorrow
                                                  ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/20"
                                                  : "bg-[#1e2530] text-slate-400 border-[#2d3748]"
                                              }`}
                                            >
                                              {label}
                                              {isOverdue && (
                                                <span className="text-[10px] font-black uppercase tracking-wider text-rose-500">
                                                  overdue
                                                </span>
                                              )}
                                              {isToday && (
                                                <span className="text-[10px] font-black uppercase tracking-wider text-amber-500">
                                                  today
                                                </span>
                                              )}
                                              {isTomorrow && (
                                                <span className="text-[10px] font-black uppercase tracking-wider text-yellow-500">
                                                  tmrw
                                                </span>
                                              )}
                                            </span>
                                          );
                                        })()
                                      ) : (
                                        <span className="text-slate-600 text-[11px]">
                                          —
                                        </span>
                                      )}
                                    </td>
                                    <td className="px-5 py-3 border-r border-[#222f3e]">
                                      {task.wrikeLocation !==
                                        "⚠️ Unassigned" && (
                                        <span className="bg-[#1e2530] text-slate-300 px-2.5 py-1 rounded-lg text-[11px] font-bold border border-[#2d3748] shadow-sm flex items-center gap-1.5 w-fit">
                                          {TERRITORY_FLAGS[task.wrikeLocation]}{" "}
                                          {task.wrikeLocation}
                                        </span>
                                      )}
                                    </td>

                                    {renderDayCell(task, "Monday")}
                                    {renderDayCell(task, "Tuesday")}
                                    {renderDayCell(task, "Wednesday")}
                                    {renderDayCell(task, "Thursday")}
                                    {renderDayCell(task, "Friday")}
                                    {renderDayCell(task, "Saturday")}
                                    {renderDayCell(task, "Sunday")}
                                  </tr>
                                );
                              })}
                          </React.Fragment>
                        );
                      })
                  )}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* --- HEADER --- */}
      <PageHeader pageId="legacy" icon={Database} title="Weekly Timesheet" subtitle={weekDateRange}>
        <div className="flex items-center gap-2 text-[13px] text-white/85 font-medium">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
          Welcome Back, {wrikeFullName ? wrikeFullName : "Loading..."}
        </div>
      </PageHeader>

      {/* Everything below the full-bleed header gets the page's horizontal
          gutter + top/bottom spacing — the header itself must stay outside
          any padded container to remain edge-to-edge. px/py match Job Book,
          Today's List and Management exactly; this page used to sit tighter
          (pt-3 pb-4) and read as misaligned when moving between them. */}
      <div className="px-4 sm:px-6 py-6">
        {/* New week banner */}
        {newWeekBanner && (
          <div className="max-w-[1800px] mx-auto mb-3 flex items-center gap-3 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-2xl shadow-sm">
            <span className="text-lg">🗓️</span>
            <div className="flex-1">
              <span className="font-black text-emerald-900 text-sm">New week!</span>
              <span className="text-emerald-800 text-sm ml-1.5">Last week's entries are hidden here but still saved — they show up in the Jobs Feed.</span>
            </div>
            <button
              onClick={dismissNewWeekBanner}
              className="px-3 py-1.5 text-emerald-700 hover:text-emerald-900 text-sm font-bold rounded-xl transition-colors"
            >
              Got it
            </button>
          </div>
        )}

      {/* --- STANDARD UI --- */}
      <div className="max-w-[1800px] mx-auto bg-white shadow-sm rounded-2xl relative flex flex-col border border-[#dce4ec]">
        {/* --- MODERN TABS --- */}
        <div className="flex px-4 pt-4 bg-slate-50 gap-2 rounded-t-2xl">
          {DAYS.map((day) => {
            const isWeekend = day === "Saturday" || day === "Sunday";
            const isActive = activeDay === day;

            // Original light folder tabs; the strip's border-b is the thin
            // line the light bleeds into, sitting just above the dark table
            // header.
            let tabColors = "";
            if (isActive) {
              tabColors = isWeekend
                ? "bg-white text-rose-500 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] border-t border-x border-[#dce4ec]"
                : "bg-white text-[#12a0e1] shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] border-t border-x border-[#dce4ec]";
            } else {
              tabColors = isWeekend
                ? "bg-rose-50 text-rose-400 hover:bg-rose-100 hover:text-rose-600 border-t border-x border-transparent"
                : "bg-slate-100 text-[#768994] hover:bg-slate-200 hover:text-[#122027] border-t border-x border-transparent";
            }

            return (
              <button
                key={day}
                onClick={() => setActiveDay(day)}
                className={`flex-1 py-3 text-[13px] font-bold text-center rounded-t-xl transition-[background-color,color,border-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#12a0e1]/40 ${tabColors} ${
                  isActive ? "relative z-10 top-[1px]" : ""
                }`}
              >
                <div className="flex flex-col items-center gap-0.5">
                  <div className="flex items-center justify-center gap-1.5">
                    {frozenDays[day] && <Lock className="w-3 h-3 opacity-60" />}
                    {day}
                    {rows.filter((r) => r.dayOfWeek === day).length > 0 && (
                      <span
                        className={`ml-1.5 text-[10px] px-2 py-0.5 rounded-full ${
                          isActive
                            ? isWeekend
                              ? "bg-rose-100 text-rose-600"
                              : "bg-[#12a0e1]/10 text-[#12a0e1]"
                            : isWeekend
                            ? "bg-rose-200/50 text-rose-500"
                            : "bg-slate-200 text-[#768994]"
                        }`}
                      >
                        {rows.filter((r) => r.dayOfWeek === day).length}
                      </span>
                    )}
                  </div>
                  {getDayTotal(day) > 0 && (
                    <span
                      className={`text-[10px] font-mono font-bold ${
                        isActive
                          ? isWeekend
                            ? "text-rose-500"
                            : "text-[#12a0e1]"
                          : "text-[#768994]"
                      }`}
                    >
                      {formatDayTotal(getDayTotal(day))}h
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {/* Fade band from the light tabs down into the dark table header —
            white at the top, the header's shade at the bottom. */}
        {/* 14px white run, then a thin animated teal gradient line — the page
            header's cyan→teal, flowing — before the dark table header. */}
        <div aria-hidden="true" className="h-[10px] bg-white border-t border-[#dce4ec]" />
        <div
          aria-hidden="true"
          className="h-px bg-gradient-to-r from-[#12a0e1] via-[#1cc1a5] to-[#12a0e1] animate-gradient-flow"
          style={{ backgroundSize: "200% 100%" }}
        />

        {/* --- TABLE AREA --- */}
        <div ref={consolScrollRef} className="flex-1 bg-white relative overflow-x-auto w-full min-h-[600px]">
          <table className="w-full text-left text-[12px] border-collapse [&_td]:overflow-hidden" style={{ tableLayout: "fixed", minWidth: `${consolTotal}px` }}>
            <colgroup>
              {CONSOL_COLS.map((c) => <col key={c.key} style={{ width: consolWidths[c.key] }} />)}
            </colgroup>
            <thead className="sticky top-0 z-20">
              <tr className="bg-[#0d1b22] text-white shadow-sm border-b border-white/10">
                {/* Headers wrap rather than truncate — a squeezed column showed
                    "ADDITIONA" with no way to tell what it was. Vertically
                    centred so single-line and stacked labels (Add. Time, Time
                    Spent) sit on the same middle line. */}
                {CONSOL_COLS.map((c, idx) => (
                  <th
                    key={c.key}
                    className={`relative px-3 py-2 text-center text-[10px] font-black uppercase tracking-widest leading-[1.2] align-middle ${
                      idx === CONSOL_COLS.length - 1 ? "" : "border-r border-white/5"
                    }`}
                  >
                    {/* "Add. Time" stacks so the full stop ends its own line,
                        matching the two-line Time Spent / Client Amends labels. */}
                    {/* Select-all lives in the first header cell rather than in
                        a column of its own — the colgroup drives the resizable
                        widths, so a new column would have to be threaded
                        through every row's cells and every saved width. */}
                    {idx === 0 && rowsAreEditable && selectableIds.length > 0 && (
                      <button
                        onClick={toggleSelectAll}
                        aria-pressed={allSelected}
                        aria-label="Select every row on this day"
                        title={allSelected ? "Clear selection" : "Select every row on this day"}
                        className="absolute left-0 top-0 bottom-0 w-6 flex items-center justify-center hover:bg-white/10 transition-colors"
                      >
                        <span
                          className={`w-[13px] h-[13px] rounded-[4px] border flex items-center justify-center transition-colors ${
                            allSelected ? "bg-[#12a0e1] border-[#12a0e1]" : "border-white/40"
                          }`}
                        >
                          {allSelected && <Check className="w-2.5 h-2.5 text-white" strokeWidth={4} />}
                        </span>
                      </button>
                    )}
                    {c.label === "Add. Time" ? (
                      <span className="block leading-tight">
                        <span className="block">Add.</span>
                        <span className="block">Time</span>
                      </span>
                    ) : (
                      c.label
                    )}
                    {consolHandle(c.key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f0f4f8]">
              {showConsolidationWarning && (
                <tr>
                  <td
                    colSpan={COLUMNS.length + 1}
                    className="px-4 py-2 bg-amber-50 border-b border-amber-200"
                  >
                    <div className="text-[11px] font-bold text-amber-700 flex items-center gap-2 flex-wrap">
                      <span>
                        ⚠️ Some rows share the same job/territory/category — time
                        totals may appear inflated due to per-row rounding.
                      </span>
                      <button
                        onClick={() => setConsolidatedView(true)}
                        className="ml-auto shrink-0 flex items-center gap-1.5 bg-amber-600 hover:bg-amber-700 text-white text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-lg transition-colors active:scale-95"
                      >
                        <Layers className="w-3 h-3" />
                        Consolidate
                      </button>
                    </div>
                  </td>
                </tr>
              )}
              {renderItems.map((item) => {
                // ── Group header row (consolidated view) ─────────────────────
                if (item.type === "group") {
                  const g = item.group;
                  const collapsed = collapsedGroups[g.jobNumber];
                  return (
                    <tr key={g.id} className="bg-slate-50 border-y border-[#dce4ec]">
                      {/* overflow-visible (inline, to beat the table's [&_td]:overflow-hidden)
                          so the multi-country add popover isn't clipped by the cell. */}
                      <td className="p-2 border-r border-[#dce4ec] align-middle" style={{ overflow: "visible" }}>
                        <div className="flex items-center gap-1.5 pl-1">
                          <button
                            onClick={() => toggleJobGroup(g.jobNumber)}
                            className="w-5 h-5 grid place-items-center rounded-md text-[#768994] hover:text-[#12a0e1] hover:bg-white transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#12a0e1]/40"
                            title={collapsed ? "Expand" : "Collapse"}
                          >
                            <ChevronRight className={`w-3.5 h-3.5 transition-transform duration-300 ${collapsed ? "" : "rotate-90"}`} />
                          </button>
                          {g.jobNumber ? (
                            <span className="font-black text-[12px] text-[#122027] truncate">
                              {g.jobNumber}
                            </span>
                          ) : (
                            <div className="flex-1 min-w-0">
                              <TableSearchableSelect
                                options={jobOptions}
                                value=""
                                onChange={(val) => {
                                  if (val) g._subRows.forEach((sub) => handleUpdateRow(sub.id, "jobNumber", val));
                                }}
                                placeholder="Set job for these entries…"
                                isGrouped={true}
                                dropdownId={`job-grp-${g.id}`}
                                activeDropdown={activeDropdown}
                                setActiveDropdown={setActiveDropdown}
                                isJob={true}
                                disabled={!rowsAreEditable}
                              />
                            </div>
                          )}
                          <span className="text-[10px] font-black text-[#768994] bg-white border border-[#dce4ec] rounded-full px-1.5 py-0.5 shrink-0">
                            {g._subRows.length}
                          </span>
                          {rowsAreEditable && (
                            <div className="ml-auto shrink-0 relative">
                              <button
                                onClick={(e) => openAddPopover(g.jobNumber, e)}
                                title="Add entries to this job"
                                className={`rounded-md w-5 h-5 grid place-items-center transition-colors ${
                                  addEntryFor === g.jobNumber
                                    ? "bg-[#12a0e1] text-white"
                                    : "text-[#12a0e1] hover:bg-[#12a0e1]/10"
                                }`}
                              >
                                <Plus className="w-3.5 h-3.5" />
                              </button>
                              {addEntryFor === g.jobNumber && (
                                <>
                                  <div
                                    className="fixed inset-0 z-[99998]"
                                    onClick={() => setAddEntryFor(null)}
                                  />
                                  <div
                                    style={{ position: "fixed", left: addEntryPos?.left, top: addEntryPos?.top, width: addEntryPos?.width, zIndex: 99999 }}
                                    className="bg-white border border-[#dce4ec] rounded-xl shadow-2xl p-2.5 text-left animate-in fade-in slide-in-from-top-1 duration-150"
                                  >
                                    <button
                                      onClick={() => {
                                        addEntryToGroup(g);
                                        setAddEntryFor(null);
                                      }}
                                      className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[12px] font-bold text-slate-700 hover:bg-[#12a0e1]/10 hover:text-[#12a0e1] transition-colors"
                                    >
                                      <Plus className="w-3.5 h-3.5" /> One blank entry
                                    </button>
                                    <div className="my-1.5 border-t border-[#f0f4f8]" />
                                    <p className="px-1.5 py-1 text-[10px] font-black uppercase tracking-widest text-[#768994]">
                                      One entry, several countries
                                    </p>
                                    <input
                                      value={countryQuery}
                                      onChange={(e) => setCountryQuery(e.target.value)}
                                      placeholder="Filter countries…"
                                      className="w-full mb-1.5 px-2.5 py-1.5 text-[11px] font-semibold rounded-lg border border-[#dce4ec] outline-none focus:border-[#12a0e1] focus:ring-2 focus:ring-[#12a0e1]/10"
                                    />
                                    <div className="max-h-44 overflow-y-auto custom-scrollbar pr-0.5">
                                      {TERRITORIES.filter(
                                        (t) =>
                                          t.toLowerCase().includes(countryQuery.trim().toLowerCase()) ||
                                          territoryCode(t).toLowerCase().includes(countryQuery.trim().toLowerCase())
                                      ).map((t) => {
                                        const on = multiCountrySel.includes(t);
                                        return (
                                          <button
                                            key={t}
                                            onClick={() =>
                                              setMultiCountrySel((prev) =>
                                                on ? prev.filter((x) => x !== t) : [...prev, t]
                                              )
                                            }
                                            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-[11px] font-semibold transition-colors ${
                                              on
                                                ? "bg-[#12a0e1]/10 text-[#12a0e1]"
                                                : "text-slate-600 hover:bg-slate-50"
                                            }`}
                                          >
                                            <span className={`w-3.5 h-3.5 rounded border grid place-items-center shrink-0 ${on ? "bg-[#12a0e1] border-[#12a0e1] text-white" : "border-slate-300"}`}>
                                              {on && <CheckCircle className="w-2.5 h-2.5" />}
                                            </span>
                                            <span className="shrink-0">{TERRITORY_FLAGS[t]}</span>
                                            <span className="truncate">{t}</span>
                                            {territoryCode(t) && (
                                              <span className={`ml-auto shrink-0 font-mono text-[10px] tracking-wide ${on ? "opacity-70" : "text-slate-400"}`}>
                                                {territoryCode(t)}
                                              </span>
                                            )}
                                          </button>
                                        );
                                      })}
                                    </div>
                                    <button
                                      disabled={!multiCountrySel.length}
                                      onClick={() => addMultiCountryEntry(g, multiCountrySel)}
                                      className={`w-full mt-2 px-3 py-2 rounded-lg text-[11px] font-black transition-colors ${
                                        multiCountrySel.length
                                          ? "bg-[#12a0e1] text-white hover:bg-[#0e8bc4]"
                                          : "bg-slate-100 text-slate-300 cursor-not-allowed"
                                      }`}
                                    >
                                      Add entry{multiCountrySel.length ? ` · ${multiCountrySel.length} ${multiCountrySel.length === 1 ? "country" : "countries"}` : ""}
                                    </button>
                                  </div>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="p-2 border-r border-[#dce4ec] align-middle text-[12px] font-semibold text-[#768994] truncate px-3">{g.client}</td>
                      <td className="p-2 border-r border-[#dce4ec] align-middle text-[12px] font-black text-[#122027] truncate px-3">{g.filmTitle}</td>
                      <td className="p-2 border-r border-[#dce4ec] align-middle text-[11px] text-[#768994] truncate px-3">{g.projectDescription}</td>
                      <td className="p-2 border-r border-[#dce4ec] align-middle text-[11px] text-[#768994] px-3">
                        {g.territories.length ? (
                          <span className="flex flex-wrap items-center gap-x-1 gap-y-0.5" title={g.territories.join(", ")}>
                            <span className="text-[13px] leading-none">{territoryFlags(g.territories, 12)}</span>
                            <span>{g.territories.length} {g.territories.length === 1 ? "country" : "countries"}</span>
                          </span>
                        ) : "—"}
                      </td>
                      <td className="p-2 border-r border-[#dce4ec] align-middle text-[11px] text-[#768994] px-3">
                        {g.categories.length ? `${g.categories.length} ${g.categories.length === 1 ? "category" : "categories"}` : "—"}
                      </td>
                      <td className="p-2 border-r border-[#dce4ec]" />
                      <td className="p-2 border-r border-[#dce4ec]" />
                      <td className="p-2 border-r border-[#dce4ec]" />
                      <td className="p-2 border-r border-[#dce4ec] align-middle text-center text-[12px] font-black text-[#122027] tabular-nums">{g.timeSpent}</td>
                      <td className="p-2 align-middle text-center text-[12px] font-black text-[#122027] tabular-nums">{g.additionalTime}</td>
                    </tr>
                  );
                }

                // ── Editable data row (a flat row, or a group's subrow) ──────
                const row = item.row;
                const isSub = item.type === "sub";
                return (
                <tr
                  key={row.id}
                  className={`timesheet-row transition-colors group relative ${
                    !rowsAreEditable ? "frozen-row" : ""
                  } ${isSub ? "bg-white" : ""} ${
                    // The gutter tick is 13px; on a wide table that is not
                    // enough to tell at a glance which rows a bulk edit is
                    // about to hit. Tinting the row itself is.
                    selectedRowIds.has(row.id) ? "!bg-[#12a0e1]/[0.07]" : ""
                  }`}
                >
                  <td className={`p-2 border-r border-[#f0f4f8] align-middle min-w-[240px] ${isSub ? "bg-slate-50/40" : ""}`}>
                    {/* Save confirmation. Absolute against the row (the <tr> is
                        position:relative), so it sweeps the full width from
                        inside the first cell — a <tr> can only hold cells, so it
                        can't live directly on the row.
                        Keyed by the nonce: React remounts it on each save, which
                        restarts the animation. Re-applying a class would not,
                        and a fast tab across cells saves the same row twice in
                        well under a second. */}
                    {justSaved?.[row.id] && (
                      <span key={justSaved[row.id]} className="row-saved-flash" aria-hidden="true" />
                    )}
                    {/* Selection gutter. Absolutely positioned against the row
                        (the <tr> is position:relative) so it reads as a strip
                        down the left edge of the TABLE rather than as a control
                        sitting inside the Job Number cell. The cell's own
                        content is inset by the same amount below, so nothing is
                        covered and the gutter is the only thing living there.
                        A styled box, not <input type=checkbox> — the native one
                        renders as OS chrome that ignores the rest of the grid's
                        design. */}
                    {rowsAreEditable && (
                      <button
                        onClick={() => toggleRowSelected(row.id)}
                        aria-pressed={selectedRowIds.has(row.id)}
                        aria-label="Select row for batch edit"
                        title="Select for batch edit"
                        className={`absolute left-0 top-0 bottom-0 w-6 flex items-center justify-center transition-colors z-[1] ${
                          selectedRowIds.has(row.id) ? "bg-[#12a0e1]/10" : "hover:bg-slate-100"
                        }`}
                      >
                        <span
                          className={`w-[13px] h-[13px] rounded-[4px] border flex items-center justify-center transition-[background-color,border-color,opacity] duration-150 ${
                            selectedRowIds.has(row.id)
                              ? "bg-[#12a0e1] border-[#12a0e1]"
                              : "border-[#c2d0da] bg-white opacity-0 group-hover:opacity-100"
                          }`}
                        >
                          {selectedRowIds.has(row.id) && (
                            <Check className="w-2.5 h-2.5 text-white" strokeWidth={4} />
                          )}
                        </span>
                      </button>
                    )}
                    <div className={`flex items-start gap-2 ${rowsAreEditable ? "pl-6" : "pl-1"}`}>
                      <button
                        onClick={() => handleDeleteRow(row.id)}
                        disabled={!rowsAreEditable}
                        title={rowsAreEditable ? "Delete row" : undefined}
                        className={`mt-1.5 transition-opacity ${
                          !rowsAreEditable
                            ? "opacity-0 cursor-not-allowed"
                            : "opacity-0 group-hover:opacity-70 hover:!opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[#12a0e1]/40 focus-visible:outline-none"
                        }`}
                      >
                        <XCircle
                          className={`w-5 h-5 ${
                            !rowsAreEditable
                              ? "text-slate-400"
                              : "text-rose-500 fill-rose-100"
                          }`}
                        />
                      </button>
                      <div className="flex flex-col w-full">
                        {isSub ? (
                          // The job is set once at the group top, never per subrow —
                          // the subrow just carries its own country/category identity.
                          <div className="flex items-center gap-1.5 pl-3 py-1 min-w-0" title={row.territory}>
                            <span className="text-[#768994] text-[11px] shrink-0">↳</span>
                            {/* Capped: this sits on one line next to the category,
                                so a 20-country row can't be allowed to run away. */}
                            <span className="text-[13px] leading-none shrink-0">{territoryFlags(row.territory, 6) || "🌐"}</span>
                            <span className="text-[11px] font-bold text-[#768994] truncate">
                              {splitTerritories(row.territory).length > 6
                                ? `${splitTerritories(row.territory).length} countries`
                                : row.territory || "No country"}
                              {row.category ? <span className="font-medium text-[#768994]"> · {row.category.replace(/^(Digital|Print|XYi)\s*-\s*/, "")}</span> : null}
                            </span>
                          </div>
                        ) : (
                          <div className={`flex items-center gap-1.5 w-full min-w-0 ${isSub ? "pl-2" : ""}`}>
                            {isSub && <span className="text-[#768994] text-[11px] shrink-0" title="Set a job for this entry">↳</span>}
                            <div className="flex-1 min-w-0">
                              <TableSearchableSelect
                                options={jobOptions}
                                value={row.jobNumber}
                                onChange={(val) =>
                                  handleUpdateRow(row.id, "jobNumber", val)
                                }
                                placeholder={isSub ? "Set job…" : "Select Job..."}
                                isGrouped={true}
                                dropdownId={`job-${row.id}`}
                                activeDropdown={activeDropdown}
                                setActiveDropdown={setActiveDropdown}
                                isJob={true}
                                disabled={!rowsAreEditable}
                              />
                            </div>
                          </div>
                        )}
                        {row.wrikeTimelogId && (
                          <span className="text-[10px] font-bold text-emerald-600 ml-2 mt-0.5 flex items-center gap-1 opacity-80">
                            <CheckCircle className="w-3 h-3" /> Wrike Synced
                          </span>
                        )}
                      </div>
                    </div>
                  </td>

                  <td className="p-2 border-r border-[#f0f4f8] align-middle w-[140px]">
                    <div
                      className={`text-[12px] leading-tight font-semibold px-2 ${
                        !rowsAreEditable ? "text-[#768994]" : "text-[#122027]"
                      }`}
                    >
                      {row.client}
                    </div>
                  </td>

                  <td className="p-2 border-r border-[#f0f4f8] align-middle w-[150px]">
                    <div
                      className={`text-[12px] leading-tight font-black px-2 ${
                        !rowsAreEditable ? "text-[#768994]" : "text-[#122027]"
                      }`}
                    >
                      {row.filmTitle}
                    </div>
                  </td>

                  <td className="p-2 border-r border-[#f0f4f8] align-middle w-[220px]">
                    <AutoGrowTextarea
                      rows={2}
                      value={row.projectDescription}
                      onChange={(e) =>
                        handleUpdateRow(
                          row.id,
                          "projectDescription",
                          e.target.value
                        )
                      }
                      className={textAreaClass}
                      placeholder="Project description..."
                      disabled={!rowsAreEditable}
                    />
                  </td>

                  <td className="p-2 border-r border-[#f0f4f8] align-middle w-[140px]">
                    <MultiCountrySelect
                      value={row.territory}
                      onChange={(val) =>
                        handleUpdateRow(row.id, "territory", val)
                      }
                      placeholder="Country"
                      dropdownId={`country-${row.id}`}
                      activeDropdown={activeDropdown}
                      setActiveDropdown={setActiveDropdown}
                      disabled={!rowsAreEditable}
                      needsAttention={rowsAreEditable}
                    />
                  </td>

                  <td className="p-2 border-r border-[#f0f4f8] align-middle w-[180px]">
                    <TableSearchableSelect
                      options={CATEGORIES}
                      value={row.category}
                      onChange={(val) =>
                        handleUpdateRow(row.id, "category", val)
                      }
                      placeholder="Category"
                      isGrouped={true}
                      pinnedOptions={topCategories}
                      dropdownId={`category-${row.id}`}
                      activeDropdown={activeDropdown}
                      setActiveDropdown={setActiveDropdown}
                      isCategory={true}
                      disabled={!rowsAreEditable}
                    />
                  </td>

                  <td className="p-2 border-r border-[#f0f4f8] align-middle w-[70px] text-center">
                    <input
                      type="checkbox"
                      checked={row.clientAmends}
                      onChange={(e) =>
                        handleUpdateRow(
                          row.id,
                          "clientAmends",
                          e.target.checked
                        )
                      }
                      className={`w-4 h-4 rounded text-[#12a0e1] focus:ring-[#12a0e1] ${
                        !rowsAreEditable
                          ? "opacity-50 cursor-not-allowed"
                          : "cursor-pointer"
                      }`}
                      disabled={!rowsAreEditable}
                    />
                  </td>

                  <td className="p-2 border-r border-[#f0f4f8] align-middle w-[140px]">
                    <AutoGrowTextarea
                      value={row.notes || ""}
                      onChange={(e) =>
                        handleUpdateRow(row.id, "notes", e.target.value)
                      }
                      placeholder="Notes…"
                      rows={2}
                      disabled={!rowsAreEditable}
                      className={`w-full text-[11px] bg-transparent border border-transparent rounded-xl px-2 py-1 resize-none overflow-hidden transition-colors leading-relaxed placeholder:text-slate-500 ${
                        !rowsAreEditable
                          ? "text-slate-400 cursor-not-allowed"
                          : "text-[#122027] hover:border-[#dce4ec] focus:border-[#12a0e1] focus:bg-[#12a0e1]/5 outline-none"
                      }`}
                    />
                  </td>

                  <td className="p-2 border-r border-[#f0f4f8] align-middle w-[50px] text-center">
                    <input
                      type="checkbox"
                      checked={row.is3D}
                      onChange={(e) =>
                        handleUpdateRow(row.id, "is3D", e.target.checked)
                      }
                      className={`w-4 h-4 rounded text-[#12a0e1] focus:ring-[#12a0e1] ${
                        !rowsAreEditable
                          ? "opacity-50 cursor-not-allowed"
                          : "cursor-pointer"
                      }`}
                      disabled={!rowsAreEditable}
                    />
                  </td>

                  <td className="p-2 border-r border-[#f0f4f8] align-middle w-[90px] text-center">
                    <TableSearchableSelect
                      options={TIME_OPTIONS}
                      value={row.timeSpent}
                      onChange={(val) =>
                        handleUpdateRow(row.id, "timeSpent", val)
                      }
                      placeholder="none"
                      dropdownId={`time-${row.id}`}
                      activeDropdown={activeDropdown}
                      setActiveDropdown={setActiveDropdown}
                      isTime={true}
                      disabled={!rowsAreEditable}
                    />
                  </td>
                  <td className="p-2 align-middle w-[90px] text-center">
                    <TableSearchableSelect
                      options={TIME_OPTIONS}
                      value={row.additionalTime}
                      onChange={(val) =>
                        handleUpdateRow(row.id, "additionalTime", val)
                      }
                      placeholder="none"
                      dropdownId={`addTime-${row.id}`}
                      activeDropdown={activeDropdown}
                      setActiveDropdown={setActiveDropdown}
                      isTime={true}
                      disabled={!rowsAreEditable}
                    />
                  </td>
                </tr>
                );
              })}
              {/* Ghost Add Row */}
              {rowsAreEditable && (
                <tr
                  className="group/addrow border-t border-dashed border-[#dce4ec] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#12a0e1]/40"
                  onClick={handleAddRow}
                >
                  <td
                    colSpan={COLUMNS.length + 1}
                    className="px-4 py-3 text-center"
                  >
                    <span className="flex items-center justify-center gap-1.5 text-[11px] font-bold text-[#768994] group-hover/addrow:text-[#12a0e1] transition-colors">
                      <Plus className="w-3.5 h-3.5" />
                      Add row
                    </span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {displayRows.length === 0 && !isPulling && (
            <div className="flex flex-col items-center justify-center py-20 text-slate-400 w-full left-0 right-0 absolute">
              <RefreshCw className="w-10 h-10 mb-4 opacity-20" />
              <p className="text-sm font-bold text-slate-500 font-sans">
                Nothing logged for {activeDay} yet.
              </p>
              <p className="text-xs mt-1">Pull your times from Wrike below, or add a row to start.</p>
            </div>
          )}
        </div>

        {/* Day totals — visible in the table, not only on the tab */}
        {currentDayRows.length > 0 && (
          <div className="px-4 py-2.5 border-t border-[#dce4ec] bg-white flex items-center justify-end gap-6 text-[11px] font-bold text-[#768994]">
            <span className="uppercase tracking-widest text-[10px] font-black text-slate-400">{activeDay} total</span>
            <span className="tabular-nums">
              {currentDayRows.length} {currentDayRows.length === 1 ? "entry" : "entries"}
            </span>
            <span className="tabular-nums text-[#122027] text-sm font-black">
              {formatDayTotal(getDayTotal(activeDay))}h
            </span>
          </div>
        )}

        {/* Batch-edit bar. Replaces the tongue while rows are ticked rather
            than stacking above it: they occupy the same spot, and two floating
            bars competing for the same corner is worse than one that changes
            what it offers. */}
        {selectedCount > 0 && (
          <div className="relative z-20 -mb-4 flex justify-center pointer-events-none">
            <div className="pointer-events-auto flex items-center gap-2 bg-[#122027] text-white rounded-full shadow-lg px-2 py-1.5 animate-in fade-in slide-in-from-bottom-2 duration-200">
              <span className="text-[11px] font-black uppercase tracking-widest pl-2">
                {selectedCount} selected
              </span>
              <span className="w-px h-4 bg-white/20 shrink-0" />
              <BatchCategoryPicker
                pinned={topCategories}
                onPick={(val) => applyToSelected("category", val)}
              />
              <button
                onClick={clearSelection}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold text-white/60 hover:text-white transition-colors"
              >
                <X className="w-3.5 h-3.5" />
                Clear
              </button>
            </div>
          </div>
        )}

        {/* Bottom-centre "tongue" — Consolidated + Lock floating above the
            action bar, so the table's view controls cost no vertical space. */}
        <div className={`relative z-10 -mb-4 flex justify-center pointer-events-none ${selectedCount > 0 ? "hidden" : ""}`}>
          <div className="pointer-events-auto flex items-center gap-1 bg-white border border-[#dce4ec] rounded-full shadow-md px-1.5 py-1">
            <button
              onClick={() => setConsolidatedView((v) => !v)}
              title="Merge rows with the same job number — territories & categories become subrows, raw time summed before rounding"
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold transition-colors ${
                consolidatedView ? "text-[#12a0e1]" : "text-[#768994] hover:text-[#122027]"
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              Consolidated
              <span className={`ml-0.5 text-[10px] font-black px-1.5 py-0.5 rounded ${consolidatedView ? "bg-[#12a0e1] text-white" : "bg-slate-100 text-slate-600"}`}>
                {consolidatedView ? "ON" : "OFF"}
              </span>
            </button>
            <span className="w-px h-4 bg-[#dce4ec] shrink-0" />
            <button
              onClick={toggleFreeze}
              title={isDayFrozen ? "Unlock day to allow edits" : "Lock this day to prevent edits"}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold transition-colors ${
                isDayFrozen ? "text-amber-600" : "text-[#768994] hover:text-[#122027]"
              }`}
            >
              <Lock className="w-3.5 h-3.5" />
              {isDayFrozen ? `${activeDay} locked` : `Lock ${activeDay}`}
            </button>
            <span className="w-px h-4 bg-[#dce4ec] shrink-0" />
            <PullDefaultsPopover
              defaultCategory={defaultCategory}
              groupMultiCountry={groupMultiCountry}
              setPrefs={setPrefs}
            />
          </div>
        </div>

        {/* Bottom Action Bar */}
        <div className="p-4 border-t border-[#dce4ec] bg-slate-50 rounded-b-2xl flex flex-wrap gap-3 justify-between items-center">
          <button
            onClick={handleOpenWrikeModal}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold bg-white hover:bg-slate-50 text-[#122027] border border-[#dce4ec] rounded-xl shadow-sm transition-[background-color,transform] active:scale-95"
          >
            <LayoutList className="w-4 h-4" />
            Wrike Timesheets
          </button>
          <div className="flex gap-3 flex-wrap">
            <button
              onClick={() => handlePullTimes()}
              disabled={isPulling || isDayFrozen}
              title="Pulls your Wrike time for today and yesterday"
              className={`flex items-center gap-2 px-5 py-2.5 text-sm font-bold border rounded-xl shadow-sm transition-[background-color,color,border-color,transform] ${
                isDayFrozen
                  ? "bg-slate-100 text-[#768994] border-[#dce4ec] cursor-not-allowed opacity-70"
                  : "bg-white hover:bg-slate-50 text-[#122027] border-[#dce4ec] active:scale-95"
              }`}
            >
              <RefreshCw
                className={`w-4 h-4 ${
                  isPulling ? "animate-spin text-[#12a0e1]" : ""
                }`}
              />
              {isPulling ? "Pulling..." : "Pull Wrike Times"}
            </button>

            {/* isAdmin stays in the OR so the admin keeps the button without
                waiting on (or depending on) the profile read landing. */}
            {(isAdmin || canDebugPull) && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowDebugPull(!showDebugPull)}
                  disabled={isPulling}
                  title="Pull your Wrike timelogs for a specific date"
                  className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-bold rounded-xl border transition-[background-color,color,border-color,transform] active:scale-95 ${
                    showDebugPull
                      ? "bg-amber-100 text-amber-800 border-amber-300"
                      : "bg-amber-50 hover:bg-amber-100 text-amber-700 border-amber-200"
                  }`}
                >
                  <Calendar className="w-3.5 h-3.5" />
                  Debug Pull
                </button>
                {showDebugPull && (
                  <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-1.5">
                    <input
                      type="date"
                      value={debugDate}
                      max={new Date().toISOString().split("T")[0]}
                      onChange={(e) => setDebugDate(e.target.value)}
                      className="text-xs font-mono bg-transparent border-none outline-none text-amber-800"
                    />
                    <button
                      onClick={() => {
                        handlePullTimes(debugDate);
                        setShowDebugPull(false);
                      }}
                      disabled={isPulling || !debugDate}
                      className="text-xs font-bold text-amber-700 hover:text-amber-900 disabled:opacity-40 transition-colors"
                    >
                      Pull
                    </button>
                  </div>
                )}
              </div>
            )}

            <button
              onClick={handleCopyJSON}
              className={`flex items-center gap-2 px-5 py-2.5 text-sm font-bold rounded-xl shadow-sm transition-[background-color,box-shadow,transform] active:scale-95 ${
                jsonCopied
                  ? "bg-[#1cc1a5] text-white shadow-[#1cc1a5]/30"
                  : "bg-[#12a0e1] hover:bg-[#0d8bc4] text-white shadow-[#12a0e1]/30"
              }`}
            >
              {jsonCopied ? (
                <CheckCircle className="w-4 h-4" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
              {jsonCopied ? "JSON Copied!" : "Copy JSON"}
            </button>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
