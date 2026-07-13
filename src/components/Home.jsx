import React, { useRef, useMemo, useState, useEffect } from "react";
import { ChevronRight, Key } from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { supabase } from "../lib/supabaseClient";
import { pagesFor } from "../lib/departments";
import { useDepartment } from "../hooks/useDepartment";
import "@fontsource-variable/bricolage-grotesque";

gsap.registerPlugin(useGSAP);

// The menu rows come from the pages registry (src/lib/departments.js),
// filtered by the member's department — Motion sees its five tools, PMs see
// Administration/Job Book/Timesheets/Profile Hub, and departments without a
// defined set fall back to the historic five.

// Play the full entrance ceremony once per app session; returning to the
// menu afterwards gets a shortened rise so daily navigation never drags.
let entrancePlayed = false;

const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function useFirstName() {
  const [firstName, setFirstName] = useState("");
  useEffect(() => {
    const uid = localStorage.getItem("wrike_user_id");
    if (!uid) return;
    supabase
      .from("profiles")
      .select("first_name")
      .eq("wrike_user_id", uid)
      .single()
      .then(({ data }) => {
        if (data?.first_name) setFirstName(data.first_name);
      });
  }, []);
  return firstName;
}

export default function Home({ onNavigate, hasToken = true }) {
  const firstName = useFirstName();
  const department = useDepartment();
  const sections = useMemo(() => pagesFor(department), [department]);
  const containerRef = useRef(null);
  const headerRef = useRef(null);
  // Refs are keyed by section id (not index) because the row set can change
  // after mount — the department resolves asynchronously on a cold cache.
  // Lookups below always go through the current `sections`, so entries for
  // rows that no longer exist are simply never referenced.
  const rowRefs = useRef(new Map());
  const fillRefs = useRef(new Map());
  const contentRefs = useRef(new Map());
  const metaRefs = useRef(new Map());
  const bindRef = (mapRef, id) => (el) => {
    if (el) mapRef.current.set(id, el);
  };

  // Live nodes in row order for the entrance/exit choreography
  const liveNodes = (mapRef) =>
    sections.map((s) => mapRef.current.get(s.id)).filter(Boolean);

  useGSAP(
    () => {
      if (prefersReducedMotion()) return; // JSX renders in its final state

      const firstVisit = !entrancePlayed;
      entrancePlayed = true;

      const contents = liveNodes(contentRefs);
      gsap.set(headerRef.current, { opacity: 0, y: -12 });
      // Classic masked reveal: each row's icon+label sits inside an
      // overflow-hidden box (see Row below) and slides up from fully
      // below it — no opacity fade, just a clean wipe into place.
      gsap.set(contents, { yPercent: firstVisit ? 110 : 40 });

      gsap
        .timeline()
        .to(headerRef.current, {
          opacity: 1,
          y: 0,
          duration: firstVisit ? 0.5 : 0.25,
          ease: "power3.out",
        })
        .to(
          contents,
          {
            yPercent: 0,
            duration: firstVisit ? 0.8 : 0.4,
            ease: "expo.out",
            stagger: firstVisit ? 0.08 : 0.03,
          },
          "-=0.2"
        );
    },
    // Re-runs (as the shortened rise) if the row set changes when the
    // department resolves after first paint on a cold cache.
    { scope: containerRef, dependencies: [sections] }
  );

  const handleHoverIn = (id) => {
    gsap.to(fillRefs.current.get(id), { scaleX: 1, duration: 0.4, ease: "power3.out", overwrite: "auto" });
  };

  const handleHoverOut = (id) => {
    gsap.to(fillRefs.current.get(id), { scaleX: 0, duration: 0.3, ease: "power2.in", overwrite: "auto" });
  };

  const handlePick = (sectionId) => {
    if (prefersReducedMotion()) {
      onNavigate(sectionId);
      return;
    }

    const section = sections.find((s) => s.id === sectionId);
    const clickedRow = rowRefs.current.get(sectionId);
    const clickedFill = fillRefs.current.get(sectionId);
    const clickedContent = contentRefs.current.get(sectionId);
    const otherContents = sections
      .filter((s) => s.id !== sectionId)
      .map((s) => contentRefs.current.get(s.id))
      .filter(Boolean);
    if (!section || !clickedRow || !clickedFill || !clickedContent) {
      onNavigate(sectionId);
      return;
    }

    gsap.killTweensOf([
      ...liveNodes(rowRefs),
      ...liveNodes(fillRefs),
      ...liveNodes(contentRefs),
      ...liveNodes(metaRefs),
    ]);

    // Full-screen colour wash: the row's own fill (already a flat, full-width
    // rectangle from the hover sweep) grows to cover the viewport, then we
    // navigate. The clicked row is lifted above its siblings so the wash
    // paints over them (rows no longer clip — see Row), and the container's
    // own overflow-hidden stops the oversized fill spawning scrollbars.
    gsap.set(clickedRow, { zIndex: 60 });
    const rowRect = clickedRow.getBoundingClientRect();

    // Scale from an origin placed proportionally to the space above vs below
    // the row, so the wash's top and bottom edges reach the viewport edges at
    // the same moment. A centre origin only does that for the middle row —
    // edge rows hit their near edge early and visibly kept sweeping alone.
    const gapAbove = Math.max(rowRect.top, 0);
    const gapBelow = Math.max(window.innerHeight - rowRect.bottom, 0);
    const totalGap = gapAbove + gapBelow;
    const originY =
      totalGap > 0 ? (rowRect.height * gapAbove) / totalGap : rowRect.height / 2;
    // Both edges arrive exactly at scale = 1 + totalGap/height; the extra 4%
    // is a safety margin against subpixel rounding leaving hairline gaps.
    const scaleYNeeded = 1 + totalGap / rowRect.height + 0.04;
    gsap.set(clickedFill, { transformOrigin: `left ${originY}px` });

    // Mirrors the entrance mask reveal, run in reverse: other rows' labels
    // slide back down out of their masks, the clicked one slides up and out
    // as the fill washes over it — no opacity fades on the type itself.
    // The gradient is passed along so App can swap in an identical fixed
    // overlay the frame this component unmounts (see wash overlay in App).
    gsap
      .timeline({
        onComplete: () => onNavigate(sectionId, section.gradient),
      })
      .to(otherContents, { yPercent: 110, duration: 0.2, ease: "power2.in", stagger: 0.018 }, 0)
      .to(headerRef.current, { opacity: 0, duration: 0.16, ease: "power2.inOut" }, 0)
      .to(liveNodes(metaRefs), { opacity: 0, duration: 0.1, ease: "power2.out" }, 0)
      .to(clickedFill, { scaleX: 1, scaleY: scaleYNeeded, duration: 0.26, ease: "power2.inOut" }, 0)
      .to(clickedContent, { yPercent: -110, duration: 0.2, ease: "power2.in" }, 0.03);
  };

  return (
    // h-dvh + overflow-hidden: the menu owns exactly one viewport (no phantom
    // scroll) and the exit wash can't spawn scrollbars while it expands.
    <div
      ref={containerRef}
      className="h-dvh min-h-[540px] overflow-hidden bg-slate-100 flex flex-col"
    >
      <div
        ref={headerRef}
        className="px-6 sm:px-16 pt-10 pb-6 flex items-end justify-between gap-4"
      >
        <div>
          <p className="text-sm font-bold text-[#12a0e1] uppercase tracking-widest mb-1">
            {greeting()}{firstName ? `, ${firstName}` : ""}
          </p>
          <h1 className="text-2xl sm:text-3xl font-black text-[#122027] tracking-tight">
            Where to?
          </h1>
        </div>
        {!hasToken && (
          <button
            onClick={() => onNavigate("profile")}
            className="flex items-center gap-2 bg-amber-50 border border-amber-200 hover:border-amber-400 rounded-full px-4 py-2 shrink-0 transition-colors"
          >
            <Key className="w-3.5 h-3.5 text-amber-600 shrink-0" />
            <span className="text-xs font-bold text-amber-800 hidden sm:inline">
              Wrike not connected
            </span>
            <span className="text-xs font-black text-amber-600">Connect →</span>
          </button>
        )}
      </div>

      <div className="flex-1 flex flex-col">
        {sections.map((section) => (
          <Row
            key={section.id}
            section={section}
            addRowRef={bindRef(rowRefs, section.id)}
            addFillRef={bindRef(fillRefs, section.id)}
            addContentRef={bindRef(contentRefs, section.id)}
            addMetaRef={bindRef(metaRefs, section.id)}
            onClick={() => handlePick(section.id)}
            onHoverIn={() => handleHoverIn(section.id)}
            onHoverOut={() => handleHoverOut(section.id)}
          />
        ))}
      </div>
    </div>
  );
}

