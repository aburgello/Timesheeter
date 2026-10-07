import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Shield, ChevronLeft, ChevronRight, ClipboardList } from "lucide-react";
import PageHeader from "./shared/PageHeader";
import StudioAnalytics from "./StudioAnalytics";
import { isManager } from "../lib/access";
import { AdminHub } from "./management/AdminHub";
import { FilmCampaignModal } from "./management/FilmCampaignModal";
import { FeedbackSection } from "./management/FeedbackSection";
import { FilmStudioPicker } from "./management/FilmStudioPicker";
import { JobsFeedSection } from "./management/JobsFeedSection";
import { findNavItem, sectionFromHash } from "./management/nav";
import { PeopleSection } from "./management/PeopleSection";
import { PositionsAndRatesSection } from "./management/PositionsAndRatesSection";
import { SimpleListSection } from "./management/SimpleListSection";
import { TranslationCountriesSection } from "./management/TranslationCountriesSection";


// SEED_FILMS is gone with DEFAULT_JOBS. It only ever rendered a "seed this
// table" button while `films` was empty, and that table has been populated for
// a while — Film Setup pulls films straight from Wrike (planFilmSync), which is
// a better source than film titles scraped out of a hardcoded job catalogue.

// Access control lives in lib/access.js (App and the Rail read it at startup;
// importing it from this lazy-loaded chunk would drag Administration into the
// main bundle). Re-exported here for compatibility.

// ── Project Description quick-filter chips ────────────────────────────────────
// keyword uses "<CODE> " (with trailing space) so "UK Something" matches but
// hypothetical "BULK" wouldn't. Gradients mirror DESCRIPTION_GROUPS.
const DESC_QUICK_FILTERS = [
  { label: "AUS", keyword: "AUS ", gradient: "from-green-500 to-emerald-600"   },
  { label: "UK",  keyword: "UK ",  gradient: "from-blue-500 to-blue-700"       },
  { label: "DOM", keyword: "DOM ", gradient: "from-amber-400 to-orange-500"    },
  { label: "INT", keyword: "INT ", gradient: "from-violet-500 to-violet-700"   },
  { label: "IRE", keyword: "IRE ", gradient: "from-emerald-400 to-teal-600"    },
  { label: "XYi", keyword: "XYi ", gradient: "from-[#12a0e1] to-[#0872a0]"   },
];

// ── Studio quick-filter groups (for Clients tab) ──────────────────────────────
const STUDIO_GROUPS = [
  { label: "Universal", keyword: "Universal", gradient: "from-blue-500 to-indigo-700"   },
  { label: "Paramount", keyword: "Paramount", gradient: "from-sky-400 to-blue-700"      },
  { label: "Sony",      keyword: "Sony",      gradient: "from-slate-600 to-slate-900"   },
  { label: "Disney",    keyword: "Disney",    gradient: "from-blue-400 to-violet-700"   },
  { label: "Warner",    keyword: "Warner",    gradient: "from-cyan-500 to-blue-700"     },
  { label: "Netflix",   keyword: "Netflix",   gradient: "from-red-500 to-red-800"       },
  { label: "Apple",     keyword: "Apple",     gradient: "from-slate-400 to-slate-700"   },
  { label: "Amazon",    keyword: "Amazon",    gradient: "from-amber-400 to-orange-600"  },
  { label: "XYi",      keyword: "XYi",       gradient: "from-[#12a0e1] to-[#0872a0]"  },
];

// ── Category groups ────────────────────────────────────────────────────────────
// Prefix match is first-wins — Misc catches only what Digital/Print/XYi don't.
const CATEGORY_GROUPS = [
  {
    label: "Digital",
    color: "bg-cyan-50 text-cyan-700 border-cyan-200",
    gradient: "from-cyan-500 to-sky-600",
    match: s => s.startsWith("Digital"),
    stripPrefix: "Digital - ",
  },
  {
    label: "Print",
    color: "bg-orange-50 text-orange-700 border-orange-200",
    gradient: "from-orange-400 to-orange-600",
    match: s => s.startsWith("Print"),
    stripPrefix: "Print - ",
  },
  {
    label: "XYi",
    color: "bg-violet-50 text-violet-700 border-violet-200",
    gradient: "from-violet-500 to-violet-700",
    match: s => s.startsWith("XYi"),
    stripPrefix: "XYi - ",
  },
  {
    label: "Misc",
    color: "bg-slate-50 text-slate-600 border-slate-200",
    gradient: "from-slate-500 to-slate-700",
    match: () => true,
    stripPrefix: "",
  },
];

