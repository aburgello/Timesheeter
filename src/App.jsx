import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  lazy,
  Suspense,
} from "react";
import { motion, AnimatePresence, MotionConfig } from "framer-motion";
import {
  Home as HomeIcon,
  Activity,
  Timer,
  LayoutList,
  Layout,
  Server,
  Moon,
  Copy,
  Zap,
  Command,
  Search,
  FileDown,
  Trash2,
  RefreshCw,
  Key,
  Bell,
  Shield,
  Users,
  Briefcase,
  CheckCircle2,
  X,
} from "lucide-react";
import "./Timesheeter.css";
import Rail from "./components/shared/Rail";
import ThemeToggle from "./components/shared/ThemeToggle";
import ToastHost from "./components/shared/ToastHost";
import ConfirmHost from "./components/shared/ConfirmHost";
import DepartmentPreviewBanner from "./components/shared/DepartmentPreviewBanner";
import { notify } from "./lib/toast";
import { confirmAction } from "./lib/confirm";
import Home from "./components/Home";
import { useWrikeCache } from "./hooks/useWrikeCache";
import { PAGES, pagesFor, boardLabelFor } from "./lib/departments";
import { useDepartment } from "./hooks/useDepartment";
import { MANAGEMENT_IDS } from "./lib/access";
import { setWrikeUserId } from "./lib/supabaseClient";
import { startWrikeOAuth } from "./lib/wrikeApi";

// ── Route-level code splitting ───────────────────────────────────────────────
// Every page except Home is its own chunk, so first paint only carries the
// shell + Home — a Motion artist never downloads Administration (2.6k lines),
// a PM never downloads the Canvas or pdfjs. Loaders live in a map keyed by
// page id so the idle prefetch below can warm exactly the pages this
// member's department can reach (same registry as the Rail/palette).
const PAGE_LOADERS = {
  timesheet: () => import("./components/tracker/Tracker"),
  todayslist: () => import("./components/TodaysList"),
  canvas: () => import("./components/Canvas"),
  wriketest: () => import("./components/WrikeTest"),
  legacy: () => import("./components/LegacyTimesheets"),
  profile: () => import("./components/Profile"),
  management: () => import("./components/Management"),
  jobbook: () => import("./components/JobBook"),
};
const Tracker = lazy(PAGE_LOADERS.timesheet);
const TodaysList = lazy(PAGE_LOADERS.todayslist);
const CampaignCanvas = lazy(PAGE_LOADERS.canvas);
const WrikeTest = lazy(PAGE_LOADERS.wriketest);
const LegacyTimesheet = lazy(PAGE_LOADERS.legacy);
const Profile = lazy(PAGE_LOADERS.profile);
const Management = lazy(PAGE_LOADERS.management);
const JobBook = lazy(PAGE_LOADERS.jobbook);
const AdminModal = lazy(() => import("./components/AdminModal"));

// Suspense fallback for a still-downloading page chunk. The spinner fades in
// after a beat (CSS delay) so the common case — chunk already prefetched,
// resolves within a frame or two — shows nothing at all instead of a flash.
function PageLoading() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div
        className="w-6 h-6 rounded-full border-2 border-[#dce4ec] border-t-[#12a0e1] animate-spin opacity-0"
        style={{ animation: "spin 0.8s linear infinite, fadeIn 0.2s ease 0.15s forwards" }}
      />
      <style>{`@keyframes fadeIn { to { opacity: 1; } }`}</style>
    </div>
  );
}

// Page swap animation. When the swap arrives via the home wash (custom =
// true) both sides are no-ops: the wash overlay hides the handoff, so any
// fade/y-shift here would just fight it. Pill-nav swaps keep the fade.
const PAGE_VARIANTS = {
  initial: (viaWash) => (viaWash ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 }),
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.25, ease: [0.25, 0.1, 0.25, 1] },
  },
  exit: (viaWash) =>
    viaWash
      ? { opacity: 1, transition: { duration: 0 } }
      : {
          opacity: 0,
          y: -12,
          transition: { duration: 0.25, ease: [0.25, 0.1, 0.25, 1] },
        },
};