function Row({
  section,
  addRowRef,
  addFillRef,
  addContentRef,
  addMetaRef,
  onClick,
  onHoverIn,
  onHoverOut,
}) {
  const { label, desc, icon: Icon, gradient } = section;

  return (
    // No overflow-hidden here: the fill must escape the row for the exit
    // wash. The label keeps its own mask (inner div below), and keyboard
    // focus drives the same sweep as hover.
    <button
      ref={addRowRef}
      onClick={onClick}
      onMouseEnter={onHoverIn}
      onMouseLeave={onHoverOut}
      onFocus={onHoverIn}
      onBlur={onHoverOut}
      className="group relative flex-1 flex items-center justify-between gap-4 px-6 sm:px-16 border-b border-[#dce4ec] last:border-b-0 text-left focus:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-[#12a0e1]"
    >
      <div
        ref={addFillRef}
        className={`absolute inset-0 bg-gradient-to-r ${gradient}`}
        style={{ transform: "scaleX(0)", transformOrigin: "left center" }}
      />

      <div className="relative z-10 overflow-hidden">
        <div ref={addContentRef} className="flex items-center gap-5 sm:gap-8">
          <Icon
            className="w-8 h-8 sm:w-10 sm:h-10 text-[#122027] group-hover:text-white group-focus:text-white transition-colors duration-300 shrink-0"
            strokeWidth={1.75}
          />
          <p className="font-display text-4xl sm:text-6xl font-bold tracking-tight leading-none text-[#122027] group-hover:text-white group-focus:text-white transition-colors duration-300">
            {label}
          </p>
        </div>
      </div>

      <div ref={addMetaRef} className="relative z-10 flex items-center gap-4 shrink-0">
        <span className="hidden md:block text-sm font-bold text-white opacity-0 translate-x-3 group-hover:opacity-100 group-hover:translate-x-0 group-focus:opacity-100 group-focus:translate-x-0 transition-all duration-300 delay-75 pointer-events-none">
          {desc}
        </span>
        <ChevronRight className="w-5 h-5 sm:w-6 sm:h-6 text-[#768994] group-hover:text-white group-focus:text-white group-hover:translate-x-1 transition-all duration-300" />
      </div>
    </button>
  );
}
