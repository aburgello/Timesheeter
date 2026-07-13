import React, { useState, useEffect, useMemo, useCallback } from "react";
import { ChevronDown, Network, RefreshCw, Users } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { cleanNamePart } from "../lib/formatName";
import { isServiceAccount, DEPT_GROUPS } from "../lib/people";

// The real reporting hierarchy from XYi_Design_Organigram_SUMMER_2026.pdf,
// stored as profiles.reports_to (self-referencing wrike_user_id) rather than
// re-derived from department groupings — department says which team someone
// is on, not who they answer to, and the two diverge (e.g. Riccardo Cicero
// manages both Digital and Motion but is tagged one department).
//
// Rendered as a genuine top-down tree — siblings laid out side by side under
// their manager, like the source PDF — rather than an indented vertical
// list. An earlier version used the list (lower layout risk), but at ~60
// people it just didn't read as an org chart. Connector lines are kept
// deliberately simple (one stub down from a parent, one stub up into each
// child) rather than a horizontal bar spanning all siblings, since that
// needs precise width math this environment can't visually pixel-check.

// Explicit rank per known title (lower = shown first among siblings) rather
// than a pure keyword heuristic — "Junior Proofreader & Junior Asset
// Manager" contains "Manager" as a substring, and a plain "Project Manager"
// (no seniority word at all) needs to land between Senior and Midweight, not
// wherever a naive .includes() check happens to catch it first. Covers every
// title on the org chart; anything added later falls through to the
// lightweight keyword guess below.
const TITLE_SENIORITY = {
  "CEO": 0, "Managing Director": 0, "Executive Director": 0,
  "Studio Director": 0, "Creative Director": 0, "Art Director": 0,
  "Digital Studio Manager": 0, "Digital Creative Manager": 0,
  "Chief Technical Officer": 0, "QC Controller": 0,
  "Office Manager": 0, "Administration Director": 0, "Administration Manager": 0,
  "Lead Project Manager": 1, "Lead Digital Designer": 1,
  "Lead Motion Graphic Designer": 1, "UK Lead Creative Artworker": 1,
  "Senior Project Manager": 2, "Senior Proof reader": 2,
  "Senior Digital Designer": 2, "Senior Motion Graphic Designer": 2,
  "Senior Creative Artworker": 2, "Senior Retoucher": 2,
  "Night Shift Senior Creative Artworker": 2,
  "Project Manager": 3, "Proof reader": 3,
  "Midweight Project Manager": 4, "Midweight Digital Creative Artworker": 4,
  "Midweight Motion Graphic Designer": 4, "Midweight Creative Artworker": 4,
  "Midweight Retoucher": 4,
  "Junior Project Manager": 5, "Junior Motion Graphic Designer": 5,
  "Junior Asset Manager": 5, "Junior Proofreader & Junior Asset Manager": 5,
};

function seniorityRank(title) {
  if (!title) return 3; // unlabeled sits with the plain, unqualified tier
  if (title in TITLE_SENIORITY) return TITLE_SENIORITY[title];
  const t = title.toLowerCase();
  if (t.includes("junior")) return 5;
  if (t.includes("mid")) return 4;
  if (t.includes("senior")) return 2;
  if (t.includes("lead")) return 1;
  return 0; // director/manager/controller-shaped titles we haven't seen yet
}

function deptStyle(department) {
  return DEPT_GROUPS.find((g) => g.label === department) || DEPT_GROUPS[DEPT_GROUPS.length - 1];
}

function displayName(p) {
  const first = cleanNamePart(p.first_name);
  const last = cleanNamePart(p.last_name);
  return [first, last].filter(Boolean).join(" ") || p.email || p.wrike_user_id;
}

function initialsOf(p) {
  const first = cleanNamePart(p.first_name);
  const last = cleanNamePart(p.last_name);
  return `${first[0] || ""}${last[0] || ""}`.toUpperCase() || "?";
}

// Depth 0 gets shown auto-expanded down to this many levels on first load —
// deep enough to see real shape (CEO → their direct reports → those people's
// own titles), shallow enough that a manager with 18 reports doesn't render
// their entire org sideways before anyone's asked for it.
const AUTO_EXPAND_DEPTH = 1;

