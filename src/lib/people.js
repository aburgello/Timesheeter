// Wrike accounts that exist purely for Wrike's own plumbing (a shared inbox
// for "all proofreaders", the built-in "Magic Wrike" bot, a catch-all "AM
// Team" login) — not real staff. They show up in profiles like anyone else
// (they've loaded the app / been synced from Wrike contacts), but should
// never appear in a people list or count toward team-size stats.
export const SERVICE_ACCOUNT_IDS = new Set(["KUAUUOEP", "KUARQVAA", "KUARGM7N"]);

export function isServiceAccount(wrikeUserId) {
  return SERVICE_ACCOUNT_IDS.has(wrikeUserId);
}

// Per-department visual identity (bucket colour/gradient) — a
// developer-maintained decision, not something a PM adding a department
// (the assignable NAMES come from the editable job_departments table) should
// auto-generate. Anyone in a department without an entry here lands in the
// "—" catch-all bucket instead of being silently dropped. Lives here (not in
// Management.jsx, where PeopleSection is) so OrgChart.jsx can share the same
// colours without a circular import between the two.
export const DEPT_GROUPS = [
  { label: "PM",         color: "bg-blue-50 text-blue-700 border-blue-200",           gradient: "from-blue-500 to-blue-700"         },
  { label: "Motion",     color: "bg-violet-50 text-violet-700 border-violet-200",     gradient: "from-violet-500 to-violet-700"     },
  { label: "Digital",    color: "bg-cyan-50 text-cyan-700 border-cyan-200",           gradient: "from-cyan-500 to-sky-600"          },
  { label: "AM",         color: "bg-amber-50 text-amber-700 border-amber-200",        gradient: "from-amber-400 to-orange-500"      },
  { label: "Operations", color: "bg-emerald-50 text-emerald-700 border-emerald-200",  gradient: "from-emerald-500 to-teal-600"      },
  { label: "Print",      color: "bg-orange-50 text-orange-700 border-orange-200",     gradient: "from-orange-400 to-orange-600"     },
  { label: "—",          color: "bg-slate-50 text-slate-500 border-slate-200",        gradient: "from-slate-400 to-slate-600"       },
];
