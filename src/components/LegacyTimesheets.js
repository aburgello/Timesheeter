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
import { layoutRect } from "../utils/zoom";
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
  DEFAULT_JOBS,
  TERRITORIES,
  CATEGORIES,
  TERRITORY_FLAGS,
  FILM_MAPPINGS,
  normalizeName,
} from "../constants.js";
import { resolveJobNumber } from "../utils/wrikeHelpers";
import { resolveCountries } from "../utils/countryCodes";
import { getFolderCountries, buildChildToParent } from "../lib/wrikeEnrich";
import { fetchFolderDictionary } from "../hooks/useMotionBoardTasks";
import { countryFieldIds, warmCountryFields } from "../lib/countryField";
import { secondsToHM } from "../utils/timeHelpers";
import { COLUMNS, DAYS, TIME_OPTIONS, getDarkTagStyle } from "./legacy/legacyConstants";
import PageHeader, { pageHeaderActionClass } from "./shared/PageHeader";
import TableSearchableSelect from "./legacy/TableSearchableSelect";
import MultiCountrySelect from "./shared/MultiCountrySelect";
import {
  splitTerritories,
  joinTerritories,
  territoryFlags,
  territoryKey,
  territoryCode,
  toTimesheetTerritories,
} from "../utils/territories";

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
    "Country": 140, "Category": 180, "Client Amends": 80, "Notes": 140,
    "3D": 56, "Time Spent": 104, "Additional Time": 104,
  };
  // These four hold a checkbox or a short time dropdown, never prose. They're
  // already the size they need to be, so squeezing them only clips the control
  // ("none" became "n…") without buying the text columns much room.
  const CONSOL_FIXED = new Set(["Client Amends", "3D", "Time Spent", "Additional Time"]);
  const CONSOL_COLS = COLUMNS.map((c, i) => ({
    key: `c${i}`,
    label: c,
    px: CONSOL_PX[c] || 140,
    fixed: CONSOL_FIXED.has(c),
  }));
  // Job Number and Additional Time keep their width and stay pinned to the
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

  // "dd/mm/yyyy" -> "yyyy-mm-dd", for comparing against weekStart (ISO)
  const toIsoDate = (d) => {
    const m = typeof d === "string" && d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  };
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
        childToParent: buildChildToParent(seed),
      };
      return;
    }
    if (Object.keys(folderTreeRef.current.folderDictionary).length) return;
    try {
      const { folderDictionary } = await fetchFolderDictionary();
      folderTreeRef.current = {
        folderDictionary,
        childToParent: buildChildToParent(folderDictionary),
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
        // resolveJobNumber for which suffixes survive onto the row and why.
        const cfMatch = jobField.value.match(/(XY\d{5,6}(?:_[A-Za-z0-9]+)*)/i);
        const fullCode = cfMatch[1].toUpperCase();
        rawPrefix = fullCode.match(/XY\d{5,6}/i)[0];
        guessedJob = resolveJobNumber(fullCode, DEFAULT_JOBS);
      }
    }

    if (!rawPrefix) {
      const xyMatch = searchTarget.match(/(XY\d{5,6}(?:_[A-Za-z0-9]+)*)/i);
      if (xyMatch) {
        const fullCode = xyMatch[1].toUpperCase();
        rawPrefix = fullCode.match(/XY\d{5,6}/i)[0];
        guessedJob = resolveJobNumber(fullCode, DEFAULT_JOBS);
      } else {
        const rawSplit = linkedTask.title?.split(/[_|-]/)[0]?.trim();
        for (const job of DEFAULT_JOBS) {
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

    let guessedCategory =
      linkedTask.customStatusName || linkedTask.status || "";
    if (!CATEGORIES.includes(guessedCategory)) {
      if (searchTarget.includes("PRINT"))
        guessedCategory = "Print - Production/Localisation";
      else if (
        searchTarget.includes("REVISION") ||
        searchTarget.includes("AMEND")
      )
        guessedCategory = "Digital - Client Revisions/Amends";
      else guessedCategory = "Digital - Production/Localisation";
    }

    let cleanDescription = linkedTask.title || "";
    if (guessedJob && guessedJob.includes(",")) {
      cleanDescription = guessedJob
        .substring(guessedJob.indexOf(",") + 1)
        .trim();
    } else if (rawPrefix) {
      const escapedPrefix = rawPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const prefixRegex = new RegExp(`^.*?${escapedPrefix}[,\\s:\\-]*`, "i");
      cleanDescription = cleanDescription.replace(prefixRegex, "").trim();
    }

    if (!cleanDescription) cleanDescription = linkedTask.title || "";

    return {
      jobNumber: guessedJob,
      territory: guessedTerritory,
      category: guessedCategory,
      notes: cleanDescription,
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
        childToParent = buildChildToParent(folderDictionary);
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
          fields.jobNumber &&
          !fields.jobNumber.includes(" : ") &&
          filmTitle &&
          filmTitle !== "XYi Unbilled"
        ) {
          // Brand-new job with no Job Book record yet — synthesize the canonical
          // string ourselves instead of leaving a bare/suffixed code that
          // external systems (e.g. the timesheet bookmarklet) won't recognize.
          fields.jobNumber = `${filmTitle} : ${fields.jobNumber}, ${fields.notes || ""}`
            .trim()
            .replace(/,\s*$/, "");
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
        className={`px-1 py-1.5 border-r border-[#263143] text-center group/cell transition-all ${
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
            guessed.jobNumber &&
            !guessed.jobNumber.includes(" : ") &&
            filmTitle &&
            filmTitle !== "XYi Unbilled"
          ) {
            // Brand-new job with no Job Book record yet — synthesize the canonical
            // string ourselves instead of leaving a bare/suffixed code that
            // external systems (e.g. the timesheet bookmarklet) won't recognize.
            guessed.jobNumber = `${filmTitle} : ${guessed.jobNumber}, ${guessed.notes || ""}`
              .trim()
              .replace(/,\s*$/, "");
          }
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
          });
        }
      );

      if (newRows.length > 0) {
        addRows(newRows);
        // The grid only shows rows from the current week (weekStart) — a
        // debug pull for an older date saves fine but won't appear here, so
        // say so instead of implying it's now visible in the table below.
        const pulledBeforeThisWeek = newRows.some(
          (r) => (toIsoDate(r.date) || "") < weekStart
        );
        showToast(
          pulledBeforeThisWeek
            ? `Pulled ${newRows.length} row${newRows.length !== 1 ? "s" : ""} from Wrike — from a previous week, so it won't show in this grid. Check Jobs Feed to verify.`
            : `Pulled ${newRows.length} row${newRows.length !== 1 ? "s" : ""} from Wrike.`,
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
        jobOptions: DEFAULT_JOBS,
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
      const parseDate = (d) => {
        if (!d) return 0;
        const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d);
        if (dmy) return new Date(+dmy[3], +dmy[2] - 1, +dmy[1]).getTime();
        const t = Date.parse(d);
        return isNaN(t) ? 0 : t;
      };
      const recency = {};
      legacyTasks.forEach((r) => {
        const k = codeKey(r.job_number || "");
        if (!k) return;
        const t = parseDate(r.date);
        if (!(k in recency) || t > recency[k]) recency[k] = t;
      });
      // Book jobs: real films first, then most-recently-logged, then alphabetical.
      const codes = Object.keys(bookLabel).sort((a, b) =>
        (filmRank(bookLabel[b]) - filmRank(bookLabel[a])) ||
        ((recency[b] || 0) - (recency[a] || 0)) ||
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
    [...recentJobs, ...DEFAULT_JOBS].forEach((j) => {
      const k = codeKey(j);
      if (!seen.has(k)) { seen.add(k); out.push(j); }
    });
    const nonFilm = (label) => {
      const f = (label.split(" : ")[0] || "").trim();
      return /^\d{2,4}$/.test(f) || !/[a-z]/i.test(f);
    };
    return out.sort((a, b) => (nonFilm(a) ? 1 : 0) - (nonFilm(b) ? 1 : 0));
  }, [recentJobs]);

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
    let left = Math.max(8, Math.min(rect.right - w, window.innerWidth - w - 8));
    const spaceBelow = window.innerHeight - rect.bottom;
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

  const textAreaClass = `w-full bg-transparent border border-transparent hover:border-slate-300 focus:border-[#12a0e1] focus:ring-2 focus:ring-[#12a0e1]/20 outline-none text-[12px] text-slate-800 font-medium p-2 transition-all rounded-md resize-none overflow-hidden leading-tight placeholder:text-slate-500 ${
    !rowsAreEditable ? "opacity-60 cursor-not-allowed" : ""
  }`;

  return (
    <div className="min-h-screen bg-slate-100 font-sans selection:bg-[#12a0e1]/30">
      {/* Toast */}
      {toast.show && (
        <div
          className={`fixed top-5 right-5 z-[99999] flex items-center gap-3 px-5 py-3.5 rounded-2xl shadow-2xl text-sm font-bold transition-all animate-in fade-in slide-in-from-top-2 duration-300 ${
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
                  className={`px-4 py-1.5 text-xs font-black tracking-wide uppercase transition-all rounded-lg ${
                    modalTab === "timesheet"
                      ? "bg-[#12a0e1] text-white shadow-md"
                      : "text-slate-500 hover:text-slate-300"
                  }`}
                >
                  My Timesheet
                </button>
                <button
                  onClick={() => setShowReminderModal(true)}
                  className="px-4 py-1.5 text-xs font-black tracking-wide uppercase transition-all rounded-lg flex items-center gap-2 text-slate-500 hover:text-slate-300"
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
              className="p-2.5 bg-[#1a2333] hover:bg-[#253247] border border-[#2d3d52] text-slate-400 hover:text-white rounded-xl transition-all shadow-md active:scale-95"
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
                              className="bg-[#141b27] hover:bg-[#1a2436] transition-all cursor-pointer border-y border-[#222f3e]"
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
                                    className={`transition-all group border-b border-[#1e293b]/40 ${
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
                                                <span className="text-[9px] font-black uppercase tracking-wider text-rose-500">
                                                  overdue
                                                </span>
                                              )}
                                              {isToday && (
                                                <span className="text-[9px] font-black uppercase tracking-wider text-amber-500">
                                                  today
                                                </span>
                                              )}
                                              {isTomorrow && (
                                                <span className="text-[9px] font-black uppercase tracking-wider text-yellow-500">
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
      <div className="max-w-[1800px] mx-auto bg-white shadow-2xl rounded-2xl relative flex flex-col border border-slate-200">
        {/* --- MODERN TABS --- */}
        <div className="flex px-4 pt-4 bg-slate-50 border-b border-slate-200 gap-2 rounded-t-2xl">
          {DAYS.map((day) => {
            const isWeekend = day === "Saturday" || day === "Sunday";
            const isActive = activeDay === day;

            let tabColors = "";
            if (isActive) {
              tabColors = isWeekend
                ? "bg-white text-rose-500 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] border-t border-x border-slate-200"
                : "bg-white text-[#12a0e1] shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] border-t border-x border-slate-200";
            } else {
              tabColors = isWeekend
                ? "bg-rose-50 text-rose-400 hover:bg-rose-100 hover:text-rose-600 border-t border-x border-transparent"
                : "bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-700 border-t border-x border-transparent";
            }

            return (
              <button
                key={day}
                onClick={() => setActiveDay(day)}
                className={`flex-1 py-3 text-[13px] font-bold text-center rounded-t-xl transition-all ${tabColors} ${
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
                            : "bg-slate-200 text-slate-500"
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
                          : "text-slate-400"
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

        {/* View controls — segmented pill buttons */}
        <div className="bg-white border-b border-slate-100 px-4 py-2 flex items-center justify-between gap-3">
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-300">View</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setConsolidatedView((v) => !v)}
              title="Merge rows with the same job number — territories & categories become subrows, raw time summed before rounding"
              className={`flex items-center gap-1.5 pl-2 pr-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition-all active:scale-95 ${
                consolidatedView
                  ? "bg-[#12a0e1]/10 text-[#12a0e1] border-[#12a0e1]/30"
                  : "bg-white text-slate-400 border-slate-200 hover:border-slate-300 hover:text-slate-600"
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              Consolidated
              <span className={`ml-0.5 text-[9px] font-black px-1.5 py-0.5 rounded ${consolidatedView ? "bg-[#12a0e1] text-white" : "bg-slate-100 text-slate-400"}`}>
                {consolidatedView ? "ON" : "OFF"}
              </span>
            </button>
            <button
              onClick={toggleFreeze}
              title={isDayFrozen ? "Unlock day to allow edits" : "Lock this day to prevent edits"}
              className={`flex items-center gap-1.5 pl-2 pr-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition-all active:scale-95 ${
                isDayFrozen
                  ? "bg-amber-100 text-amber-700 border-amber-300"
                  : "bg-white text-slate-400 border-slate-200 hover:border-slate-300 hover:text-slate-600"
              }`}
            >
              <Lock className="w-3.5 h-3.5" />
              {isDayFrozen ? `${activeDay} locked` : `Lock ${activeDay}`}
            </button>
          </div>
        </div>

        {/* --- TABLE AREA --- */}
        <div ref={consolScrollRef} className="flex-1 bg-white relative overflow-x-auto w-full min-h-[600px]">
          <table className="w-full text-left text-[12px] border-collapse [&_td]:overflow-hidden" style={{ tableLayout: "fixed", minWidth: `${consolTotal}px` }}>
            <colgroup>
              {CONSOL_COLS.map((c) => <col key={c.key} style={{ width: consolWidths[c.key] }} />)}
            </colgroup>
            <thead className="sticky top-0 z-20">
              <tr className="bg-slate-50 text-[#768994] shadow-sm border-b-2 border-slate-200">
                {/* Headers wrap rather than truncate — a squeezed column showed
                    "ADDITIONA" with no way to tell what it was. align-bottom
                    keeps the labels on one baseline whether they run to one
                    line or two. */}
                {CONSOL_COLS.map((c, idx) => (
                  <th
                    key={c.key}
                    className={`relative px-3 py-2 text-[10px] font-black uppercase tracking-widest leading-[1.2] align-bottom ${
                      idx === CONSOL_COLS.length - 1 ? "" : "border-r border-slate-200/70"
                    }`}
                  >
                    {c.label}
                    {consolHandle(c.key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {showConsolidationWarning && (
                <tr>
                  <td
                    colSpan={COLUMNS.length + 1}
                    className="px-4 py-2 bg-amber-50 border-b border-amber-200"
                  >
                    <p className="text-[11px] font-bold text-amber-700 flex items-center gap-2">
                      ⚠️ Some rows share the same job/territory/category. Time
                      totals may appear inflated due to per-row rounding —
                      switch to <strong>Consolidated</strong> view for accurate
                      totals.
                    </p>
                  </td>
                </tr>
              )}
              {renderItems.map((item) => {
                // ── Group header row (consolidated view) ─────────────────────
                if (item.type === "group") {
                  const g = item.group;
                  const collapsed = collapsedGroups[g.jobNumber];
                  return (
                    <tr key={g.id} className="bg-slate-100/70 border-y border-slate-200">
                      {/* overflow-visible (inline, to beat the table's [&_td]:overflow-hidden)
                          so the multi-country add popover isn't clipped by the cell. */}
                      <td className="p-2 border-r border-slate-200/60 align-middle" style={{ overflow: "visible" }}>
                        <div className="flex items-center gap-1.5 pl-1">
                          <button
                            onClick={() => toggleJobGroup(g.jobNumber)}
                            className="w-5 h-5 grid place-items-center rounded-md text-slate-400 hover:text-[#12a0e1] hover:bg-white transition-colors shrink-0"
                            title={collapsed ? "Expand" : "Collapse"}
                          >
                            <span className="text-[10px]">{collapsed ? "▶" : "▼"}</span>
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
                          <span className="text-[9px] font-black text-[#768994] bg-white border border-slate-200 rounded-full px-1.5 py-0.5 shrink-0">
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
                                    className="bg-white border border-slate-200 rounded-xl shadow-2xl p-2.5 text-left animate-in fade-in slide-in-from-top-1 duration-150"
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
                                    <div className="my-1.5 border-t border-slate-100" />
                                    <p className="px-1.5 py-1 text-[9px] font-black uppercase tracking-widest text-slate-400">
                                      One entry, several countries
                                    </p>
                                    <input
                                      value={countryQuery}
                                      onChange={(e) => setCountryQuery(e.target.value)}
                                      placeholder="Filter countries…"
                                      className="w-full mb-1.5 px-2.5 py-1.5 text-[11px] font-semibold rounded-lg border border-slate-200 outline-none focus:border-[#12a0e1] focus:ring-2 focus:ring-[#12a0e1]/10"
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
                                              <span className={`ml-auto shrink-0 font-mono text-[9.5px] tracking-wide ${on ? "opacity-70" : "text-slate-400"}`}>
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
                      <td className="p-2 border-r border-slate-200/60 align-middle text-[12px] font-semibold text-slate-600 truncate px-3">{g.client}</td>
                      <td className="p-2 border-r border-slate-200/60 align-middle text-[12px] font-black text-slate-800 truncate px-3">{g.filmTitle}</td>
                      <td className="p-2 border-r border-slate-200/60 align-middle text-[11px] text-slate-600 truncate px-3">{g.projectDescription}</td>
                      <td className="p-2 border-r border-slate-200/60 align-middle text-[11px] text-slate-500 px-3">
                        {g.territories.length ? (
                          <span className="flex flex-wrap items-center gap-x-1 gap-y-0.5" title={g.territories.join(", ")}>
                            <span className="text-[13px] leading-none">{territoryFlags(g.territories, 12)}</span>
                            <span>{g.territories.length} {g.territories.length === 1 ? "country" : "countries"}</span>
                          </span>
                        ) : "—"}
                      </td>
                      <td className="p-2 border-r border-slate-200/60 align-middle text-[11px] text-slate-500 px-3">
                        {g.categories.length ? `${g.categories.length} ${g.categories.length === 1 ? "category" : "categories"}` : "—"}
                      </td>
                      <td className="p-2 border-r border-slate-200/60" />
                      <td className="p-2 border-r border-slate-200/60" />
                      <td className="p-2 border-r border-slate-200/60" />
                      <td className="p-2 border-r border-slate-200/60 align-middle text-center text-[12px] font-black text-[#122027] tabular-nums">{g.timeSpent}</td>
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
                  } ${isSub ? "bg-white" : ""}`}
                >
                  <td className={`p-2 border-r border-slate-100 align-middle min-w-[240px] ${isSub ? "bg-slate-50/40" : ""}`}>
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
                    <div className="flex items-start gap-2 pl-1">
                      <button
                        onClick={() => handleDeleteRow(row.id)}
                        disabled={!rowsAreEditable}
                        title={rowsAreEditable ? "Delete row" : undefined}
                        className={`mt-1.5 transition-opacity ${
                          !rowsAreEditable
                            ? "opacity-0 cursor-not-allowed"
                            : "opacity-0 group-hover:opacity-70 hover:!opacity-100"
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
                          <div className="flex items-center gap-1.5 pl-3 border-l-2 border-[#12a0e1]/25 py-1 min-w-0" title={row.territory}>
                            <span className="text-slate-500 text-[11px] shrink-0">↳</span>
                            {/* Capped: this sits on one line next to the category,
                                so a 20-country row can't be allowed to run away. */}
                            <span className="text-[13px] leading-none shrink-0">{territoryFlags(row.territory, 6) || "🌐"}</span>
                            <span className="text-[11px] font-bold text-slate-600 truncate">
                              {splitTerritories(row.territory).length > 6
                                ? `${splitTerritories(row.territory).length} countries`
                                : row.territory || "No country"}
                              {row.category ? <span className="font-medium text-slate-600"> · {row.category.replace(/^(Digital|Print|XYi)\s*-\s*/, "")}</span> : null}
                            </span>
                          </div>
                        ) : (
                          <div className={`flex items-center gap-1.5 w-full min-w-0 ${isSub ? "pl-2 border-l-2 border-[#12a0e1]/25" : ""}`}>
                            {isSub && <span className="text-slate-500 text-[11px] shrink-0" title="Set a job for this entry">↳</span>}
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

                  <td className="p-2 border-r border-slate-100 align-middle w-[140px]">
                    <div
                      className={`text-[12px] leading-tight font-semibold px-2 ${
                        !rowsAreEditable ? "text-slate-500" : "text-slate-700"
                      }`}
                    >
                      {row.client}
                    </div>
                  </td>

                  <td className="p-2 border-r border-slate-100 align-middle w-[150px]">
                    <div
                      className={`text-[12px] leading-tight font-black px-2 ${
                        !rowsAreEditable ? "text-slate-600" : "text-slate-900"
                      }`}
                    >
                      {row.filmTitle}
                    </div>
                  </td>

                  <td className="p-2 border-r border-slate-100 align-middle w-[220px]">
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

                  <td className="p-2 border-r border-slate-100 align-middle w-[140px]">
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

                  <td className="p-2 border-r border-slate-100 align-middle w-[180px]">
                    <TableSearchableSelect
                      options={CATEGORIES}
                      value={row.category}
                      onChange={(val) =>
                        handleUpdateRow(row.id, "category", val)
                      }
                      placeholder="Category"
                      isGrouped={true}
                      dropdownId={`category-${row.id}`}
                      activeDropdown={activeDropdown}
                      setActiveDropdown={setActiveDropdown}
                      isCategory={true}
                      disabled={!rowsAreEditable}
                    />
                  </td>

                  <td className="p-2 border-r border-slate-100 align-middle w-[70px] text-center">
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

                  <td className="p-2 border-r border-slate-100 align-middle w-[140px]">
                    <AutoGrowTextarea
                      value={row.notes || ""}
                      onChange={(e) =>
                        handleUpdateRow(row.id, "notes", e.target.value)
                      }
                      placeholder="Notes…"
                      rows={2}
                      disabled={!rowsAreEditable}
                      className={`w-full text-[11px] bg-transparent border border-transparent rounded-lg px-2 py-1 resize-none overflow-hidden transition-colors leading-relaxed placeholder:text-slate-500 ${
                        !rowsAreEditable
                          ? "text-slate-400 cursor-not-allowed"
                          : "text-slate-700 hover:border-slate-200 focus:border-[#12a0e1] focus:bg-[#12a0e1]/5 outline-none"
                      }`}
                    />
                  </td>

                  <td className="p-2 border-r border-slate-100 align-middle w-[50px] text-center">
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

                  <td className="p-2 border-r border-slate-100 align-middle w-[90px] text-center">
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
                  className="group/addrow border-t border-dashed border-slate-200 cursor-pointer"
                  onClick={handleAddRow}
                >
                  <td
                    colSpan={COLUMNS.length + 1}
                    className="px-4 py-3 text-center"
                  >
                    <span className="flex items-center justify-center gap-1.5 text-[11px] font-bold text-slate-600 group-hover/addrow:text-[#12a0e1] transition-colors">
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
          <div className="px-4 py-2.5 border-t border-slate-200 bg-white flex items-center justify-end gap-6 text-[11px] font-bold text-[#768994]">
            <span className="uppercase tracking-widest text-[10px] font-black text-slate-400">{activeDay} total</span>
            <span className="tabular-nums">
              {currentDayRows.length} {currentDayRows.length === 1 ? "entry" : "entries"}
            </span>
            <span className="tabular-nums text-[#122027] text-sm font-black">
              {formatDayTotal(getDayTotal(activeDay))}h
            </span>
          </div>
        )}

        {/* Bottom Action Bar */}
        <div className="p-4 border-t border-slate-200 bg-slate-50 rounded-b-2xl flex flex-wrap gap-3 justify-between items-center">
          <button
            onClick={handleOpenWrikeModal}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold bg-[#1b202a] hover:bg-[#252a33] text-emerald-400 border border-[#2d3342] rounded-xl shadow-lg transition-all active:scale-95"
          >
            <LayoutList className="w-4 h-4" />
            Wrike Timesheets
          </button>
          <div className="flex gap-3 flex-wrap">
            <button
              onClick={() => handlePullTimes()}
              disabled={isPulling || isDayFrozen}
              title="Pulls your Wrike time for today and yesterday"
              className={`flex items-center gap-2 px-5 py-2.5 text-sm font-bold border rounded-xl shadow-lg transition-all ${
                isDayFrozen
                  ? "bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed opacity-70"
                  : "bg-white hover:bg-slate-50 text-slate-700 border-slate-200 active:scale-95"
              }`}
            >
              <RefreshCw
                className={`w-4 h-4 ${
                  isPulling ? "animate-spin text-[#12a0e1]" : ""
                }`}
              />
              {isPulling ? "Pulling..." : "Pull Wrike Times"}
            </button>

            {isAdmin && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowDebugPull(!showDebugPull)}
                  disabled={isPulling}
                  title="Admin: pull timelogs for a specific date"
                  className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-bold rounded-xl border transition-all active:scale-95 ${
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
              className={`flex items-center gap-2 px-5 py-2.5 text-sm font-bold rounded-xl shadow-lg transition-all active:scale-95 ${
                jsonCopied
                  ? "bg-[#1cc1a5] text-white shadow-[#1cc1a5]/30"
                  : "bg-indigo-500 hover:bg-indigo-600 text-white shadow-indigo-500/30"
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
