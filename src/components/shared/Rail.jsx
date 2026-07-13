import React, { useState, useEffect } from "react";
import { Home } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { MANAGEMENT_IDS } from "../../lib/access";
import { PAGE_GRADIENTS } from "../../lib/pageGradients";
import { PAGES, pageIdsFor, pageFor } from "../../lib/departments";
import { useDepartment } from "../../hooks/useDepartment";

// Replaces the old pill navbar (NavPill.js) — a slim, always-present rail
// instead of a floating top bar, so each page's own header (PageHeader) can
// carry the full-bleed gradient treatment without competing with a nav bar
// for the top of the screen. Hidden entirely on Home, same as the old nav.
// Section icons come from the pages registry filtered by department (see
// src/lib/departments.js), including Administration; only Profile gets its
// own dedicated avatar slot at the foot of the rail.
export default function Rail({ activePage, setActivePage }) {
  const [initials, setInitials] = useState("");
  const wrikeUserId = localStorage.getItem("wrike_user_id");
  const department = useDepartment();
  // Administration rides in the main icon list alongside the other pages —
  // present for departments whose set includes it (PMs) and for the
  // hardcoded admin allowlist, appended if the department set omits it.
  const railIds = pageIdsFor(department).filter((id) => id !== "profile");
  const isAdmin =
    MANAGEMENT_IDS.length === 0 || MANAGEMENT_IDS.includes(wrikeUserId);
  if (isAdmin && !railIds.includes("management")) railIds.push("management");
  const sections = railIds.map((id) => pageFor(id, department));

  useEffect(() => {
    if (!wrikeUserId) return;
    supabase
      .from("profiles")
      .select("first_name, last_name")
      .eq("wrike_user_id", wrikeUserId)
      .single()
      .then(({ data }) => {
        if (data) {
          const f = data.first_name?.[0] || "";
          const l = data.last_name?.[0] || "";
          setInitials((f + l).toUpperCase() || "?");
        }
      });
  }, [wrikeUserId]);

  if (activePage === "home") return null;

  // A row inside the rail: fixed 56px icon slot on the left (so icons never
  // shift between collapsed/expanded), with a label that fades in only once
  // the rail expands on hover. overflow-hidden clips the label while collapsed.
  const railRowClass = (active, activeGrad) =>
    `group/row relative z-10 flex items-center h-14 rounded-2xl overflow-hidden transition-colors shrink-0 ${
      active
        ? `bg-gradient-to-br ${activeGrad} text-white shadow-lg`
        : "text-[#768994] hover:text-[#122027] hover:bg-slate-100"
    }`;
  const railLabelClass =
    "text-sm font-bold whitespace-nowrap pr-4 opacity-0 group-hover/rail:opacity-100 transition-opacity duration-200";

  return (
    // group/rail + hover:w-64 turns the slim icon rail into a labelled flyout
    // on hover (overlays content, doesn't push it — it's fixed). overflow-hidden
    // clips the labels flush to the animating width.
    <nav className="group/rail fixed left-0 top-0 bottom-0 z-40 w-20 hover:w-64 overflow-hidden flex flex-col gap-1.5 px-3 py-5 bg-white/80 hover:bg-white/95 backdrop-blur-md border-r border-black/5 transition-[width,background-color] duration-300 ease-out">
      {/* Colour wash at the rail's top — the active page's gradient, faded
          out downward, so the rail head picks up the header's colour instead
          of reading as a detached white strip. Sits over the nav's white bg
          but under the buttons. */}
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 top-0 h-36 bg-gradient-to-br ${
          PAGE_GRADIENTS[activePage] || PAGE_GRADIENTS.management
        } opacity-35 [mask-image:linear-gradient(to_bottom,black,transparent)]`}
      />

      <button
        onClick={() => setActivePage("home")}
        title="Home"
        className="group/row relative z-10 flex items-center h-14 rounded-2xl overflow-hidden border border-dashed border-[#dce4ec] text-[#768994] hover:border-[#12a0e1] hover:text-[#12a0e1] transition-colors shrink-0 mt-4"
      >
        <span className="w-14 h-14 shrink-0 flex items-center justify-center">
          <Home className="w-6 h-6" strokeWidth={2.25} />
        </span>
        <span className={railLabelClass}>Home</span>
      </button>

      {/* Vertical space sets the Home button apart from the section
          switchers — no visible rule (kept transparent). */}
      <div className="mt-6 mb-4 shrink-0" />

      <div className="relative z-10 flex flex-col gap-1.5 flex-1 pt-2">
        {sections.map(({ id, label, icon: Icon }) => {
          const isActive = activePage === id;
          return (
            <button
              key={id}
              onClick={() => setActivePage(id)}
              title={label}
              className={railRowClass(isActive, PAGE_GRADIENTS[id])}
            >
              <span className="w-14 h-14 shrink-0 flex items-center justify-center">
                <Icon className="w-6 h-6" strokeWidth={isActive ? 2.5 : 2} />
              </span>
              <span className={railLabelClass}>{label}</span>
            </button>
          );
        })}
      </div>

      <button
        onClick={() => setActivePage("profile")}
        title="Your profile & hub"
        className={`group/row relative z-10 flex items-center h-14 rounded-2xl overflow-hidden transition-colors shrink-0 mt-1 ${
          activePage === "profile"
            ? `bg-gradient-to-br ${PAGE_GRADIENTS.profile} text-white shadow-lg`
            : "text-[#768994] hover:text-[#122027] hover:bg-slate-100"
        }`}
      >
        <span
          className={`w-14 h-14 shrink-0 flex items-center justify-center text-sm font-black rounded-2xl ${
            activePage === "profile" ? "" : "bg-slate-100"
          }`}
        >
          {initials || "?"}
        </span>
        <span className={railLabelClass}>{PAGES.profile.label}</span>
      </button>
    </nav>
  );
}
