import React, { useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Zap, StickyNote, Activity, Briefcase, Settings, FileScan } from "lucide-react";
import { PAGE_GRADIENTS } from "../../lib/pageGradients";
import { pageIdsFor } from "../../lib/departments";

// ── Quick actions bubble ─────────────────────────────────────────────────────
// A floating hover-to-open shortcut stack, bottom-right. Two kinds of entry:
//
//  • nav      — jumps to a page (and, for Profile sections like Active Jobs /
//               Settings, lands you *inside* it, skipping the hub screen the
//               Rail would otherwise dump you on).
//  • in-place — runs something over the current page without navigating away:
//               Notes opens the Notes Canvas in a modal, Scan PDF reads a
//               delivery-spec PDF straight from the corner. These are the
//               point of the bubble beyond what the Rail already does — a
//               place to *do* a quick thing, not just go somewhere.
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
    id: "tracker",
    label: "Tracker",
    icon: Activity,
    kind: "nav",
    page: "timesheet",
    gradient: PAGE_GRADIENTS.timesheet,
    requires: "timesheet",
  },
  {
    id: "scan",
    label: "Scan PDF",
    icon: FileScan,
    kind: "scan",
    gradient: "from-emerald-500 to-teal-600",
    // No `requires`: reading a delivery-spec PDF is a generic tool, useful from
    // any page and not tied to a department's page access.
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

export default function QuickActions({ activePage, department, onNavigate, onOpenNotes, onScanPdf }) {
  // Two independent reasons to be open, OR'd together, rather than one flag
  // both handlers write to: with a single flag, mouseenter opens the stack
  // and the bubble's own click then toggles it straight back shut, so a
  // mouse click closes what the hover just opened. Hover is transient,
  // pinning is deliberate — kept apart, they can't clobber each other.
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hovered || pinned;
  const fileInputRef = useRef(null);

  const close = () => {
    setHovered(false);
    setPinned(false);
  };

  if (activePage === "home") return null;

  // Same department registry the Rail and command palette read, so the bubble
  // can never offer a page this member has no access to. Entries with no
  // `requires` (Scan PDF) are always allowed.
  const allowed = pageIdsFor(department);
  const actions = ACTIONS.filter((a) => !a.requires || allowed.includes(a.requires));
  if (!actions.length) return null;

  const runAction = (action) => {
    if (action.kind === "notes") {
      close();
      onOpenNotes?.();
      return;
    }
    if (action.kind === "scan") {
      // Fire the picker from within this click so the browser accepts the
      // gesture; closing the stack afterwards doesn't cancel the open dialog.
      fileInputRef.current?.click();
      close();
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
      className="fixed bottom-6 right-6 z-[100] flex flex-col items-end"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) close();
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          // Reset so picking the same file twice still re-fires onChange.
          e.target.value = "";
          if (f) onScanPdf?.(f);
        }}
      />

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
                  title={action.label}
                  variants={{
                    opened: { opacity: 1, y: 0, scale: 1 },
                    closed: { opacity: 0, y: 8, scale: 0.9 },
                  }}
                  transition={{ duration: 0.16, ease: [0.25, 0.1, 0.25, 1] }}
                  className="group flex items-center gap-2.5"
                >
                  <span className="text-[11px] font-black uppercase tracking-widest text-[#122027] bg-white border border-[#dce4ec] rounded-xl px-2.5 py-1.5 shadow-md whitespace-nowrap">
                    {action.label}
                  </span>
                  <span
                    className={`w-11 h-11 rounded-full bg-gradient-to-br ${action.gradient} text-white flex items-center justify-center shadow-lg transition-transform group-hover:scale-110`}
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
        onClick={() => setPinned((v) => !v)}
        aria-expanded={open}
        aria-label="Quick actions"
        title="Quick actions"
        className="w-14 h-14 rounded-full bg-gradient-to-br from-[#12a0e1] to-[#1cc1a5] text-white flex items-center justify-center shadow-2xl border border-white/20 hover:scale-105 transition-transform"
      >
        <motion.span
          animate={{ rotate: open ? 90 : 0 }}
          transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
          className="flex"
        >
          <Zap className="w-6 h-6" strokeWidth={2.25} />
        </motion.span>
      </button>
    </div>
  );
}
