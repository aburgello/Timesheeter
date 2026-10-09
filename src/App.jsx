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
  Bell,
  CheckCircle2,
  X,
} from "lucide-react";
import "./Timesheeter.css";
import Rail from "./components/shared/Rail";
import QuickActions from "./components/shared/QuickActions";
import AppErrorBoundary from "./components/shared/AppErrorBoundary";
import ToastHost from "./components/shared/ToastHost";
import ConfirmHost from "./components/shared/ConfirmHost";
import DepartmentPreviewBanner from "./components/shared/DepartmentPreviewBanner";
import { notify } from "./lib/toast";
import Home from "./components/Home";
import { useWrikeCache } from "./hooks/useWrikeCache";
import { PRINT_HUB_RE } from "./lib/wrikeEnrich";
import { pageIdsFor, pagesFor } from "./lib/departments";
import { WrikeConnectionContext } from "./components/shared/PageHeader";
import { useDepartment } from "./hooks/useDepartment";
import { MANAGER_PAGE_IDS, isManager } from "./lib/access";
import { setWrikeUserId, supabase, whenIdentityReady } from "./lib/supabaseClient";
import { autoSyncPeople } from "./lib/peopleSync";
import { startWrikeOAuth } from "./lib/wrikeApi";
import { warmCountryFields } from "./lib/countryField";
import { loadCountryAliases } from "./lib/countryAliases";

// ── Route-level code splitting ───────────────────────────────────────────────
// Every page except Home is its own chunk, so first paint only carries the
// shell + Home — a designer never downloads Administration (2.6k lines),
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
  orderforms: () => import("./components/OrderForms"),
};
const Tracker = lazy(PAGE_LOADERS.timesheet);
const TodaysList = lazy(PAGE_LOADERS.todayslist);
const CampaignCanvas = lazy(PAGE_LOADERS.canvas);
const WrikeTest = lazy(PAGE_LOADERS.wriketest);
const LegacyTimesheet = lazy(PAGE_LOADERS.legacy);
const Profile = lazy(PAGE_LOADERS.profile);
const Management = lazy(PAGE_LOADERS.management);
const JobBook = lazy(PAGE_LOADERS.jobbook);
const OrderForms = lazy(PAGE_LOADERS.orderforms);
const AdminModal = lazy(() => import("./components/AdminModal"));
// Lazy — NotesModal pulls in the whole Canvas module (NotesCanvasCard) and the
// TipTap editor, none of which belong in the always-loaded app entry chunk.
const NotesModal = lazy(() => import("./components/shared/NotesModal"));

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
    transition: { duration: 0.25, ease: [0.16, 1, 0.3, 1] },
  },
  exit: (viaWash) =>
    viaWash
      ? { opacity: 1, transition: { duration: 0 } }
      : {
          opacity: 0,
          y: -12,
          transition: { duration: 0.25, ease: [0.16, 1, 0.3, 1] },
        },
};

// Kept in sync with every `activePage === "..."` check below — the set of
// ids the URL hash is allowed to select on load/refresh. "timesheet" is left
// out while the Timesheeter is hidden (see DEPARTMENT_PAGES), so a bookmark or
// back-button entry for #timesheet lands on Home instead of the Tracker.
const VALID_PAGES = [
  "home", "canvas", "wriketest", "legacy", "profile",
  "management", "jobbook", "orderforms", "todayslist",
];

// The hash is `#page` or `#page/section` — the second segment belongs to the
// page (Administration puts its open item there, see Management.jsx), so only
// the first is read here. Without the split, `#management/films` would fail the
// VALID_PAGES check and bounce to Home.
const pageFromHash = () => {
  const id = window.location.hash.slice(1).split("/")[0];
  return VALID_PAGES.includes(id) ? id : "home";
};

