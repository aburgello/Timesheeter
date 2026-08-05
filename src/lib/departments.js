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
// The Timesheeter (Tracker) is Motion-only for now — a deliberate temporary
// narrowing while it settles, not a statement about who it's for. Every other
// department reaches its time through Timesheets (legacy) instead. Undo by
// putting "timesheet" back in the lists below and dropping the redirect in
// App.jsx that stops a stale #timesheet link rendering it anyway.
export const DEPARTMENT_PAGES = {
  Motion: ["timesheet", "todayslist", "canvas", "legacy", "profile"],
  Print: ["todayslist", "canvas", "legacy", "profile"],
  AM: ["todayslist", "canvas", "legacy", "profile"],
  Digital: ["todayslist", "canvas", "legacy", "profile"],
  PM: ["management", "jobbook", "legacy", "profile"],
  Operations: ["management", "jobbook", "legacy", "profile"],
};

// No "timesheet" here either: this is what an untagged profile sees while the
// department loads, and showing a page then taking it away reads worse than
// the Tracker appearing a moment late for the Motion members who keep it.
export const DEFAULT_PAGE_IDS = ["todayslist", "canvas", "legacy", "profile"];

// The team board (todayslist) is one page whose identity follows the viewer's
// department — every non-Motion department sees its own "{Department} Board"
// with its own profiles-tagged roster (see TodaysList.js's usesDeptRoster);
// Motion keeps the plain "Motion Board" label and its hardcoded team. Keeps a
// single page id/route while letting the nav label (Home rows, Rail, command
// palette) and the board header adapt per department.
export function boardLabelFor(department) {
  return !department || department === "Motion" ? "Motion Board" : `${department} Board`;
}

// Same idea for Campaign Canvas, now that its content (Team Board, End of
// Campaign notes, DOOH Specs) varies per department too — "Digi Canvas" stays
// the label for Motion/Digital (its original audience), everyone else gets
// their own name so "Digi" doesn't show up for a department it isn't about.
export function canvasLabelFor(department) {
  return !department || department === "Motion" || department === "Digital"
    ? "Digi Canvas"
    : `${department} Canvas`;
}

// The job-string quick filters on the Timesheeter. Print's outdoor work goes
// out as launches, not DOOH, so the first chip is named for what that
// department actually searches — the rest of the list is common to everyone.
export function jobQuickFiltersFor(department) {
  const first = department === "Print" ? "LAUNCH" : "DOOH";
  return [first, "Titles", "Print", "Digital", "Internal"];
}

// The Timesheeter's subtitle follows the viewer's department the same way the
// board and canvas labels do — Motion sees "Motion Peeps", Print sees "Print
// Peeps", and so on — so the page doesn't greet every department as Motion.
// No department resolved yet (first paint before profiles loads, or an
// untagged profile) falls back to a neutral line rather than guessing.
export function trackerSubtitleFor(department) {
  return department
    ? `Timesheet Tracker for the ${department} Peeps`
    : "Timesheet Tracker";
}

export function pageIdsFor(department) {
  return DEPARTMENT_PAGES[department] || DEFAULT_PAGE_IDS;
}

// Returns the page object with any department-specific overrides applied
// (board label, canvas label). Used wherever a single page's display data is
// needed for a known viewer department.
export function pageFor(id, department) {
  if (id === "todayslist") return { ...PAGES[id], label: boardLabelFor(department) };
  if (id === "canvas") return { ...PAGES[id], label: canvasLabelFor(department) };
  return PAGES[id];
}

export function pagesFor(department) {
  return pageIdsFor(department).map((id) => pageFor(id, department));
}
