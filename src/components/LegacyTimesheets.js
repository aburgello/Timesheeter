import React, {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
} from "react";
import { useLegacyRows, getCurrentWeekStart, hmToHours } from "../hooks/useLegacyRows";
import { roundToHalfHourSeconds } from "../utils/timeHelpers";
import { useJobLookup } from "../hooks/useJobLookup";
import {
  setWrikeUserId as stampWrikeUserId,
  fetchExistingTimelogIds,
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
  REGION_ALIASES,
  FILM_MAPPINGS,
} from "../constants.js";
import { COLUMNS, DAYS, TIME_OPTIONS, getDarkTagStyle } from "./legacy/legacyConstants";
import PageHeader, { pageHeaderActionClass } from "./shared/PageHeader";
import TableSearchableSelect from "./legacy/TableSearchableSelect";

export default function LegacyTimesheet({ wrikeData, isAdmin = false }) {
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
  const formatDayTotal = (hours) => {
    const mins = Math.round(hours * 60);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}:${String(m).padStart(2, "0")}`;
  };

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
  const enrichLegacyTask = useCallback(
    (task, statusDict) => {
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

      setLocalWrikeTasks((prev) => {
        const map = new Map(prev.map((t) => [t.id, t]));
        changed.forEach((t) => {
          if (t.responsibleIds?.includes(wrikeUserId)) {
            map.set(t.id, enrichLegacyTask(t, statusDictRef.current));
          } else {
            map.delete(t.id); // reassigned away from me
          }
        });
        return [...map.values()];
      });
    };

    return subscribeToWrikeTaskEvents(handleWebhookTaskIds);
  }, [wrikeUserId, enrichLegacyTask]);

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

      const fieldsFilter = encodeURIComponent(
        "[customFields,parentIds,description]"
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

      const enrichedTasks = rawTasks.map((task) => enrichLegacyTask(task, statusDict));

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

    let guessedTerritory = "";
    let earliestIndex = Infinity;
    const boundary = `(?:^|[^a-zA-Z])`;

    // 1. Check direct matches with constants
    const sortedTerritories = [...TERRITORIES].sort(
      (a, b) => b.length - a.length
    );
    for (const terr of sortedTerritories) {
      const escapedTerr = terr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`${boundary}${escapedTerr}${boundary}`, "i");
      const match = searchTarget.match(regex);
      if (match && match.index < earliestIndex) {
        earliestIndex = match.index;
        guessedTerritory = terr;
      }
    }

    // 2. Check aliases from constants file
    for (const [abbr, targetTerritory] of Object.entries(REGION_ALIASES)) {
      const regex = new RegExp(`${boundary}${abbr}${boundary}`, "i");
      const match = searchTarget.match(regex);
      if (match && match.index < earliestIndex) {
        earliestIndex = match.index;
        guessedTerritory = targetTerritory;
      }
    }

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
        const cfMatch = jobField.value.match(/(XY\d{5,6})/i);
        rawPrefix = cfMatch[1].toUpperCase();
        const matchingOption = DEFAULT_JOBS.find((job) =>
          job.toUpperCase().includes(rawPrefix)
        );
        guessedJob = matchingOption ? matchingOption : rawPrefix;
      }
    }

    if (!rawPrefix) {
      const xyMatch = searchTarget.match(/(XY\d{5,6})/i);
      if (xyMatch) {
        rawPrefix = xyMatch[1].toUpperCase();
        const matchingOption = DEFAULT_JOBS.find((job) =>
          job.toUpperCase().includes(rawPrefix)
        );
        guessedJob = matchingOption ? matchingOption : rawPrefix;
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

  const getTimesheetValue = (hours) => {
    if (!hours || hours === 0) return "none";
    const secs = Math.round(hours * 3600);
    if (secs <= 0) return "none";
    const mins = Math.round(secs / 60);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}:${String(m).padStart(2, "0")}`;
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
        const logDay = dayNames[new Date(log.trackedDate).getDay()];
        if (logDay === targetDay) {
          totalHours += log.hours;
        }
      }
    });

    return totalHours > 0 ? totalHours.toFixed(1) : null;
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
        "[customFields,parentIds,description]"
      );

      // --- STEP 1: Fetch today's timelogs (source of truth for worked-on tasks) ---
      const timelogRes = await fetch(`/api/wrike/contacts/${wrikeUserId}/timelogs`);
      const timelogJson = await timelogRes.json();
      const logs = (timelogJson.data || []).filter((l) => {
        const d = l.trackedDate?.split("T")[0];
        return d === todayStr || d === yesterdayStr;
      });
      setWrikeWeeklyLogs(logs);

      const todayLoggedTaskIds = [
        ...new Set(
          logs
            .filter((l) => l.trackedDate?.split("T")[0] === todayStr)
            .map((l) => l.taskId)
        ),
      ];

      // --- STEP 2: Fetch today's timelog tasks directly, one by one ---
      // We fetch each task individually so a single failure never blocks the rest.
      // Strategy per task:
      //   A) Try with fields= (gives custom fields, description, parentIds)
      //   B) If that 400s (e.g. unassigned tasks on some Wrike plans), retry bare
      //      — we still get title/status/dates, which is enough to show the row.
      let timelogTasks = [];
      for (const taskId of todayLoggedTaskIds) {
        try {
          // Attempt A: full fields
          let res = await fetch(`/api/wrike/tasks/${taskId}?fields=${fieldsFilter}`);

          // Attempt B: bare fetch if fields caused a 400
          if (!res.ok) {
            res = await fetch(`/api/wrike/tasks/${taskId}`);
          }

          if (res.ok) {
            const json = await res.json();
            if (json.data)
              timelogTasks = [
                ...timelogTasks,
                ...json.data.map(enrichWrikeTask),
              ];
          } else {
            console.warn(
              `Could not fetch timelog task ${taskId}: ${res.status}`
            );
          }
        } catch (err) {
          console.warn(`Failed to fetch timelog task ${taskId}:`, err);
        }
      }

      // --- STEP 3: Fetch assigned tasks due today/tomorrow ---
      const myFirstName = wrikeFullName.split(" ")[0];
      let assignedTasks = await handleSyncMyJobs(true);
      if (!assignedTasks) assignedTasks = activeWrikeData || [];

      const assignedFiltered = assignedTasks.filter((t) => {
        const isAssigned = Array.isArray(t.assignees)
          ? t.assignees.includes(myFirstName)
          : t.assignees === myFirstName;
        if (!isAssigned) return false;

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
        const fields = guessFieldsFromTask(task);
        const groupName = fields.jobNumber || "Others (No Job Number)";

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
        jobLookup?.ensureJob?.(fields.jobNumber, { filmTitle, client });

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
              const totalMins = Math.round(parseFloat(wrikeHours) * 60);
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
  const enrichWrikeTask = (task) => {
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
      customStatusName: task.status,
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
      "[customFields,parentIds,description]"
    );
    let recovered = [...currentTasks];

    for (let i = 0; i < missingIds.length; i += 100) {
      const chunk = missingIds.slice(i, i + 100);
      try {
        const res = await fetch(`/api/wrike/tasks/${chunk.join(",")}?fields=${fieldsFilter}`);
        const json = await res.json();
        if (json.data) {
          recovered = [...recovered, ...json.data.map(enrichWrikeTask)];
        }
      } catch (err) {
        console.warn("Failed to recover missing tasks chunk:", chunk, err);
        // Don't abort the whole pull — continue with whatever we have
      }
    }
    return recovered;
  };

  const dismissNewWeekBanner = () => setNewWeekBanner(false);

  const handlePullTimes = async (dateStr = null) => {
    if (!wrikeUserId) {
      showToast("Please connect Wrike in Profile → Settings first.");
      return;
    }

    setIsPulling(true);
    try {
      let currentTasks = await handleSyncMyJobs(true);
      if (!currentTasks) currentTasks = activeWrikeData;

      // Use contacts-scoped endpoint — avoids the broken trackedDate query param
      // Filter to target date client-side using local date string
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(
        now.getMonth() + 1
      ).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const targetDateStr = (typeof dateStr === "string" && dateStr) ? dateStr : todayStr;

      const res = await fetch(`/api/wrike/contacts/${wrikeUserId}/timelogs`);
      const json = await res.json();
      const logs = (json.data || []).filter(
        (l) => l.trackedDate?.split("T")[0] === targetDateStr
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
          if (known1?.job_number?.includes(" : ") && !(guessed.jobNumber || "").includes(" : ")) {
            guessed.jobNumber = known1.job_number;
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
            timeSpent: getTimesheetValue(totalHours),
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
        showToast("No new or unfrozen times found for today.");
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

        let exportTerritory = row.territory || "";
        if (exportTerritory === "UK") exportTerritory = "United Kingdom";
        else if (exportTerritory === "USA" || exportTerritory === "US")
          exportTerritory = "United States";
        else if (exportTerritory === "UAE")
          exportTerritory = "United Arab Emirates";

        return {
          id: row.id,
          taskId: row.taskId,
          jobNumber: row.jobNumber || "",
          territory: exportTerritory,
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
          const key = `${t.dayOfWeek}|${t.jobNumber}|${t.territory}|${t.category}`;
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

        return Object.values(consolidated).map((c) => ({
          ...c,
          rawSeconds: roundToHalfHourSeconds(c.rawSeconds),
          additionalSeconds: c.additionalSeconds > 0 ? roundToHalfHourSeconds(c.additionalSeconds) : 0,
          notes: c.notesArray.filter(Boolean).join(" | "),
        }));
      };

      const exportData = {
        version: 5,
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
    // Auto-fill projectDescription from jobNumber if it contains a comma
    if (field === "jobNumber" && value && value.includes(",")) {
      updateRow(
        id,
        "projectDescription",
        value.substring(value.indexOf(",") + 1).trim()
      );
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

  const currentDayRows = rows.filter((r) => r.dayOfWeek === activeDay);
  const isDayFrozen = frozenDays[activeDay] || false;

  const [consolidatedView, setConsolidatedView] = useState(true);
  const [expandedSessions, setExpandedSessions] = useState({});
  const toggleSessions = (rowKey) =>
    setExpandedSessions((prev) => ({ ...prev, [rowKey]: !prev[rowKey] }));

  const consolidatedRows = useMemo(() => {
    const groups = {};
    currentDayRows.forEach((row) => {
      const key = `${row.jobNumber}|||${row.territory}|||${row.category}`;
      if (!groups[key]) {
        groups[key] = {
          ...row,
          _rawSeconds: 0,
          _additionalSeconds: 0,
          _notes: new Set(),
          _count: 0,
        };
      }
      // Sum raw seconds — never the already-rounded timeSpent values
      groups[key]._rawSeconds += row.rawSeconds ?? 0;
      groups[key]._additionalSeconds += row.additionalSeconds ?? 0;
      if (row.notes) groups[key]._notes.add(row.notes);
      groups[key]._count += 1;
      if (!groups[key]._subRows) groups[key]._subRows = [];
      groups[key]._subRows.push(row);
    });
    const sToHM = (s) => {
      if (!(s > 0)) return "none";
      const mins = Math.round(s / 60);
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return `${h}:${String(m).padStart(2, "0")}`;
    };
    return Object.values(groups).map((g) => ({
      ...g,
      rawSeconds: g._rawSeconds,
      additionalSeconds: g._additionalSeconds,
      timeSpent: sToHM(g._rawSeconds),
      additionalTime: sToHM(g._additionalSeconds),
      notes: [...g._notes].filter(Boolean).join(" | "),
      _subRows: g._subRows || [],
    }));
  }, [currentDayRows]);

  const displayRows = consolidatedView ? consolidatedRows : currentDayRows;
  const rowsAreEditable = !isDayFrozen && !consolidatedView;
  const showConsolidationWarning =
    !consolidatedView &&
    currentDayRows.some(
      (r, _, arr) =>
        arr.filter(
          (x) =>
            x.jobNumber === r.jobNumber &&
            x.territory === r.territory &&
            x.category === r.category
        ).length > 1
    );

  const textAreaClass = `w-full bg-transparent border border-transparent hover:border-slate-300 focus:border-[#12a0e1] focus:ring-2 focus:ring-[#12a0e1]/20 outline-none text-[12px] text-slate-800 font-medium p-2 transition-all rounded-md resize-none overflow-hidden leading-tight ${
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
              <table className="w-full text-left text-[12px] border-collapse whitespace-nowrap min-w-max">
                <thead className="bg-[#121824] text-slate-400 font-bold uppercase tracking-wider sticky top-0 z-20 shadow-md border-b border-[#222f3e]">
                  <tr>
                    <th className="px-5 py-3.5 border-r border-[#222f3e] w-[320px]">
                      Assignment Title
                    </th>
                    <th className="px-5 py-3.5 border-r border-[#222f3e] w-[140px]">
                      Status
                    </th>
                    <th className="px-5 py-3.5 border-r border-[#222f3e] w-[240px]">
                      Category Link
                    </th>
                    <th className="px-5 py-3.5 border-r border-[#222f3e]">
                      Job Key
                    </th>
                    <th className="px-5 py-3.5 border-r border-[#222f3e] w-[110px]">
                      Due Date
                    </th>
                    <th className="px-5 py-3.5 border-r border-[#222f3e]">
                      Location
                    </th>
                    {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d, i) => {
                      const dayName = DAYS[i];
                      const isCurrent = todayDayName === dayName;
                      const isEnd = d === "Sa" || d === "Su";
                      return (
                        <th
                          key={d}
                          className={`px-4 py-3.5 border-r border-[#222f3e] text-center w-16 last:border-r-0 ${
                            isCurrent
                              ? "bg-[#12a0e1]/15 text-[#38bdf8] font-black"
                              : isEnd
                              ? "text-rose-400/60"
                              : ""
                          }`}
                        >
                          {d}
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
        {wrikeUserId && (
          <button
            onClick={() => handleSyncMyJobs()}
            disabled={isSyncingJobs}
            className={pageHeaderActionClass}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isSyncingJobs ? "animate-spin" : ""}`} />
            {isSyncingJobs ? "Syncing..." : "Sync My Jobs"}
          </button>
        )}
      </PageHeader>

      {/* Everything below the full-bleed header gets the page's horizontal
          gutter + top/bottom spacing — the header itself must stay outside
          any padded container to remain edge-to-edge. */}
      <div className="px-4 sm:px-6 pt-3 pb-4">
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
      <div className="max-w-[1800px] mx-auto bg-white shadow-2xl rounded-2xl relative min-h-[calc(100vh-10rem)] flex flex-col border border-slate-200">
        {/* --- MODERN TABS --- */}
        <div className="flex px-4 pt-4 bg-slate-50 border-b border-slate-200 gap-2">
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

        {/* Freeze toggle strip */}
        <div className="bg-white border-b border-slate-100 px-4 py-1.5 flex items-center justify-end gap-4">
          {/* Consolidated view toggle */}
          <div className="flex items-center gap-2">
            <Layers
              className={`w-3.5 h-3.5 ${
                consolidatedView ? "text-[#12a0e1]" : "text-slate-400"
              }`}
            />
            <span
              className={`text-[11px] font-bold transition-colors ${
                consolidatedView ? "text-[#12a0e1]" : "text-slate-400"
              }`}
              title="Merges rows with same job/territory/category and sums raw time before rounding — more accurate than viewing individually"
            >
              Consolidated
            </span>
            <button
              onClick={() => setConsolidatedView((v) => !v)}
              title="Merge rows with same job, country & category"
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
                consolidatedView
                  ? "bg-[#12a0e1]"
                  : "bg-slate-200 hover:bg-slate-300"
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
                  consolidatedView ? "translate-x-4" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>
          <div className="w-px h-4 bg-slate-200" />
          <span
            className={`text-[11px] font-bold transition-colors ${
              isDayFrozen ? "text-amber-500" : "text-slate-400"
            }`}
          >
            {isDayFrozen ? `${activeDay} is locked` : `Lock ${activeDay}`}
          </span>
          <button
            onClick={toggleFreeze}
            title={isDayFrozen ? "Unlock day" : "Lock day to prevent edits"}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
              isDayFrozen ? "bg-amber-400" : "bg-slate-200 hover:bg-slate-300"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
                isDayFrozen ? "translate-x-4" : "translate-x-0.5"
              }`}
            />
          </button>
          {isDayFrozen && <Lock className="w-3.5 h-3.5 text-amber-400" />}
        </div>

        {/* --- TABLE AREA --- */}
        <div className="flex-1 bg-white relative overflow-x-auto w-full">
          <table className="w-full text-left text-[12px] border-collapse min-w-max">
            <thead>
              <tr className="bg-slate-800 text-slate-200 shadow-sm">
                {COLUMNS.map((col, idx) => (
                  <th
                    key={col}
                    className={`p-3 border-r border-slate-700 font-bold whitespace-nowrap tracking-wide ${
                      idx === COLUMNS.length - 1 ? "border-r-0" : ""
                    }`}
                  >
                    {col}
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
              {displayRows.map((row) => (
                <tr
                  key={row.id}
                  className={`timesheet-row transition-colors group relative ${
                    !rowsAreEditable ? "frozen-row" : ""
                  }`}
                >
                  <td className="p-2 border-r border-slate-100 align-middle min-w-[240px]">
                    <div className="flex items-start gap-2 pl-1">
                      <button
                        onClick={() => handleDeleteRow(row.id)}
                        disabled={!rowsAreEditable}
                        className={`mt-1.5 transition-opacity ${
                          !rowsAreEditable
                            ? "opacity-20 cursor-not-allowed"
                            : "opacity-50 hover:opacity-100"
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
                        <TableSearchableSelect
                          options={DEFAULT_JOBS}
                          value={row.jobNumber}
                          onChange={(val) =>
                            handleUpdateRow(row.id, "jobNumber", val)
                          }
                          placeholder="Select Job..."
                          isGrouped={true}
                          dropdownId={`job-${row.id}`}
                          activeDropdown={activeDropdown}
                          setActiveDropdown={setActiveDropdown}
                          isJob={true}
                          disabled={!rowsAreEditable}
                        />
                        {row.wrikeTimelogId && (
                          <span className="text-[10px] font-bold text-emerald-600 ml-2 mt-0.5 flex items-center gap-1 opacity-80">
                            <CheckCircle className="w-3 h-3" /> Wrike Synced
                          </span>
                        )}
                        {consolidatedView &&
                          row._count > 1 &&
                          (() => {
                            const rowKey = `${row.jobNumber}|||${row.territory}|||${row.category}`;
                            const isExpanded = expandedSessions[rowKey];
                            const fmtSecs = (s) => {
                              const h = Math.floor(s / 3600),
                                m = Math.floor((s % 3600) / 60),
                                sec = s % 60;
                              return (
                                [h && `${h}h`, m && `${m}m`, sec && `${sec}s`]
                                  .filter(Boolean)
                                  .join(" ") || "0s"
                              );
                            };
                            return (
                              <>
                                <button
                                  onClick={() => toggleSessions(rowKey)}
                                  className="text-[10px] font-black text-[#12a0e1] bg-[#12a0e1]/10 border border-[#12a0e1]/20 hover:bg-[#12a0e1]/20 px-1.5 py-0.5 rounded-full ml-2 mt-1 flex items-center gap-1 shrink-0 transition-colors"
                                >
                                  <Layers className="w-3 h-3" />
                                  {row._count} sessions
                                  <span className="opacity-60">
                                    {isExpanded ? "▲" : "▼"}
                                  </span>
                                </button>
                                {isExpanded && (
                                  <div className="ml-2 mt-1.5 space-y-1 border-l-2 border-[#12a0e1]/20 pl-2">
                                    <p className="text-[9px] font-black text-[#768994] uppercase tracking-wider mb-1">
                                      Raw sessions — time summed before rounding
                                    </p>
                                    {row._subRows.map((sub, i) => (
                                      <div
                                        key={sub.id}
                                        className="flex items-center gap-2 text-[10px] text-slate-500"
                                      >
                                        <span className="font-bold text-slate-400">
                                          #{i + 1}
                                        </span>
                                        <span className="font-bold text-[#122027]">
                                          {fmtSecs(sub.rawSeconds ?? 0)}
                                        </span>
                                        {sub.notes && (
                                          <span className="italic truncate max-w-[120px]">
                                            {sub.notes}
                                          </span>
                                        )}
                                        {sub.date && (
                                          <span className="text-[9px] text-slate-400">
                                            {sub.date}
                                          </span>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </>
                            );
                          })()}
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
                    <textarea
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
                    <TableSearchableSelect
                      options={TERRITORIES}
                      value={row.territory}
                      onChange={(val) =>
                        handleUpdateRow(row.id, "territory", val)
                      }
                      placeholder="Country"
                      getPrefix={(val) => TERRITORY_FLAGS[val]}
                      dropdownId={`country-${row.id}`}
                      activeDropdown={activeDropdown}
                      setActiveDropdown={setActiveDropdown}
                      isCountry={true}
                      disabled={!rowsAreEditable}
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
                    <textarea
                      value={row.notes || ""}
                      onChange={(e) =>
                        handleUpdateRow(row.id, "notes", e.target.value)
                      }
                      placeholder="Notes…"
                      rows={2}
                      disabled={!rowsAreEditable}
                      className={`w-full text-[11px] bg-transparent border border-transparent rounded-lg px-2 py-1 resize-none overflow-hidden transition-colors leading-relaxed placeholder:text-slate-300 ${
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
              ))}
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
                    <span className="flex items-center justify-center gap-1.5 text-[11px] font-bold text-slate-300 group-hover/addrow:text-[#12a0e1] transition-colors">
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
                No time logged for {activeDay}.
              </p>
              <p className="text-xs mt-1">Hit pull below to sync with Wrike.</p>
            </div>
          )}
        </div>

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

            <button
              onClick={handleExportExcel}
              className="flex items-center gap-2 bg-emerald-500 hover:bg-emerald-600 text-white px-5 py-2.5 text-sm font-bold rounded-xl shadow-lg shadow-emerald-500/30 transition-all active:scale-95"
            >
              <FileSpreadsheet className="w-4 h-4" />
              Export to Excel
            </button>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