function PersonCard({ node, depth }) {
  const dept = deptStyle(node.department);
  const name = displayName(node);
  return (
    <div
      className={`flex flex-col items-center text-center bg-white rounded-2xl p-3 w-[168px] shrink-0 ${
        depth === 0 ? "border-2 border-[#122027] shadow-md" : "border border-[#dce4ec] shadow-sm"
      }`}
    >
      {node.avatar_url ? (
        <img src={node.avatar_url} alt={name} className="w-11 h-11 rounded-xl object-cover border border-[#dce4ec]" />
      ) : (
        <div className={`w-11 h-11 rounded-xl bg-gradient-to-br ${dept.gradient} text-white flex items-center justify-center font-display font-bold text-sm`}>
          {initialsOf(node)}
        </div>
      )}
      <p className="font-display text-xs font-bold text-[#122027] tracking-tight leading-tight mt-2 truncate w-full" title={name}>
        {name}
      </p>
      {node.positionTitle && (
        <p className="text-[10px] text-[#768994] leading-tight mt-0.5 line-clamp-2" title={node.positionTitle}>
          {node.positionTitle}
        </p>
      )}
      {node.department && (
        <span className={`text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-full border mt-1.5 ${dept.color}`}>
          {node.department}
        </span>
      )}
    </div>
  );
}

function OrgBranch({ node, depth, expanded, onToggle }) {
  const isOpen = expanded.has(node.wrike_user_id);
  const hasReports = node.reports.length > 0;

  return (
    <div className="flex flex-col items-center">
      <div className="relative">
        <PersonCard node={node} depth={depth} />
        {hasReports && (
          <button
            onClick={() => onToggle(node.wrike_user_id)}
            className="absolute -bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-0.5 bg-white border border-[#dce4ec] hover:border-[#12a0e1] hover:text-[#12a0e1] text-[#768994] text-[10px] font-bold rounded-full pl-1.5 pr-2 py-0.5 shadow-sm transition-colors"
          >
            <ChevronDown className={`w-3 h-3 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`} />
            {node.reports.length}
          </button>
        )}
      </div>

      {hasReports && isOpen && (() => {
        // Most direct reports are individual contributors (no reports of
        // their own) — same size/shape, so they pack safely into a wrapping
        // grid instead of one row that just keeps extending sideways (a
        // manager with 18 reports would otherwise be ~3000px wide). The
        // handful who are themselves managers need room to expand their own
        // team downward. These two groups sit SIDE BY SIDE (not one stacked
        // above the other) — stacking made Riccardo's card land directly
        // above Guy's other 17 reports with nothing to separate them, which
        // read as "these 17 report to Riccardo" even though they're his
        // siblings, both reporting to Guy. Side by side, each visibly
        // descends from the same shared line above rather than from
        // whichever branch happens to render first.
        const managers = node.reports.filter((r) => r.reports.length > 0);
        const individualContributors = node.reports.filter((r) => r.reports.length === 0);
        return (
          <>
            <div className="w-px h-6 bg-[#dce4ec]" />
            <div className="flex flex-row items-start justify-center gap-8">
              {managers.length > 0 && (
                <div className="flex flex-row flex-wrap items-start justify-center gap-4">
                  {managers.map((child) => (
                    <OrgBranch key={child.wrike_user_id} node={child} depth={depth + 1} expanded={expanded} onToggle={onToggle} />
                  ))}
                </div>
              )}
              {individualContributors.length > 0 && (
                <div className="flex flex-row flex-wrap items-start justify-center gap-3 max-w-3xl border border-dashed border-[#dce4ec] rounded-2xl p-3">
                  {individualContributors.map((child) => (
                    <PersonCard key={child.wrike_user_id} node={child} depth={depth + 1} />
                  ))}
                </div>
              )}
            </div>
          </>
        );
      })()}
    </div>
  );
}

function collectIdsToDepth(node, depth, maxDepth, out) {
  if (node.reports.length === 0) return;
  if (depth <= maxDepth) out.push(node.wrike_user_id);
  node.reports.forEach((child) => collectIdsToDepth(child, depth + 1, maxDepth, out));
}

function collectAllIds(node, out) {
  out.push(node.wrike_user_id);
  node.reports.forEach((child) => collectAllIds(child, out));
}