// ── Project Description groups (territory prefix) ─────────────────────────────
const DESCRIPTION_GROUPS = [
  { label: "AUS", color: "bg-green-50 text-green-700 border-green-200",       gradient: "from-green-500 to-emerald-600",  match: s => /^AUS[\s\-]/i.test(s),  stripPrefix: "" },
  { label: "UK",  color: "bg-blue-50 text-blue-700 border-blue-200",          gradient: "from-blue-500 to-blue-700",       match: s => /^UK[\s\-]/i.test(s),   stripPrefix: "" },
  { label: "DOM", color: "bg-amber-50 text-amber-700 border-amber-200",       gradient: "from-amber-400 to-orange-500",    match: s => /^DOM[\s\-]/i.test(s),  stripPrefix: "" },
  { label: "INT", color: "bg-violet-50 text-violet-700 border-violet-200",    gradient: "from-violet-500 to-violet-700",   match: s => /^INT[\s\-]/i.test(s),  stripPrefix: "" },
  { label: "IRE", color: "bg-emerald-50 text-emerald-700 border-emerald-200", gradient: "from-emerald-400 to-teal-600",    match: s => /^IRE[\s\-]/i.test(s),  stripPrefix: "" },
  { label: "XYi", color: "bg-cyan-50 text-cyan-700 border-cyan-200",         gradient: "from-[#12a0e1] to-[#0872a0]",    match: s => /^XYi[\s\-]/i.test(s),  stripPrefix: "" },
  { label: "Other", color: "bg-slate-50 text-slate-600 border-slate-200",    gradient: "from-slate-500 to-slate-700",     match: () => true,                   stripPrefix: "" },
];

// ── Main Management Page ───────────────────────────────────────────────────────
// Placeholder for report tabs whose data model isn't built yet, so the IA is
// visible and honest about what's coming rather than silently missing.
function ComingSoon({ icon: Icon, title, body, note }) {
  return (
    <div className="flex flex-col items-center text-center py-16 px-6">
      <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#122027] to-[#12a0e1] flex items-center justify-center shadow-lg mb-5">
        {Icon && <Icon className="w-7 h-7 text-white" />}
      </div>
      <span className="text-[10px] font-black uppercase tracking-widest text-[#12a0e1] mb-1">Coming soon</span>
      <h3 className="font-display text-2xl font-bold text-[#122027] tracking-tight">{title}</h3>
      {body && <p className="text-sm text-[#768994] mt-2 max-w-md leading-relaxed">{body}</p>}
      {note && (
        <p className="text-xs text-[#768994] mt-4 max-w-md bg-slate-50 border border-[#dce4ec] rounded-xl px-4 py-3 leading-relaxed">
          {note}
        </p>
      )}
    </div>
  );
}

// Push/pop panel slide — drilling in slides the new panel in from the
// right (direction 1), going back slides the previous panel in from the
// left (direction -1). Same shape as the page-swap fade in App.jsx, just
// with a horizontal offset since this is a nested navigation stack, not a
// full page change.
const HUB_SLIDE_VARIANTS = {
  initial: (dir) => ({ x: dir > 0 ? 28 : -28, opacity: 0 }),
  animate: { x: 0, opacity: 1, transition: { duration: 0.22, ease: [0.16, 1, 0.3, 1] } },
  exit: (dir) => ({ x: dir > 0 ? -28 : 28, opacity: 0, transition: { duration: 0.16, ease: [0.16, 1, 0.3, 1] } }),
};