export default function App() {
  const [activePage, setActivePage] = useState(pageFromHash);
  // Gradient classes of the home row currently washing over the screen.
  // While set, a fixed overlay hides the page swap; cleared shortly after
  // so the overlay lifts and reveals the settled destination.
  const [washGradient, setWashGradient] = useState(null);
  const [profileSection, setProfileSection] = useState(null);
  // The Notes Canvas modal, opened from the quick-actions bubble over
  // whatever page is up.
  const [notesModalOpen, setNotesModalOpen] = useState(false);
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
  //
  // pushState, so each page you open is its own history entry and the
  // browser's (or mouse's) back/forward buttons move between pages. Two
  // guards keep that from misbehaving:
  //
  //  - Only the hash's first segment is compared, so a page that owns the
  //    second segment (`#management/films`) isn't clobbered back to
  //    `#management` the moment it sets one.
  //  - The first run replaces instead of pushing. On a cold load the hash is
  //    usually empty while activePage is already "home", and pushing there
  //    would leave a dead entry that swallows the first Back press.
  //
  // A back/forward press needs no write at all: it changes the hash itself,
  // the hashchange listener below updates activePage, and by the time this
  // runs the URL already agrees. That path also skips the wash overlay, which
  // is correct — going back should be instant, not ceremonial.
  const hashPrimed = useRef(false);
  useEffect(() => {
    // The raw segment, not pageFromHash(): a hash naming a page that isn't
    // valid (a stale #timesheet bookmark) gets rewritten to where the member
    // actually landed instead of lingering in the address bar.
    const rawPage = window.location.hash.slice(1).split("/")[0] || "home";
    if (rawPage === activePage) { hashPrimed.current = true; return; }
    const hash = `#${activePage}`;
    if (hashPrimed.current) window.history.pushState({}, "", hash);
    else window.history.replaceState({}, "", hash);
    hashPrimed.current = true;
  }, [activePage]);

  // Which custom field names a market, discovered once per session. Warmed here
  // rather than per-page because the readers are synchronous and live in two
  // different components (the Tracker's guessFieldsFromTask and Legacy's), and
  // both are pinned or neither is. Costs one /customfields call; failing it is
  // survivable — see lib/countryField.js.
  useEffect(() => {
    warmCountryFields();
    loadCountryAliases();
  }, []);

  // An administrator's visit runs the daily people sync from Wrike, once the
  // browser is idle. See lib/peopleSync.js.
  useEffect(() => {
    const uid = localStorage.getItem("wrike_user_id");
    if (!uid || !isManager(uid)) return;
    const run = () => whenIdentityReady()
      .then(() => autoSyncPeople(supabase))
      .catch((err) => console.warn("[People] daily sync failed:", err.message));
    const handle = window.requestIdleCallback ? window.requestIdleCallback(run, { timeout: 30000 }) : setTimeout(run, 10000);
    return () => (window.cancelIdleCallback ? window.cancelIdleCallback(handle) : clearTimeout(handle));
  }, []);

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
    editFilmCode,
  } = useWrikeCache();

  // The team board now has its own webhook-fed data source, but the shared
  // cache still feeds Canvas/Hub/Timesheeter. Opening the board is a good
  // moment to nudge a background refresh of that shared cache (soft — a
  // single-field probe that no-ops if data is <15min old).
  useEffect(() => {
    if (activePage === "todayslist") sync();
  }, [activePage, sync]);

  // Which pages this member's department can reach (drives the command
  // palette's nav entries; Home and the Rail read the same registry).
  const department = useDepartment();

  // pageFromHash validates against every page that EXISTS, not against the ones
  // this member has. Administration and the Job Book are only offered to the
  // managers and (the Job Book) the Project Managers, and hiding the row isn't
  // enough when the address still opens the page. Administration is decided by
  // who you are, so it bounces at once; the Job Book also depends on the
  // department, so it waits for that to load — and shows the loading state
  // meanwhile, see canOpen where the pages are mounted.
  const wrikeUserId = localStorage.getItem("wrike_user_id");
  const canOpen = (id) => pageIdsFor(department, wrikeUserId).includes(id);
  const lockedOut =
    MANAGER_PAGE_IDS.includes(activePage) &&
    !canOpen(activePage) &&
    (activePage === "management" || !!department);
  useEffect(() => {
    if (!lockedOut) return;
    window.location.hash = "";
    setActivePage("home");
  }, [lockedOut]);

  // Warm this member's page chunks once the browser is idle, so the first
  // click on a Home row resolves from cache instead of hitting the network
  // mid-transition. import() dedupes, so re-runs (department resolving from
  // null → real value) are free.
  useEffect(() => {
    const prefetch = () =>
      pagesFor(department, wrikeUserId).forEach((p) => PAGE_LOADERS[p.id]?.());
    if ("requestIdleCallback" in window) {
      const handle = window.requestIdleCallback(prefetch, { timeout: 4000 });
      return () => window.cancelIdleCallback(handle);
    }
    const t = setTimeout(prefetch, 2000);
    return () => clearTimeout(t);
  }, [department, wrikeUserId]);

  // The team board mounts on first visit (not at startup — its chunk shouldn't
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

  // Only Canvas-relevant tasks go to the Canvas: MATRIX tasks (the campaign
  // gallery) plus Print launch hubs + their per-market request subtasks (the
  // Print Launch Tracker tab). Hub subtasks are included BY MEMBERSHIP, not
  // just by title — digital/online launch waves' per-market subtasks carry no
  // "_Print_" marker, so a title-only filter starved the Launch Tracker of
  // exactly those hubs' markets ("No market subtasks synced yet") even though
  // the cache layer (sync/webhook/backfill, which already use this membership
  // rule) had every one of them loaded in memory.
  const filteredData = useMemo(() => {
    const hubSubIds = new Set(
      globalWrikeData
        .filter((t) => t.title && PRINT_HUB_RE.test(t.title))
        .flatMap((t) => t.subTaskIds || [])
    );
    return globalWrikeData.filter(
      (task) =>
        task.title?.toUpperCase().includes("MATRIX") ||
        (task.title && PRINT_HUB_RE.test(task.title)) ||
        hubSubIds.has(task.id)
    );
  }, [globalWrikeData]);

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
  const isAdmin = wrikeUserId === ADMIN_WRIKE_ID;

  const wrikeConnection = useMemo(
    () => ({ connected: hasToken, connect: () => setActivePage("profile") }),
    [hasToken]
  );

  return (
    <MotionConfig reducedMotion="user">
    {/* The "Wrike not connected" notice is drawn by each page's header. */}
    <WrikeConnectionContext.Provider value={wrikeConnection}>
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
                  className="flex-1 bg-[#12a0e1] hover:bg-[#0d8bc4] text-white text-sm font-black py-3 rounded-xl transition-colors shadow-sm"
                >
                  Connect to Wrike →
                </button>
                <button
                  onClick={() => {
                    setShowOnboarding(false);
                    localStorage.setItem("xyi_onboarded", "1");
                  }}
                  className="px-4 py-3 text-sm font-bold text-[#768994] hover:text-[#122027] rounded-xl hover:bg-slate-50 transition-colors border border-[#dce4ec]"
                >
                  Skip
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── 5:30pm reminder ───────────────────────────────────────────────── */}
      {/* Sits above the quick-actions bubble rather than on top of it — this
          corner is the bubble's home, and the reminder is the transient guest. */}
      {showReminder && (
        <div
          role="status"
          className="fixed bottom-24 right-6 z-[9998] w-80 rounded-2xl border border-white/10 bg-gradient-to-b from-[#1f2738] to-[#171e2c] shadow-2xl shadow-black/50 text-slate-300 animate-in fade-in slide-in-from-bottom-2 duration-200"
        >
          <div className="absolute inset-x-0 top-0 h-px rounded-t-2xl bg-gradient-to-r from-transparent via-white/25 to-transparent" />
          <div className="flex items-start gap-3 px-4 pt-4 pb-3.5">
            <div className="w-9 h-9 shrink-0 rounded-xl bg-amber-400/15 text-amber-300 flex items-center justify-center">
              <Bell className="w-[18px] h-[18px]" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-white">Time to log your hours</p>
              <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">
                It's 5:30. Pull your Wrike timelogs before the end of the day.
              </p>
            </div>
            <button
              onClick={dismissReminder}
              aria-label="Dismiss"
              className="-mt-1 -mr-1 p-1.5 shrink-0 rounded-lg text-slate-500 hover:text-white hover:bg-white/10 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex justify-end gap-2 px-4 py-3 border-t border-white/5 bg-black/20 rounded-b-2xl">
            <button
              onClick={dismissReminder}
              className="px-3.5 py-2 text-xs font-bold rounded-lg text-slate-400 hover:text-white border border-white/10 hover:bg-white/5 transition-colors"
            >
              Dismiss
            </button>
            <button
              onClick={() => {
                setActivePage("legacy");
                dismissReminder();
              }}
              className="px-3.5 py-2 text-xs font-bold rounded-lg bg-[#12a0e1] hover:bg-[#0d8bc4] text-white shadow-md shadow-[#12a0e1]/20 transition-colors"
            >
              Go to Timesheets
            </button>
          </div>
        </div>
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

      {/* Shortcut bubble — bottom-right. Dark mode used to float here as its
          own button; it now lives in Profile → Settings (which this bubble
          links straight to), so the corner carries one affordance instead of
          two stacked in the same spot. */}
      <QuickActions
        activePage={activePage}
        department={department}
        wrikeUserId={wrikeUserId}
        onNavigate={(page, section) => {
          setProfileSection(section ?? null);
          setActivePage(page);
        }}
        onOpenNotes={() => setNotesModalOpen(true)}
        onOpenAdmin={isAdmin ? () => setShowAdmin(true) : undefined}
      />

      {/* The bubble's Notes overlay. Lazy, so its code (and the TipTap
          editor) only downloads when first opened. */}
      <Suspense fallback={null}>
        {notesModalOpen && (
          <NotesModal
            department={department}
            onClose={() => setNotesModalOpen(false)}
            onOpenFull={() => {
              setNotesModalOpen(false);
              setActivePage("canvas");
            }}
          />
        )}
      </Suspense>

      <ToastHost />

      <ConfirmHost />

      {/* The team board stays mounted (display:none when inactive) so its
          state survives switching away — kept outside the transition below
          so it's never unmounted/remounted by AnimatePresence. It sources
          its own data independently (useBoardTasks) rather than from
          globalWrikeData below; wrikeData is only passed through for the
          task detail modal's lookups. */}
      {boardVisited && (
        <div className={`md:pl-20 pb-20 md:pb-0 ${activePage === "todayslist" ? "block" : "hidden"}`}>
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
            className={activePage === "home" ? "" : "md:pl-20 pb-20 md:pb-0"}
          >
            {/* The boundary sits around the page content, not the whole app,
                so a page that throws leaves the Rail mounted and navigable —
                a white screen with the reason only in the console is the
                alternative, and that's what used to happen. Keyed on
                activePage so navigating away clears a caught error. */}
            <AppErrorBoundary resetKey={activePage} onGoHome={() => setActivePage("home")}>
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
                editFilmCode={editFilmCode}
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
            {activePage === "management" && canOpen("management") && (
              <Management wrikeUserId={wrikeUserId} department={department} wrikeData={globalWrikeData} />
            )}
            {activePage === "jobbook" && (canOpen("jobbook") ? <JobBook /> : <PageLoading />)}
            {activePage === "orderforms" && (canOpen("orderforms") ? <OrderForms wrikeData={globalWrikeData} /> : <PageLoading />)}
            </Suspense>
            </AppErrorBoundary>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
    </WrikeConnectionContext.Provider>
    </MotionConfig>
  );
}
