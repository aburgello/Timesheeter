import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Zap, StickyNote, Briefcase, Settings,
         FolderPlus, FileBarChart, ClipboardList, Shield } from "lucide-react";
import { PAGE_GRADIENTS } from "../../lib/pageGradients";
import { pageIdsFor } from "../../lib/departments";

// ── Quick actions bubble ─────────────────────────────────────────────────────
// A floating hover-to-open shortcut stack, bottom-right. Two kinds of entry:
//
//  • nav      — jumps to a page (and, for Profile sections like Active Jobs /
//               Settings, lands you *inside* it, skipping the hub screen the
//               Rail would otherwise dump you on).
//  • in-place — runs something over the current page without navigating away:
//               Notes opens the Notes Canvas in a modal, Admin the Admin
//               panel. These are the point of the bubble beyond what the Rail
//               already does — a place to *do* a quick thing, not just go
//               somewhere.
//
// Hidden on Home for the same reason the Rail is: Home is its own full-screen
// menu, and a shortcut bubble floating over it would just be a second, worse
// copy of the thing already filling the viewport.

const ACTIONS = [
  {
    id: "settings",
    label: "Settings",
    icon: Settings,
    kind: "nav",
    page: "profile",
    section: "settings",
    gradient: "from-slate-500 to-slate-700",
    requires: "profile",
  },
  // ── Desk-specific entries ──────────────────────────────────────────────
  // Reached by hash rather than onNavigate: Administration and Job Book both
  // route their inner position through the URL (`#management/<section>`,
  // `#jobbook/<tab>`), so setting the hash lands *inside* the page. Profile's
  // sections aren't hash-routed, hence the two mechanisms.
  {
    id: "jobsSetup",
    label: "Jobs Setup",
    icon: FolderPlus,
    kind: "hash",
    hash: "jobbook/jobsSetup",
    gradient: PAGE_GRADIENTS.jobbook,
    requires: "jobbook",
  },
  {
    id: "jobbook",
    label: "Job Book",
    icon: Briefcase,
    kind: "hash",
    hash: "jobbook/jobs",
    gradient: PAGE_GRADIENTS.jobbook,
    requires: "jobbook",
  },
  {
    id: "projectTime",
    label: "Project/Time",
    icon: FileBarChart,
    kind: "hash",
    hash: "management/project-time",
    gradient: PAGE_GRADIENTS.management,
    requires: "management",
  },
  {
    id: "timesheetCompletion",
    label: "Timesheet Completion",
    icon: ClipboardList,
    kind: "hash",
    hash: "management/timesheet-completion",
    gradient: PAGE_GRADIENTS.management,
    requires: "management",
  },
  {
    id: "orderforms",
    label: "Client Orders",
    icon: ClipboardList,
    kind: "hash",
    hash: "orderforms",
    gradient: PAGE_GRADIENTS.orderforms,
    requires: "orderforms",
    // Only for a desk that names it below, not everyone who can open the page.
    deskOnly: true,
  },
  {
    id: "jobs",
    label: "Active Jobs",
    icon: Briefcase,
    kind: "nav",
    page: "profile",
    section: "jobs",
    // Matches the Active Jobs hub row's own identity gradient in Profile.
    gradient: "from-[#12a0e1] to-[#1cc1a5]",
    requires: "profile",
  },
  {
    id: "notes",
    label: "Notes",
    icon: StickyNote,
    kind: "notes",
    gradient: PAGE_GRADIENTS.canvas,
    // Opens the Notes Canvas as a modal (in place) rather than navigating to
    // the Canvas page — but still gated on canvas access so it's never offered
    // to a member who couldn't reach notes at all.
    requires: "canvas",
  },
];

// The Admin panel (AdminModal). Offered whenever App passes onOpenAdmin, which
// it does only for the app's admin, whatever their desk or department preview.
const ADMIN_ACTION = {
  id: "admin",
  label: "Admin",
  icon: Shield,
  kind: "admin",
  gradient: "from-[#122027] to-[#25373c]",
};

// Desks whose shortcuts are named explicitly rather than derived from page
// access: PM sets jobs up and runs the book, Operations reads the time that
// came out the other end. The access filter still applies on top, so the
// Administration reports are only offered to an Operations member who is also
// a manager (lib/access.js) — everyone else on that desk keeps Settings.
const DEPARTMENT_ACTIONS = {
  PM: ["jobsSetup", "jobbook", "orderforms", "jobs", "settings"],
  // timesheetCompletion comes back here once that report exists.
  Operations: ["projectTime", "settings"],
};

