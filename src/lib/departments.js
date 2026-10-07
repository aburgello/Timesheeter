import {
  Activity,
  LayoutList,
  Layout,
  Timer,
  User,
  Shield,
  Briefcase,
  ClipboardList,
} from "lucide-react";
import { PAGE_GRADIENTS } from "./pageGradients";
import { isManager, MANAGER_PAGE_IDS } from "./access";

// ── The pages registry ───────────────────────────────────────────────────────
// Single source of truth for every top-level page: label, description (Home
// row hover copy), icon, and gradient identity. Home's menu and the Rail
// derive from this, so a rename here renames it everywhere.
export const PAGES = {
  timesheet: {
    id: "timesheet",
    label: "Timesheeter",
    desc: "Track today's time",
    icon: Activity,
    gradient: PAGE_GRADIENTS.timesheet,
  },
  todayslist: {
    id: "todayslist",
    label: "Team Board",
    desc: "Team task allocation",
    icon: LayoutList,
    gradient: PAGE_GRADIENTS.todayslist,
  },
  canvas: {
    id: "canvas",
    label: "Campaign Canvas",
    desc: "MATRIX visualiser",
    icon: Layout,
    gradient: PAGE_GRADIENTS.canvas,
  },
  legacy: {
    id: "legacy",
    label: "Timesheets",
    desc: "Company timesheet database",
    icon: Timer,
    gradient: PAGE_GRADIENTS.legacy,
  },
  profile: {
    id: "profile",
    label: "Profile Hub",
    desc: "Your jobs & settings",
    icon: User,
    gradient: PAGE_GRADIENTS.profile,
  },
  management: {
    id: "management",
    label: "Administration",
    desc: "Jobs, people & reference data",
    icon: Shield,
    gradient: PAGE_GRADIENTS.management,
  },
  jobbook: {
    id: "jobbook",
    label: "Job Book",
    desc: "Live job numbers & budgets",
    icon: Briefcase,
    gradient: PAGE_GRADIENTS.jobbook,
  },
  orderforms: {
    id: "orderforms",
    label: "Client Orders",
    desc: "Market orders at a glance",
    icon: ClipboardList,
    gradient: PAGE_GRADIENTS.orderforms,
  },
};

// ── Departments ──────────────────────────────────────────────────────────────
// The department list itself is the job_departments table (Administration ›
// Departments); profiles.department references it. This is only what differs
// between departments. A department missing from here gets TEAM_DEFAULTS, so
// one added in Administration works straight away with the standard setup.
//
//   pages     the pages it sees (Administration, the Job Book and Order Forms
//             are added on top for the managers; see pageIdsFor)
//   features  department-specific Canvas tools: "launchTracker" (per-market
//             print requests), "doohSpecs" (screen specs by country)
//   quickFilter  the first job-search chip on the Timesheeter
//   countedStatus  a Wrike status the board header counts, in place of the
//             default "overdue" count
//
// The Timesheeter (Tracker) page is hidden for everyone: time goes through
// Timesheets (legacy). Its code is kept. Undo by putting "timesheet" back in
// the lists below and in App.jsx's VALID_PAGES.
const TEAM_DEFAULTS = {
  pages: ["todayslist", "canvas", "legacy", "profile"],
  features: [],
  quickFilter: "DOOH",
};

export const DEPARTMENTS = {
  Motion: { features: ["doohSpecs"], countedStatus: "Motion" },
  Print: { features: ["launchTracker"], quickFilter: "LAUNCH" },
  AM: {},
  Digital: {},
  PM: { pages: ["jobbook", "orderforms", "legacy", "profile"] },
  Operations: { pages: ["legacy", "profile"] },
};

const settingsFor = (department) => ({ ...TEAM_DEFAULTS, ...(DEPARTMENTS[department] || {}) });

// Someone with no department yet: their timesheets and profile, and a board
// that asks them to get tagged. Nothing is assumed about which team they're in.
const UNTAGGED_PAGE_IDS = ["todayslist", "legacy", "profile"];

export const hasFeature = (department, feature) =>
  !!department && settingsFor(department).features.includes(feature);

// Departments whose members' Wrike tasks the shared cache keeps: the ones with a
// team board. The Canvas, search and the Toolbox panel all read that cache.
export const usesTeamBoard = (department) =>
  !!department && settingsFor(department).pages.includes("todayslist");

export const countedStatusFor = (department) =>
  (department && settingsFor(department).countedStatus) || null;

export const boardLabelFor = (department) => (department ? `${department} Board` : "Team Board");
export const canvasLabelFor = (department) => (department ? `${department} Canvas` : "Campaign Canvas");

export function jobQuickFiltersFor(department) {
  return [settingsFor(department).quickFilter, "Titles", "Print", "Digital", "Internal"];
}

export function trackerSubtitleFor(department) {
  return department
    ? `Timesheet Tracker for the ${department} Peeps`
    : "Timesheet Tracker";
}

// The pages a member can reach: their department's, led by the manager pages
// for the people who have them. Everything that offers or opens a page (Home,
// the Rail, the quick-actions bubble, App's own guard)
// asks this, so a page can't be hidden in one place and reachable in another.
export function pageIdsFor(department, wrikeUserId) {
  const ids = department ? settingsFor(department).pages : UNTAGGED_PAGE_IDS;
  if (!isManager(wrikeUserId)) return ids;
  return [...MANAGER_PAGE_IDS.filter((id) => !ids.includes(id)), ...ids];
}

// Returns the page object with any department-specific overrides applied
// (board label, canvas label). Used wherever a single page's display data is
// needed for a known viewer department.
export function pageFor(id, department) {
  if (id === "todayslist") return { ...PAGES[id], label: boardLabelFor(department) };
  if (id === "canvas") return { ...PAGES[id], label: canvasLabelFor(department) };
  return PAGES[id];
}

export function pagesFor(department, wrikeUserId) {
  return pageIdsFor(department, wrikeUserId).map((id) => pageFor(id, department));
}