export default function OrgChart() {
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: profiles }, { data: positions }] = await Promise.all([
      supabase.from("profiles").select("wrike_user_id, first_name, last_name, email, avatar_url, department, position_id, reports_to"),
      supabase.from("positions").select("id, title"),
    ]);
    const titleById = new Map((positions || []).map((p) => [p.id, p.title]));
    const real = (profiles || [])
      .filter((p) => !isServiceAccount(p.wrike_user_id))
      .map((p) => ({ ...p, positionTitle: titleById.get(p.position_id) || null }));
    setPeople(real);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const { roots, totalCount } = useMemo(() => {
    const byId = new Map(people.map((p) => [p.wrike_user_id, { ...p, reports: [] }]));
    const topLevel = [];
    for (const p of byId.values()) {
      if (p.reports_to && byId.has(p.reports_to)) {
        byId.get(p.reports_to).reports.push(p);
      } else {
        topLevel.push(p);
      }
    }
    // Seniority first (Director/Manager-tier, then Lead, Senior, plain,
    // Midweight, Junior), then alphabetically within the same rank.
    const byRank = (a, b) =>
      seniorityRank(a.positionTitle) - seniorityRank(b.positionTitle) || displayName(a).localeCompare(displayName(b));
    const sortTree = (node) => {
      node.reports.sort(byRank);
      node.reports.forEach(sortTree);
    };
    topLevel.forEach(sortTree);
    topLevel.sort(byRank);

    // A "top-level" person with zero reports isn't actually part of the
    // hierarchy — they just have no manager on file (freelancers, family
    // helping out for a day, anyone the chart doesn't cover). Showing them
    // as a bare root reads as "peer of the CEO", which is wrong — drop them
    // from the chart entirely rather than mis-place them. They're still
    // visible as normal in the People list, just not here.
    const roots = topLevel.filter((r) => r.reports.length > 0);
    let totalCount = 0;
    const countTree = (node) => { totalCount++; node.reports.forEach(countTree); };
    roots.forEach(countTree);

    return { roots, totalCount };
  }, [people]);

  const expandAll = () => {
    const all = [];
    roots.forEach((r) => collectAllIds(r, all));
    setExpanded(new Set(all));
  };
  const collapseAll = () => setExpanded(new Set());
  const toggle = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // First two levels open on load — enough to see the company's real shape
  // (CEO, their direct reports, and those people's own titles) without
  // rendering a manager's entire team sideways before anyone's asked.
  useEffect(() => {
    if (!loading && roots.length && expanded.size === 0) {
      const initial = [];
      roots.forEach((r) => collectIdsToDepth(r, 0, AUTO_EXPAND_DEPTH, initial));
      setExpanded(new Set(initial));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, roots]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 gap-3 text-[#768994]">
        <RefreshCw className="w-5 h-5 animate-spin text-[#12a0e1]" />
        <p className="text-sm font-bold">Loading the org chart…</p>
      </div>
    );
  }

  if (roots.length === 0) {
    return (
      <div className="text-center py-16 text-[#768994]">
        <Network className="w-8 h-8 mx-auto mb-2 opacity-30" />
        <p className="text-sm font-bold">No reporting lines set yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between px-1">
        <span className="flex items-center gap-1.5 text-[10px] font-black text-[#768994] bg-white border border-[#dce4ec] px-2.5 py-1 rounded-full uppercase tracking-wider">
          <Users className="w-3 h-3" /> {totalCount} people
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={expandAll}
            className="text-[11px] font-bold text-[#768994] hover:text-[#12a0e1] transition-colors"
          >
            Expand all
          </button>
          <span className="text-[#dce4ec]">·</span>
          <button
            onClick={collapseAll}
            className="text-[11px] font-bold text-[#768994] hover:text-[#12a0e1] transition-colors"
          >
            Collapse all
          </button>
        </div>
      </div>

      {/* A fully expanded branch (Guy Atherfold's 18 reports, say) can run
          well past the page width — scrolls sideways within its own frame
          rather than breaking the page. */}
      <div className="bg-white border border-[#dce4ec] rounded-2xl p-6 overflow-x-auto">
        <div className="flex flex-row items-start gap-8 w-fit min-w-full justify-center">
          {roots.map((node) => (
            <OrgBranch key={node.wrike_user_id} node={node} depth={0} expanded={expanded} onToggle={toggle} />
          ))}
        </div>
      </div>
    </div>
  );
}
