import {
  Activity,
  LayoutList,
  Layout,
  Timer,
  User,
  Shield,
  Briefcase,
} from "lucide-react";
import { PAGE_GRADIENTS } from "./pageGradients";

// ── The pages registry ───────────────────────────────────────────────────────
// Single source of truth for every top-level page: label, description (Home
// row hover copy), icon, and gradient identity. Home's menu, the Rail, and
// the command palette all derive from this — a rename here renames it
// everywhere.
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
    label: "Motion Board",
    desc: "Team task allocation",
    icon: LayoutList,
    gradient: PAGE_GRADIENTS.todayslist,
  },
  canvas: {
    id: "canvas",
    label: "Digi Canvas",
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
};

// Every valid profiles.department value (matches the Postgres check
// constraint) — used by the admin "preview as department" switcher so it
// never drifts out of sync with what the database actually allows.
export const ALL_DEPARTMENTS = ["AM", "Digital", "Motion", "Operations", "PM", "Print"];

// ── Who sees what ────────────────────────────────────────────────────────────
// Keyed by profiles.department (check constraint: PM | Motion | Digital |
// AM | Operations | Print). Operations mirrors PM (job/management-focused,
// no production board); AM and Digital mirror Motion/Print's own-board setup
// (see boardLabelFor + TodaysList.js's usesDeptRoster) rather than falling
// through to DEFAULT_PAGE_IDS, so every department now has an explicit,
// intentional set instead of an unconfigured default.
export const DEPARTMENT_PAGES = {
  Motion: ["timesheet", "todayslist", "canvas", "legacy", "profile"],
  Print: ["timesheet", "todayslist", "canvas", "legacy", "profile"],
  AM: ["timesheet", "todayslist", "canvas", "legacy", "profile"],
  Digital: ["timesheet", "todayslist", "canvas", "legacy", "profile"],
  PM: ["management", "jobbook", "legacy", "profile"],
  Operations: ["management", "jobbook", "legacy", "profile"],
};

export const DEFAULT_PAGE_IDS = ["timesheet", "todayslist", "canvas", "legacy", "profile"];

// The team board (todayslist) is one page whose identity follows the viewer's
// department — every non-Motion department sees its own "{Department} Board"
// with its own profiles-tagged roster (see TodaysList.js's usesDeptRoster);
// Motion keeps the plain "Motion Board" label and its hardcoded team. Keeps a
// single page id/route while letting the nav label (Home rows, Rail, command
// palette) and the board header adapt per department.
export function boardLabelFor(department) {
  return !department || department === "Motion" ? "Motion Board" : `${department} Board`;
}

export function pageIdsFor(department) {
  return DEPARTMENT_PAGES[department] || DEFAULT_PAGE_IDS;
}

// Returns the page object with any department-specific overrides applied
// (currently just the board label). Used wherever a single page's display
// data is needed for a known viewer department.
export function pageFor(id, department) {
  if (id === "todayslist") return { ...PAGES[id], label: boardLabelFor(department) };
  return PAGES[id];
}

export function pagesFor(department) {
  return pageIdsFor(department).map((id) => pageFor(id, department));
}
