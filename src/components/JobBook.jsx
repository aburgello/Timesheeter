import React, { useState, useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Briefcase, FolderPlus, Activity } from "lucide-react";
import PageHeader from "./shared/PageHeader";
import { JobsSetupSection, JobBookSection, JobsFeedSection } from "./Management";
import { PAGE_GRADIENTS } from "../lib/pageGradients";

gsap.registerPlugin(useGSAP);

// The PMs' day-to-day surface: every Jobs tool on one page — Setup, the
// Book itself, and the Feed — without the rest of Administration around
// them. Same section components Administration renders in its Jobs tabs;
// one implementation, two doors. Tab ids deliberately match Management's
// ("jobsSetup" / "jobs" / "feed") so the sections' internal deep-links
// (e.g. Jobs Setup's "View in Job Book") work unchanged via setTab.
const TABS = [
  { id: "jobsSetup", label: "Jobs Setup", desc: "Create new job numbers", icon: FolderPlus },
  { id: "jobs",      label: "Job Book",   desc: "Live budgets & tracking", icon: Briefcase },
  { id: "feed",      label: "Jobs Feed",  desc: "Every logged hour by job", icon: Activity },
];

// Play the masked-rise entrance once per session — same contract as
// Profile Hub's own hub rows (see profileEntrancePlayed in Profile.jsx).
let jobBookEntrancePlayed = false;

const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function JobBook() {
  const [tab, setTab] = useState("jobs");
  const navRef = useRef(null);

  // Same masked-rise reveal as Profile Hub's rows (data-hub-rise, translated
  // fully below its own overflow-hidden mask, then eased up into view) —
  // reused here rather than reinvented, so this reads as the same "hub"
  // vocabulary at a different layout, not a new animation idiom.
  useGSAP(
    () => {
      if (!navRef.current || prefersReducedMotion()) return;
      const rises = gsap.utils.toArray("[data-hub-rise]", navRef.current);
      if (!rises.length || jobBookEntrancePlayed) return;
      jobBookEntrancePlayed = true;
      gsap.set(rises, { yPercent: 120 });
      gsap.to(rises, {
        yPercent: 0,
        duration: 0.6,
        ease: "expo.out",
        stagger: 0.08,
      });
    },
    { scope: navRef }
  );

  return (
    <div className="min-h-screen bg-slate-100 text-[#122027] font-sans pb-16">
      <PageHeader
        pageId="jobbook"
        icon={Briefcase}
        title="Job Book"
        subtitle="Live job numbers, setup & feed"
      />

      <div className="max-w-[1800px] mx-auto px-4 sm:px-6 py-6">
        {/* Three doors instead of a small pill switcher — same hover-sweep/
            icon-chip language HubRow uses, laid out as equal columns since
            these are three peer tools, not a stacked drill-down list. The
            active one stays permanently filled with the page's own
            gradient (not just on hover) so it still reads as "you are
            here" once the pointer moves away. */}
        {/* rounded-t-2xl (not rounded-2xl) since this sits flush against
            the content panel below — only the outer two buttons need
            their own matching top corner, the bottom stays square. */}
        <div ref={navRef} className="grid grid-cols-1 sm:grid-cols-3 gap-px bg-[#dce4ec] border border-[#dce4ec] border-b-0 rounded-t-2xl overflow-hidden shadow-sm">
          {TABS.map(({ id, label, desc, icon: Icon }) => {
            const isActive = tab === id;
            return (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`group relative flex flex-col items-start gap-3 p-6 text-left overflow-hidden transition-colors duration-300 ${
                  isActive ? `bg-gradient-to-br ${PAGE_GRADIENTS.jobbook}` : "bg-white"
                }`}
              >
                {/* Hover sweep only for the inactive doors — the active one
                    already carries the fill permanently. */}
                {!isActive && (
                  <div
                    className={`absolute inset-0 bg-gradient-to-br ${PAGE_GRADIENTS.jobbook} origin-left scale-x-0 group-hover:scale-x-100 transition-transform duration-300 ease-out`}
                  />
                )}

                <div
                  className={`relative z-10 w-11 h-11 rounded-2xl flex items-center justify-center transition-colors duration-300 ${
                    isActive
                      ? "bg-white/20 text-white"
                      : `bg-gradient-to-br ${PAGE_GRADIENTS.jobbook} text-white group-hover:bg-none group-hover:bg-white/20`
                  }`}
                >
                  <Icon className="w-5 h-5" />
                </div>

                <div className="relative z-10 min-w-0 overflow-hidden">
                  <div data-hub-rise>
                    <p
                      className={`font-display text-lg font-bold tracking-tight transition-colors duration-300 ${
                        isActive ? "text-white" : "text-[#122027] group-hover:text-white"
                      }`}
                    >
                      {label}
                    </p>
                    <p
                      className={`text-xs mt-1 transition-colors duration-300 ${
                        isActive ? "text-white/80" : "text-[#768994] group-hover:text-white/80"
                      }`}
                    >
                      {desc}
                    </p>
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* rounded-b-2xl, not rounded-2xl — the top edge is now the seam
            with the door row above (its border-t is the only divider
            line between the two, since the door row itself has
            border-b-0), not a separate rounded corner of its own. */}
        <div className="bg-white border border-[#dce4ec] rounded-b-2xl p-6 shadow-sm">
          {tab === "jobsSetup" && <JobsSetupSection setActiveTab={setTab} />}
          {tab === "jobs" && <JobBookSection setActiveTab={setTab} />}
          {tab === "feed" && <JobsFeedSection />}
        </div>
      </div>
    </div>
  );
}