// Kept in sync with every `activePage === "..."` check below — the set of
// ids the URL hash is allowed to select on load/refresh.
const VALID_PAGES = [
  "home", "timesheet", "canvas", "wriketest", "legacy", "profile",
  "management", "jobbook", "todayslist",
];

const pageFromHash = () => {
  const id = window.location.hash.slice(1);
  return VALID_PAGES.includes(id) ? id : "home";
};

export default function App() {
  const [activePage, setActivePage] = useState(pageFromHash);
  // Gradient classes of the home row currently washing over the screen.
  // While set, a fixed overlay hides the page swap; cleared shortly after
  // so the overlay lifts and reveals the settled destination.
  const [washGradient, setWashGradient] = useState(null);
  const [profileSection, setProfileSection] = useState(null);
  const [hasToken, setHasToken] = useState(
    () => !!localStorage.getItem("wrike_user_id")
  );
  const [showOnboarding, setShowOnboarding] = useState(
    () =>
      !localStorage.getItem("xyi_onboarded") &&
      !localStorage.getItem("wrike_user_id")
  );
  const [showReminder, setShowReminder] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const ADMIN_WRIKE_ID = "KUAWDLVN";

  // Keep the URL hash in sync with the active page so a refresh (or a
  // bookmark/shared link) lands back on the same page instead of Home.
  // replaceState, not pushState — this mirrors activePage, it doesn't give
  // browser back/forward its own page-swap semantics (those would fight the
  // wash-transition/AnimatePresence choreography above).
  useEffect(() => {
    const hash = `#${activePage}`;
    if (window.location.hash !== hash) {
      window.history.replaceState({}, "", hash);
    }
  }, [activePage]);

  // Home is deliberately built to own exactly one viewport with no scroll
  // (h-dvh + overflow-hidden, see Home.jsx) — the app-wide 110% zoom
  // (tailwind.css) breaks that invariant, since fixed-px content that used
  // to fit the viewport exactly no longer does once the effective CSS-pixel
  // budget shrinks. Every other page is fine growing past one screen and
  // scrolling; Home specifically isn't supposed to, so it opts out via this
  // class instead of the zoom being dialled back for everyone.
  useEffect(() => {
    document.documentElement.classList.toggle("home-page", activePage === "home");
  }, [activePage]);

  // Reset scroll on page swap — AnimatePresence swaps the content but the
  // window scroll survives it, so navigating from deep in one page would
  // land mid-way down the next. The wash overlay (when present) hides the
  // jump entirely; on pill-nav swaps it happens under the exit fade.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [activePage]);

  // Manual hash edits / back-forward within the hash still land on a valid
  // page instead of a blank state.
  useEffect(() => {
    const onHashChange = () => setActivePage(pageFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Pick up the redirect back from /api/wrike/oauth/callback: stash the
  // member's identity locally (same place useWrikeUser/setWrikeUserId already
  // write to) and strip the params so a refresh doesn't re-process them.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("wrike_connected");
    const error = params.get("wrike_error");

    if (connected) {
      const id = params.get("wrike_user_id");
      if (id) {
        setWrikeUserId(id, {
          firstName: params.get("first_name"),
          lastName: params.get("last_name"),
          email: params.get("email"),
          avatarUrl: params.get("avatar_url"),
        });
        setHasToken(true);
        localStorage.setItem("xyi_onboarded", "1");
        setShowOnboarding(false);
        notify("Connected to Wrike!", "success");
      }
      // Keep the hash (page) — only the OAuth query params get stripped.
      window.history.replaceState({}, "", window.location.pathname + window.location.hash);
    } else if (error) {
      // Surface the specific reason (token_exchange_failed, invalid_state,
      // profile_fetch_failed, …) so a misconfigured secret/redirect is obvious.
      notify(`Couldn't connect to Wrike (${error}). Please try again.`, "error");
      window.history.replaceState({}, "", window.location.pathname + window.location.hash);
    }
  }, []);
  // Hold the wash long enough for the destination to mount and settle
  // (fonts, layout, data-driven shifts happen under it), then lift it.
  useEffect(() => {
    if (!washGradient) return;
    const t = setTimeout(() => setWashGradient(null), 260);
    return () => clearTimeout(t);
  }, [washGradient]);

  const {
    tasks: globalWrikeData,
    folderCampaigns,
    filmCodeMappings,
    isSyncing,
    isScanning,
    lastSynced,
    syncError,
    sync,
    syncNow,
    scanFilmMappings,
  } = useWrikeCache();

  // Motion Board now has its own webhook-fed data source, but the shared
  // cache still feeds Canvas/Hub/Timesheeter. Opening the board is a good
  // moment to nudge a background refresh of that shared cache (soft — a
  // single-field probe that no-ops if data is <15min old).
  useEffect(() => {
    if (activePage === "todayslist") sync();
  }, [activePage, sync]);

  // Which pages this member's department can reach (drives the command
  // palette's nav entries; Home and the Rail read the same registry).
  const department = useDepartment();

  // Warm this member's page chunks once the browser is idle, so the first
  // click on a Home row resolves from cache instead of hitting the network
  // mid-transition. import() dedupes, so re-runs (department resolving from
  // null → real value) are free.
  useEffect(() => {
    const prefetch = () =>
      pagesFor(department).forEach((p) => PAGE_LOADERS[p.id]?.());
    if ("requestIdleCallback" in window) {
      const handle = window.requestIdleCallback(prefetch, { timeout: 4000 });
      return () => window.cancelIdleCallback(handle);
    }
    const t = setTimeout(prefetch, 2000);
    return () => clearTimeout(t);
  }, [department]);

  // Motion Board mounts on first visit (not at startup — its chunk shouldn't
  // load for members who never open it), then stays mounted so board state
  // survives switching away, same as before the code split.
  const [boardVisited, setBoardVisited] = useState(
    () => pageFromHash() === "todayslist"
  );
  useEffect(() => {
    if (activePage === "todayslist") setBoardVisited(true);
  }, [activePage]);

  // Global toast — available to all pages (top-right pill via ToastHost)
  const triggerToast = useCallback(
    (message, type = "error") => notify(message, type),
    []
  );

  // Only MATRIX tasks go to the Canvas
  const filteredData = useMemo(
    () =>
      globalWrikeData.filter((task) =>
        task.title?.toUpperCase().includes("MATRIX")
      ),
    [globalWrikeData]
  );

  // --- Global command palette ---
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  const [paletteSearch, setPaletteSearch] = useState("");
  const [paletteStatus, setPaletteStatus] = useState(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const searchRef = useRef(null);

  const closePalette = () => {
    setIsPaletteOpen(false);
    setPaletteSearch("");
    setPaletteStatus(null);
    setSelectedIndex(0);
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setIsPaletteOpen((prev) => !prev);
        if (!isPaletteOpen) setSelectedIndex(0);
      }
      if (e.key === "Escape") closePalette();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPaletteOpen]);

  // 5:30pm reminder check
  useEffect(() => {
    const check = () => {
      const now = new Date();
      const h = now.getHours(),
        m = now.getMinutes();
      // Show between 17:30 and 17:45 if not already dismissed today
      if (h === 17 && m >= 30 && m < 45) {
        const key = `xyi_reminder_dismissed_${now.toDateString()}`;
        if (!localStorage.getItem(key)) setShowReminder(true);
      }
    };
    check();
    const interval = setInterval(check, 60000); // check every minute
    return () => clearInterval(interval);
  }, []);

  const dismissReminder = () => {
    localStorage.setItem(
      `xyi_reminder_dismissed_${new Date().toDateString()}`,
      "1"
    );
    setShowReminder(false);
  };

  // Admin check
  const wrikeUserId = localStorage.getItem("wrike_user_id");
  const isAdmin = wrikeUserId === ADMIN_WRIKE_ID;

  // type → icon bg/text colour
  const TYPE_STYLES = {
    Navigation: "bg-indigo-50 text-indigo-600 border-indigo-100",
    Data: "bg-emerald-50 text-emerald-600 border-emerald-100",
    System: "bg-purple-50 text-purple-600 border-purple-100",
    Timer: "bg-amber-50 text-amber-600 border-amber-100",
  };

  // Palette entries derive from the same department registry Home and the
  // Rail use, so the palette only ever offers pages this member can actually
  // reach — and follows renames (e.g. Print Board) automatically. Actions are
  // gated the same way: Tracker exports only if they have the Tracker, board
  // sync only if they have the board, Wrike debug only for the admin.
  const PALETTE_ACTIONS = useMemo(() => {
    const deptPages = pagesFor(department);
    const canManage =
      MANAGEMENT_IDS.length === 0 || MANAGEMENT_IDS.includes(wrikeUserId);
    const hasPage = (id) => deptPages.some((p) => p.id === id);

    const nav = [
      { id: "nav-home", title: "Home", desc: "Back to the landing page", type: "Navigation", icon: HomeIcon },
      ...deptPages.map((p, i) => ({
        id: `nav-${p.id}`, title: p.label, desc: p.desc,
        type: "Navigation", icon: p.icon, hint: String(i + 1),
      })),
    ];
    if (canManage && !hasPage("management")) {
      nav.push({ id: "nav-management", title: PAGES.management.label, desc: PAGES.management.desc, type: "Navigation", icon: Shield });
    }
    if (isAdmin) {
      nav.push({ id: "nav-wriketest", title: "Wrike API", desc: "Debug: fetch and explore raw Wrike data", type: "Navigation", icon: Server });
    }

    const actions = [];
    if (!hasToken) {
      actions.push({ id: "action-connect", title: "Connect Wrike", desc: "Link your Wrike account to pull tasks & timelogs", type: "System", icon: Key });
    }
    if (hasPage("todayslist")) {
      actions.push({ id: "action-sync", title: "Sync Wrike Statuses", desc: `Go to ${boardLabelFor(department)} → Sync`, type: "Data", icon: Zap });
    }
    if (hasPage("timesheet")) {
      actions.push(
        { id: "action-copy-ts", title: "Copy JSON", desc: "Copy your Tracker week to the clipboard", type: "Data", icon: Copy },
        { id: "action-csv", title: "Download CSV", desc: "Export your Tracker week as a CSV file", type: "Data", icon: FileDown },
      );
    }
    actions.push({ id: "action-dark", title: "Toggle Dark Mode", desc: "Switch between light and dark", type: "System", icon: Moon });
    if (hasPage("timesheet")) {
      actions.push({ id: "action-clear", title: "Clear Week's Data", desc: "Delete this week's Tracker tasks", type: "System", icon: Trash2 });
    }
    return [...nav, ...actions];
  }, [department, wrikeUserId, isAdmin, hasToken]);

  const paletteResults = useMemo(() => {
    const query = paletteSearch.toLowerCase();
    if (!query) return PALETTE_ACTIONS;
    return PALETTE_ACTIONS.filter(
      (a) =>
        a.title.toLowerCase().includes(query) ||
        a.desc.toLowerCase().includes(query) ||
        a.type.toLowerCase().includes(query)
    );
  }, [paletteSearch, PALETTE_ACTIONS]);

  const handlePaletteKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, paletteResults.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && paletteResults[selectedIndex]) {
      handleExecuteAction(paletteResults[selectedIndex]);
    } else if (!paletteSearch && /^[1-9]$/.test(e.key)) {
      // The numbered kbd hints are real shortcuts: with an empty search box,
      // pressing a digit jumps straight to that nav entry.
      const hinted = paletteResults.find((a) => a.hint === e.key);
      if (hinted) {
        e.preventDefault();
        handleExecuteAction(hinted);
      }
    }
  };

  // Reset selection when search changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [paletteSearch]);

  const flashStatus = (msg) => {
    setPaletteStatus(msg);
    setTimeout(closePalette, 900);
  };

  const handleExecuteAction = (action) => {
    if (action.id.startsWith("nav-")) {
      setActivePage(action.id.replace("nav-", ""));
      closePalette();
    } else if (action.id === "action-dark") {
      document.documentElement.classList.toggle("dark-theme");
      closePalette();
    } else if (action.id === "action-copy-ts") {
      const data = localStorage.getItem("xyi_timesheet_tasks_v5");
      if (data) {
        navigator.clipboard.writeText(
          JSON.stringify({
            version: 5,
            exportDate: new Date().toISOString(),
            rawTasks: JSON.parse(data),
          })
        );
        flashStatus("✓ JSON copied to clipboard");
      } else {
        flashStatus("No timesheet data found");
      }
    } else if (action.id === "action-csv") {
      const data = localStorage.getItem("xyi_timesheet_tasks_v5");
      if (!data) {
        flashStatus("No timesheet data found");
        return;
      }
      const tasks = JSON.parse(data);
      const fmtSecs = (s) => {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        return `${h}h ${m}m`;
      };
      const headers = [
        "Day",
        "Date",
        "Job",
        "Territory",
        "Category",
        "Time",
        "Notes",
      ];
      const rows = tasks.map((t) => [
        t.dayOfWeek ?? "",
        t.date ?? "",
        t.jobNumber ?? "",
        t.territory ?? "",
        t.category ?? "",
        fmtSecs((t.rawSeconds ?? 0) + (t.additionalSeconds ?? 0)),
        (t.notes ?? "").replace(/"/g, '""'),
      ]);
      const csv = [headers, ...rows]
        .map((r) => r.map((c) => `"${c}"`).join(","))
        .join("\n");
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `Timesheet_${new Date().toISOString().split("T")[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      flashStatus("✓ CSV downloaded");
    } else if (action.id === "action-sync") {
      setActivePage("todayslist");
      closePalette();
    } else if (action.id === "action-connect") {
      closePalette();
      startWrikeOAuth();
    } else if (action.id === "action-clear") {
      closePalette();
      confirmAction({
        title: "Clear the week's data?",
        message: "Every logged task for the week will be deleted. This can't be undone.",
        confirmLabel: "Delete all",
        danger: true,
      }).then((ok) => {
        if (ok) {
          localStorage.removeItem("xyi_timesheet_tasks_v5");
          window.location.reload();
        }
      });
    }
  };

  return (
    <MotionConfig reducedMotion="user">
    <div className="min-h-screen bg-slate-100 transition-colors duration-300">
      <Rail activePage={activePage} setActivePage={setActivePage} />

      {/* ── Onboarding modal ─────────────────────────────────────────────── */}
      {showOnboarding && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-[#122027]/70 backdrop-blur-sm">
          <div className="bg-white rounded-3xl w-full max-w-md shadow-2xl border border-[#dce4ec] overflow-hidden">
            <div className="h-1.5 bg-gradient-to-r from-[#12a0e1] to-[#1cc1a5]" />
            <div className="p-8">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#12a0e1] to-[#1cc1a5] flex items-center justify-center mb-5 shadow-lg shadow-[#12a0e1]/20">
                <CheckCircle2 className="w-7 h-7 text-white" />
              </div>
              <h2 className="text-2xl font-black text-[#122027] tracking-tight">
                Welcome to Timesheeter
              </h2>
              <p className="text-sm text-[#768994] mt-2 leading-relaxed">
                To get started, connect your{" "}
                <span className="font-bold text-[#122027]">Wrike account</span>
                . This lets the app fetch your tasks, timelogs, and timers
                automatically — no token to copy or paste.
              </p>
              <div className="mt-5 space-y-3">
                {[
                  "Click Connect to Wrike below",
                  "Approve access on Wrike's own site",
                  "You're back here, fully set up",
                ].map((step, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <span className="w-5 h-5 rounded-full bg-[#12a0e1]/10 text-[#12a0e1] text-[10px] font-black flex items-center justify-center shrink-0 mt-0.5">
                      {i + 1}
                    </span>
                    <p className="text-sm text-[#768994] font-medium">{step}</p>
                  </div>
                ))}
              </div>
              <div className="mt-6 flex gap-3">
                <button
                  onClick={() => {
                    localStorage.setItem("xyi_onboarded", "1");
                    startWrikeOAuth();
                  }}
                  className="flex-1 bg-[#12a0e1] hover:bg-[#0d8bc4] text-white text-sm font-black py-3 rounded-xl transition-all shadow-sm"
                >
                  Connect to Wrike →
                </button>
                <button
                  onClick={() => {
                    setShowOnboarding(false);
                    localStorage.setItem("xyi_onboarded", "1");
                  }}
                  className="px-4 py-3 text-sm font-bold text-[#768994] hover:text-[#122027] rounded-xl hover:bg-slate-50 transition-all border border-[#dce4ec]"
                >
                  Skip
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── 5:30pm reminder ───────────────────────────────────────────────── */}
      {showReminder && (
        <div className="fixed bottom-6 right-6 z-[9998] w-80 bg-white border border-[#dce4ec] rounded-2xl shadow-xl overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-amber-400 to-orange-400" />
          <div className="p-4">
            <div className="flex items-start gap-3">
              <div className="p-2 bg-amber-50 rounded-xl shrink-0">
                <Bell className="w-4 h-4 text-amber-500" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-black text-[#122027]">
                  Time to log your hours!
                </p>
                <p className="text-xs text-[#768994] mt-0.5">
                  It's 5:30 — don't forget to pull your Wrike timelogs before
                  EOD.
                </p>
              </div>
              <button
                onClick={dismissReminder}
                className="text-[#768994] hover:text-[#122027] shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => {
                  setActivePage("timesheet");
                  dismissReminder();
                }}
                className="flex-1 bg-[#12a0e1] hover:bg-[#0d8bc4] text-white text-xs font-black py-2 rounded-xl transition-all"
              >
                Go to Timesheeter
              </button>
              <button
                onClick={dismissReminder}
                className="px-3 text-xs font-bold text-[#768994] hover:bg-slate-50 rounded-xl border border-[#dce4ec] transition-all"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Admin button (only visible to KUAWDLVN) ───────────────────────── */}
      {isAdmin && (
        <button
          onClick={() => setShowAdmin(true)}
          className="fixed bottom-6 left-24 z-[9997] flex items-center gap-2 bg-[#122027] hover:bg-[#1a2f3a] text-white text-xs font-black px-3 py-2.5 rounded-xl shadow-lg transition-all"
        >
          <Shield className="w-3.5 h-3.5" /> Admin
        </button>
      )}

      {/* ── Admin modal ───────────────────────────────────────────────────── */}
      {showAdmin && isAdmin && (
        <Suspense fallback={null}>
          <AdminModal onClose={() => setShowAdmin(false)} />
        </Suspense>
      )}

      {/* ── Department preview indicator (self-hides when no preview is set,
           see AdminModal's "Preview as" switcher) ─────────────────────────── */}
      <DepartmentPreviewBanner />

      {/* Global no-token banner — home renders its own compact chip instead,
          and pt-3 (not mt-3) so the margin can't collapse through the app
          root and expose the document canvas as a dark strip */}
      {!hasToken && activePage !== "profile" && activePage !== "home" && (
        <div className="pl-20 mx-auto max-w-[1400px] px-4 sm:px-6 pt-3">
          <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 flex items-center gap-3">
            <Key className="w-4 h-4 text-amber-600 shrink-0" />
            <p className="text-xs font-bold text-amber-800 flex-1">
              Wrike not connected — some features won't work until you connect it.
            </p>
            <button
              onClick={() => setActivePage("profile")}
              className="text-xs font-black text-amber-600 hover:text-amber-800 underline underline-offset-2 shrink-0 transition-colors"
            >
              Add in Profile →
            </button>
          </div>
        </div>
      )}

      {/* Command palette */}
      {isPaletteOpen && (
        <div
          className="fixed inset-0 z-[9999] flex items-start justify-center pt-[15vh] p-4 bg-[#122027]/60 backdrop-blur-sm animate-in fade-in duration-200"
          onClick={closePalette}
        >
          <div
            className="bg-white rounded-3xl w-full max-w-xl shadow-2xl flex flex-col border border-[#dce4ec] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Search bar */}
            <div className="p-4 border-b border-[#dce4ec] flex items-center gap-3 bg-slate-50/50">
              <Command className="w-5 h-5 text-[#12a0e1] shrink-0" />
              <input
                ref={searchRef}
                autoFocus
                type="text"
                value={paletteSearch}
                onChange={(e) => setPaletteSearch(e.target.value)}
                onKeyDown={handlePaletteKeyDown}
                placeholder="Search commands…"
                className="flex-1 bg-transparent text-base font-medium text-[#122027] outline-none placeholder:text-[#768994]"
              />
              <kbd className="text-[10px] font-black text-[#768994] bg-white px-2 py-1 rounded-md border border-[#dce4ec] shadow-sm">
                ESC
              </kbd>
            </div>

            {/* Status flash */}
            {paletteStatus ? (
              <div className="p-6 text-center text-sm font-bold text-[#1cc1a5]">
                {paletteStatus}
              </div>
            ) : (
              <div className="max-h-[60vh] overflow-y-auto p-2">
                {paletteResults.length === 0 ? (
                  <div className="p-10 text-center text-[#768994] flex flex-col items-center gap-2">
                    <Search className="w-7 h-7 opacity-30" />
                    <p className="text-sm font-medium">
                      No results for "{paletteSearch}"
                    </p>
                  </div>
                ) : (
                  paletteResults.map((result, i) => {
                    const Icon = result.icon;
                    const iconStyle =
                      TYPE_STYLES[result.type] ??
                      "bg-slate-50 text-slate-500 border-slate-100";
                    const isSelected = i === selectedIndex;
                    return (
                      <button
                        key={result.id}
                        onClick={() => handleExecuteAction(result)}
                        onMouseEnter={() => setSelectedIndex(i)}
                        className={`w-full text-left px-3 py-3 rounded-xl flex items-center gap-3 transition-colors ${
                          isSelected ? "bg-slate-100" : "hover:bg-slate-50"
                        }`}
                      >
                        <div
                          className={`w-9 h-9 rounded-xl border flex items-center justify-center shrink-0 ${iconStyle}`}
                        >
                          <Icon className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-black text-[#122027] tracking-tight">
                            {result.title}
                          </p>
                          <p className="text-[11px] text-[#768994] font-medium truncate">
                            {result.desc}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {result.hint && (
                            <kbd className="text-[10px] font-black text-[#768994] bg-white px-1.5 py-0.5 rounded border border-[#dce4ec]">
                              {result.hint}
                            </kbd>
                          )}
                          <span
                            className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${iconStyle}`}
                          >
                            {result.type}
                          </span>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            )}

            {/* Footer hints */}
            {!paletteStatus && (
              <div className="px-4 py-2.5 border-t border-[#dce4ec] bg-slate-50/50 flex items-center gap-4 text-[10px] font-bold text-[#768994]">
                <span>
                  <kbd className="bg-white border border-[#dce4ec] px-1.5 py-0.5 rounded text-[9px]">
                    ↑↓
                  </kbd>{" "}
                  Navigate
                </span>
                <span>
                  <kbd className="bg-white border border-[#dce4ec] px-1.5 py-0.5 rounded text-[9px]">
                    ↵
                  </kbd>{" "}
                  Execute
                </span>
                <span>
                  <kbd className="bg-white border border-[#dce4ec] px-1.5 py-0.5 rounded text-[9px]">
                    ESC
                  </kbd>{" "}
                  Close
                </span>
                <span className="ml-auto opacity-50">Space = timer toggle</span>
              </div>
            )}
          </div>
        </div>
      )}

      <ThemeToggle />

      <ToastHost />

      <ConfirmHost />

      {/* Motion Board stays mounted (display:none when inactive) so its board
          state survives switching away — kept outside the transition below
          so it's never unmounted/remounted by AnimatePresence. It sources
          its own data independently (useMotionBoardTasks) rather than from
          globalWrikeData below; wrikeData is only passed through for the
          task detail modal's lookups. */}
      {boardVisited && (
        <div className={`pl-20 ${activePage === "todayslist" ? "block" : "hidden"}`}>
          <Suspense fallback={activePage === "todayslist" ? <PageLoading /> : null}>
            <TodaysList
              wrikeData={globalWrikeData}
              triggerToast={triggerToast}
              isActive={activePage === "todayslist"}
              department={department}
            />
          </Suspense>
        </div>
      )}

      {/* Wash overlay: takes over from Home's expanded row fill the frame
          the page swaps (identical gradient, identical coverage), then lifts
          like a curtain to reveal the destination already in place. */}
      <AnimatePresence>
        {washGradient && (
          <motion.div
            key="wash-overlay"
            className={`fixed inset-0 z-[95] pointer-events-none bg-gradient-to-r ${washGradient}`}
            initial={false}
            animate={{ y: 0 }}
            exit={{ y: "-100%" }}
            transition={{ duration: 0.4, ease: [0.76, 0, 0.24, 1] }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence mode="wait" custom={!!washGradient}>
        {activePage !== "todayslist" && (
          <motion.div
            key={activePage}
            custom={!!washGradient}
            variants={PAGE_VARIANTS}
            initial="initial"
            animate="animate"
            exit="exit"
            className={activePage === "home" ? "" : "pl-20"}
          >
            {/* Suspense sits INSIDE the motion.div: a still-loading chunk
                suspends to the quiet PageLoading fallback within the entrance
                animation, instead of unmounting the AnimatePresence tree. */}
            <Suspense fallback={<PageLoading />}>
            {activePage === "home" && (
              <Home
                onNavigate={(id, gradient) => {
                  if (gradient) setWashGradient(gradient);
                  setActivePage(id);
                }}
                hasToken={hasToken}
              />
            )}

            {activePage === "timesheet" && (
              <Tracker
                wrikeData={globalWrikeData}
                onNavigateToHub={(section) => {
                  setProfileSection(section);
                  setActivePage("profile");
                }}
              />
            )}
            {activePage === "canvas" && (
              <CampaignCanvas
                wrikeData={filteredData}
                folderCampaigns={folderCampaigns}
                triggerToast={triggerToast}
                isLoading={
                  !!localStorage.getItem("wrike_user_id") &&
                  globalWrikeData.length === 0
                }
                syncNow={syncNow}
                isSyncing={isSyncing}
                isAdmin={isAdmin}
                scanFilmMappings={scanFilmMappings}
                isScanning={isScanning}
                filmCodeMappings={filmCodeMappings}
              />
            )}
            {activePage === "wriketest" && (
              <WrikeTest
                wrikeData={globalWrikeData}
                syncNow={syncNow}
                isSyncing={isSyncing}
                lastSynced={lastSynced}
                syncError={syncError}
              />
            )}
            {activePage === "legacy" && (
              <LegacyTimesheet wrikeData={globalWrikeData} isAdmin={isAdmin} />
            )}
            {activePage === "profile" && (
              <Profile
                wrikeData={globalWrikeData}
                onTokenChange={(val) => setHasToken(val)}
                activeSection={profileSection}
                setActiveSection={setProfileSection}
              />
            )}
            {activePage === "management" && (
              <Management wrikeUserId={wrikeUserId} department={department} wrikeData={globalWrikeData} />
            )}
            {activePage === "jobbook" && <JobBook />}
            </Suspense>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
    </MotionConfig>
  );
}