// How far to raise the bubble so it sits above anything marked
// data-bubble-avoid that it would otherwise cover (Copy Me! on the timesheet,
// and the steps card that opens above it). Re-measured on scroll, resize and
// DOM changes, since the page under a fixed bubble moves without telling it.
const AVOID_GAP = 8;
function useLiftOverMarked(bubbleRef, enabled) {
  const [lift, setLift] = useState(0);
  const liftRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const el = bubbleRef.current;
      if (!el?.offsetParent) return;
      const bubble = el.getBoundingClientRect();
      // Where the bubble rests with no lift applied. From layout offsets, not
      // the rect, which is mid-transition while the lift animates.
      const restTop = el.offsetParent.offsetTop + el.offsetTop;
      const rest = { top: restTop, bottom: restTop + el.offsetHeight };
      const marked = [...document.querySelectorAll("[data-bubble-avoid]")]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width && r.right > bubble.left && r.left < bubble.right)
        // Lowest first, so clearing one can run into the next one up.
        .sort((a, b) => b.bottom - a.bottom);
      let next = 0;
      for (const r of marked) {
        const top = rest.top - next - AVOID_GAP;
        const bottom = rest.bottom - next + AVOID_GAP;
        if (r.bottom > top && r.top < bottom) next = rest.bottom - r.top + AVOID_GAP;
      }
      next = Math.max(0, Math.round(next));
      if (next !== liftRef.current) {
        liftRef.current = next;
        setLift(next);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    schedule();
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { childList: true, subtree: true });
    const sizes = new ResizeObserver(schedule);
    sizes.observe(document.body);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      mutations.disconnect();
      sizes.disconnect();
    };
  }, [bubbleRef, enabled]);

  return enabled ? lift : 0;
}

export default function QuickActions({ activePage, department, wrikeUserId, onNavigate, onOpenNotes, onOpenAdmin }) {
  // Two independent reasons to be open, OR'd together, rather than one flag
  // both handlers write to: with a single flag, mouseenter opens the stack
  // and the bubble's own click then toggles it straight back shut, so a
  // mouse click closes what the hover just opened. Hover is transient,
  // pinning is deliberate — kept apart, they can't clobber each other.
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hovered || pinned;
  const bubbleRef = useRef(null);
  const lift = useLiftOverMarked(bubbleRef, activePage !== "home");

  const close = () => {
    setHovered(false);
    setPinned(false);
  };

  if (activePage === "home") return null;

  // Same department registry Home and the Rail read, so the bubble
  // can never offer a page this member has no access to.
  const allowed = pageIdsFor(department, wrikeUserId);
  // A desk with a named shortcut set gets exactly that, in that order — the
  // bubble is meant to be the two or three things you actually reach for, and
  // for PM/Operations those aren't the production tools the default list
  // offers. Anything else keeps the access-filtered default.
  const preferred = DEPARTMENT_ACTIONS[department];
  const deskActions = preferred
    ? preferred.map((id) => ACTIONS.find((a) => a.id === id))
                .filter((a) => a && (!a.requires || allowed.includes(a.requires)))
    : ACTIONS.filter((a) => !a.deskOnly && (!a.requires || allowed.includes(a.requires)));
  const actions = onOpenAdmin ? [ADMIN_ACTION, ...deskActions] : deskActions;
  if (!actions.length) return null;

  const runAction = (action) => {
    if (action.kind === "notes") {
      close();
      onOpenNotes?.();
      return;
    }
    if (action.kind === "admin") {
      close();
      onOpenAdmin?.();
      return;
    }
    if (action.kind === "hash") {
      // Administration and Job Book read their inner position from the hash,
      // and App mirrors the first segment back into the active page.
      close();
      window.location.hash = action.hash;
      return;
    }
    close();
    onNavigate(action.page, action.section);
  };

  return (
    // Hover opens, but focus does too and the bubble itself is a real button
    // that pins it open — hover alone would strand keyboard and touch users,
    // who get no hover event at all.
    <div
      // Below md the nav is a bottom bar, so the bubble sits above it
      // rather than on top of the profile button at the bar's right end.
      className="fixed bottom-24 md:bottom-6 right-4 md:right-6 z-[100] flex flex-col items-end transition-transform duration-150 ease-out"
      style={lift ? { transform: `translateY(-${lift}px)` } : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) close();
      }}
    >
      <AnimatePresence>
        {open && (
          <motion.div
            className="flex flex-col items-end gap-2 mb-3"
            initial="closed"
            animate="opened"
            exit="closed"
            variants={{
              opened: { transition: { staggerChildren: 0.04, staggerDirection: -1 } },
              closed: { transition: { staggerChildren: 0.03 } },
            }}
          >
            {actions.map((action) => {
              const Icon = action.icon;
              return (
                <motion.button
                  key={action.id}
                  onClick={() => runAction(action)}
                  variants={{
                    opened: { opacity: 1, y: 0, scale: 1 },
                    closed: { opacity: 0, y: 8, scale: 0.9 },
                  }}
                  transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                  className="group flex items-center gap-2.5"
                >
                  <span className="text-[11px] font-black uppercase tracking-widest text-[#122027] bg-white border border-[#dce4ec] rounded-xl px-2.5 py-1.5 shadow-md whitespace-nowrap">
                    {action.label}
                  </span>
                  <span
                    className={`w-10 h-10 rounded-full bg-gradient-to-br ${action.gradient} text-white flex items-center justify-center shadow-lg transition-transform group-hover:scale-110`}
                  >
                    <Icon className="w-4 h-4" strokeWidth={2.25} />
                  </span>
                </motion.button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>

      <button
        ref={bubbleRef}
        onClick={() => setPinned((v) => !v)}
        aria-expanded={open}
        aria-label="Quick actions"
        className="w-11 h-11 rounded-full bg-gradient-to-br from-[#12a0e1] to-[#1cc1a5] text-white flex items-center justify-center shadow-2xl border border-white/20 hover:scale-105 transition-transform"
      >
        <motion.span
          animate={{ rotate: open ? 90 : 0 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="flex"
        >
          <Zap className="w-5 h-5" strokeWidth={2.25} />
        </motion.span>
      </button>
    </div>
  );
}
