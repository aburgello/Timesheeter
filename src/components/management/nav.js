// Administration's menu: its sections, how they're grouped, and
// reading the open section from the URL.
//
// Part of Administration. Split out of components/Management.jsx, which is
// still the entry point and re-exports what other screens import.
import { Film, Users, Tag, AlignLeft, Building2, FileBarChart, ClipboardList, Globe, Layers, Network, TrendingUp, Banknote } from "lucide-react";

// Jobs (Setup / Book / Feed) deliberately live on the standalone Job Book
// page now (JobBook.jsx) — Administration keeps Reports, Staff Accounts, and
// the reference-data lists, matching the PMs' mental model.
//
// Navigation is a two-level drill-down (group -> item), the same HubRow
// idiom Profile Hub uses, instead of an 11-wide tab bar. One decision at a
// time, in a shape a manager already knows from the rest of the app — that
// consistency is the whole point of this structure, not a tab count problem.
export const NAV_GROUPS = [
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
export function findNavItem(id) {
  for (const group of NAV_GROUPS) {
    const item = group.items.find((i) => i.id === id);
    if (item) return { group, item };
  }
  return null;
}
// The open item as read from `#management/<section>`. Validated against
// NAV_GROUPS, so a stale or hand-edited link lands on the hub rather than on a
// panel that renders nothing.
export const sectionFromHash = () => {
  const [page, section] = window.location.hash.slice(1).split("/");
  return page === "management" && section && findNavItem(section) ? section : null;
};