export default function Management({ wrikeUserId, department, wrikeData = [] }) {
  // expandedGroup is purely a display toggle — which group's items are
  // unfolded inline on the hub, an accordion, not a navigation state.
  // activeTab is the real navigation: null means "still on the hub"
  // (accordion open or not), a value means "showing that item's content".
  const [expandedGroup, setExpandedGroup] = useState(null);
  // Seeded from the hash so a refresh or a shared link opens straight onto the
  // section instead of dropping you back on the hub.
  const [activeTab, setActiveTab] = useState(sectionFromHash);
  // Film whose bulk campaign is open in a modal (from the Films tab).
  const [campaignFilm, setCampaignFilm] = useState(null);
  // Tracks which way the content panel should slide: forward opening an
  // item, backward returning to the hub.
  const [navDirection, setNavDirection] = useState(1);

  const toggleGroup = (id) => setExpandedGroup((g) => (g === id ? null : id));

  // The open item lives in the hash's second segment (`#management/films`), so
  // it's a history entry of its own: back leaves an item for the hub instead of
  // leaving Administration altogether, and a section can be linked to. App.jsx
  // reads only the first segment, so it stays on "management" throughout.
  const setSectionHash = (id, replace) => {
    const hash = id ? `#management/${id}` : "#management";
    if (window.location.hash === hash) return;
    if (replace) window.history.replaceState({}, "", hash);
    else window.history.pushState({}, "", hash);
  };

  const openItem = (id) => { setNavDirection(1); setActiveTab(id); setSectionHash(id); };
  // The accordion stays exactly as it was — going back doesn't collapse
  // the group you were just looking at.
  const backToHub = () => { setNavDirection(-1); setActiveTab(null); setSectionHash(null); };
  // Same, but guarantees the group is open on arrival. Identical to backToHub
  // when you drilled in through the accordion; the difference shows on a deep
  // link (arriving straight at `#management/films`), where no group was ever
  // expanded.
  const backToGroup = (groupId) => { setNavDirection(-1); setExpandedGroup(groupId); setActiveTab(null); setSectionHash(null); };

  // Back/forward between sections. The browser has already changed the hash by
  // the time this fires, so it only mirrors — never writes history back.
  useEffect(() => {
    const onHashChange = () => {
      const next = sectionFromHash();
      setNavDirection(next ? 1 : -1);
      setActiveTab(next);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Escape goes up one level — an open item back to the hub, the same as the
  // breadcrumb (so it pushes history and Forward returns).
  //
  // It defers to anything with a stronger claim on the key. Modals, the command
  // palette and StrictSelect's click-catcher are all high-z layers that cover
  // the viewport, and while one is up Escape belongs to it, not to navigation —
  // closing a half-filled import or job form by unmounting the whole section
  // would throw away typed input. Likewise a focused field, where Escape means
  // "cancel this edit".
  //
  // Both halves of the test matter. z alone isn't enough: QuickActions' bubble
  // is a permanent fixed z-[100], so height alone would mean Escape never
  // fired. Coverage alone isn't enough either, since the page itself is
  // full-height. An overlay is both.
  useEffect(() => {
    if (!activeTab) return;
    const overlayOnScreen = () => {
      for (const el of document.querySelectorAll('[class*="z-["]')) {
        const z = /z-\[(\d+)\]/.exec(el.getAttribute("class") || "");
        if (!z || Number(z[1]) < 50) continue;
        const r = el.getBoundingClientRect();
        if (r.width >= window.innerWidth * 0.8 && r.height >= window.innerHeight * 0.8) return true;
      }
      return false;
    };
    const onKeyDown = (e) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target;
      if (t?.isContentEditable) return;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(t?.tagName)) return;
      if (overlayOnScreen()) return;
      backToHub();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Administration is for people with profiles.is_admin (lib/access.js) — no
  // department opens it. App already sends anyone else home; this is the page
  // refusing on its own account, should it ever be mounted another way.
  const hasAccess = isManager(wrikeUserId);
  if (!hasAccess) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center">
        <div className="bg-white border border-[#dce4ec] rounded-3xl p-10 text-center max-w-sm shadow-xl">
          <div className="w-14 h-14 bg-rose-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Shield className="w-7 h-7 text-rose-500" />
          </div>
          <h2 className="text-xl font-black text-[#122027] mb-2">Access Restricted</h2>
          <p className="text-sm text-[#768994]">This page is for management only.</p>
          {wrikeUserId && (
            <p className="text-[10px] font-mono mt-3 text-slate-400 bg-slate-50 rounded-lg p-2">
              Your ID: {wrikeUserId}
            </p>
          )}
        </div>
      </div>
    );
  }

  const nav = activeTab ? findNavItem(activeTab) : null;

  return (
    <div className="min-h-screen bg-slate-100 text-[#122027] font-sans pb-16">
      {/* Full-bleed gradient header — same PageHeader treatment as every
          other page, so the Home wash resolves into it (see pageGradients). */}
      <PageHeader
        pageId="management"
        icon={Shield}
        title="Administration"
        subtitle="Reports · Staff Accounts · Supporting Content"
      />

      <div className="max-w-[1800px] mx-auto px-4 sm:px-6 pt-6 pb-6">
        {/* Breadcrumb bar. This is page chrome, not panel content, so it sits
            outside the sliding panel — and it has to sit outside the
            overflow-hidden that clipping the slide requires, because
            position:sticky does nothing inside a clipped ancestor. Being
            sticky is the point: Films and Studio Analytics are both long
            enough that the way back used to scroll off the top, leaving no
            exit without scrolling all the way up again.
            The negative margins let the blurred background bleed to the
            content column's edges while the padding keeps the crumbs aligned
            with the panel below. */}
        {nav && (
          <div className="sticky top-0 z-30 -mx-4 sm:-mx-6 mb-4 px-4 sm:px-6 py-3
                          bg-slate-100/85 supports-[backdrop-filter]:bg-slate-100/70 backdrop-blur-md
                          border-b border-[#dce4ec]">
            <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
              <button
                onClick={backToHub}
                className="flex items-center gap-1.5 text-xs font-bold text-[#768994] hover:text-[#122027] bg-white border border-[#dce4ec] hover:border-slate-300 rounded-xl px-3 py-2 shadow-sm transition-[border-color,color] ease-[cubic-bezier(0.16,1,0.3,1)] shrink-0"
              >
                <ChevronLeft className="w-4 h-4" /> Administration
              </button>
              {/* The group crumb goes back to the hub with that group open —
                  which is where you came from, except on a deep link, where
                  nothing was expanded yet. */}
              <ChevronRight className="w-3.5 h-3.5 text-[#b0bec5] shrink-0 hidden sm:block" />
              <button
                onClick={() => backToGroup(nav.group.id)}
                className="hidden sm:block text-xs font-bold text-[#768994] hover:text-[#122027] transition-colors shrink-0 truncate"
              >
                {nav.group.label}
              </button>
              <ChevronRight className="w-3.5 h-3.5 text-[#b0bec5] shrink-0 hidden sm:block" />
              <div className={`w-8 h-8 rounded-xl bg-gradient-to-br ${nav.group.gradient} flex items-center justify-center text-white shadow-sm shrink-0`}>
                <nav.item.icon className="w-4 h-4" />
              </div>
              <h2 className="font-display text-lg sm:text-xl font-bold text-[#122027] tracking-tight truncate">{nav.item.label}</h2>
            </div>
          </div>
        )}

        {/* The hub (with its accordion) and an open item's content are the
            only two panels that ever swap — the accordion itself doesn't
            trigger this, it's a height animation inside the hub panel.
            overflow-hidden clips the 28px travel so nothing peeks past the
            edge mid-transition. */}
        <div className="overflow-hidden">
        <AnimatePresence mode="wait" custom={navDirection} initial={false}>
          <motion.div
            key={nav ? `item:${nav.item.id}` : "hub"}
            custom={navDirection}
            variants={HUB_SLIDE_VARIANTS}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            {!nav && (
              <AdminHub
                expandedGroup={expandedGroup}
                onToggleGroup={toggleGroup}
                onOpenItem={openItem}
              />
            )}

            {/* The item's actual content. Its heading and the way back now
                live in the sticky breadcrumb above, outside this panel. */}
            {nav && (
              <div>
                <div className="bg-white border border-[#dce4ec] rounded-2xl p-6 shadow-sm">
                  {/* Project/Time is the logged-time-per-job feed — same
                      component Job Book uses (JobsFeedSection), not a separate
                      report. */}
                  {activeTab === "project-time" && <JobsFeedSection />}
                  {activeTab === "studio-analytics" && <StudioAnalytics wrikeData={wrikeData} />}
                  {activeTab === "timesheet-completion" && (
                    <ComingSoon
                      icon={ClipboardList}
                      title="Staff Timesheet Completion"
                      body="A live list of which staff haven't submitted their timesheet for a given week, so it's obvious at a glance who still needs to."
                    />
                  )}
                  {activeTab === "feedback"   && <FeedbackSection />}
                  {activeTab === "people"     && <PeopleSection />}
                  {activeTab === "films"      && (
                    <SimpleListSection table="films" labelField="title" label="Films" placeholder="Film title…"
                      wrikeFilmSync onItemClick={setCampaignFilm}
                      renderRowExtra={(item, patchItem) => <FilmStudioPicker item={item} patchItem={patchItem} />} />
                  )}
                  {activeTab === "clients"    && <SimpleListSection table="clients" labelField="name" label="Clients" quickFilters={STUDIO_GROUPS} quickFilterLabel="Filter by studio" />}
                  {activeTab === "categories" && <SimpleListSection table="job_categories" labelField="name" label="Item Categories" groups={CATEGORY_GROUPS} />}
                  {/* Territory-prefixed like project descriptions, so it reuses
                      their group chips rather than the Digital/Print ones. */}
                  {activeTab === "work-categories" && <SimpleListSection table="job_work_categories" labelField="name" label="Job Work Categories" placeholder="e.g. AUS - Publicity…" groups={DESCRIPTION_GROUPS} />}
                  {activeTab === "descs"      && <SimpleListSection table="project_descriptions" labelField="description" label="Project Type Descriptions" isLong quickFilters={DESC_QUICK_FILTERS} quickFilterLabel="Filter by territory" groups={DESCRIPTION_GROUPS} />}
                  {activeTab === "rates"      && <PositionsAndRatesSection />}
                  {activeTab === "translations" && <TranslationCountriesSection />}
                  {activeTab === "departments"  && <SimpleListSection table="job_departments" labelField="name" label="Departments" placeholder="e.g. Print…" />}
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
        </div>
      </div>

      {campaignFilm && (
        <FilmCampaignModal filmTitle={campaignFilm} onClose={() => setCampaignFilm(null)} />
      )}
    </div>
  );
}

// Sections other screens import (JobBook.jsx) live in ./management/ now;
// re-exported here so those imports keep working unchanged.
export { JobsSetupSection } from "./management/JobsSetupSection";
export { JobBookSection } from "./management/JobBookSection";
export { JobsFeedSection } from "./management/JobsFeedSection";
