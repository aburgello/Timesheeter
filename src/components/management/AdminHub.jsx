// The Administration landing page listing every section.
//
// Part of Administration. Split out of components/Management.jsx, which is
// still the entry point and re-exports what other screens import.
import HubRow from "../shared/HubRow";
import { NAV_GROUPS } from "./nav";

// ── Administration hub (level 0) ────────────────────────────────────────────
export function AdminHub({ expandedGroup, onToggleGroup, onOpenItem }) {
  return (
    <div className="space-y-6">

      {/* The three destinations — clicking one unfolds its items right there
          in place (an accordion), rather than navigating to a separate
          screen. Each is its own separate card now (was one shared
          bordered list with rows butted against each other) — same
          treatment PeopleSection's department cards already use, so a
          manager sees three distinct destinations, not one dense block
          that happens to have three rows. */}
      {/* Card gap tightens while a group is open, for the same reason its
          siblings condense: every pixel above the open group pushes its
          children further down the page. */}
      <div className={`flex flex-col ${expandedGroup ? "gap-2.5" : "gap-4"}`}>
        {NAV_GROUPS.map((group) => {
          const isOpen = expandedGroup === group.id;
          // A group with exactly one destination has nothing to unfold —
          // an accordion revealing a single row you then click again is
          // pure friction. Go straight there, and read as navigation (no
          // `open` prop) rather than as an expand/collapse toggle.
          const singleItem = group.items.length === 1;
          // Once any group is open, every other top-level row shrinks and
          // drops its description. Supporting Content alone has seven
          // children, and at full height the siblings above/below it pushed
          // those off the bottom of the viewport. This was written when
          // tailwind.css also applied html{zoom:1.1}, which made the effective
          // viewport ~10% shorter again; that zoom is gone, so there is now
          // more room than when the condensing was tuned.
          const isCondensed = !!expandedGroup && !isOpen;
          return (
            <div key={group.id} className="bg-white rounded-3xl border border-[#dce4ec] shadow-sm overflow-hidden">
              <HubRow
                section={group}
                onClick={() => (singleItem ? onOpenItem(group.items[0].id) : onToggleGroup(group.id))}
                open={singleItem ? undefined : isOpen}
                condensed={isCondensed}
                first
              />
              <div className={`grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}>
                <div className="overflow-hidden min-h-0">
                  <div className="bg-slate-50 border-t border-[#dce4ec]">
                    {/* Same HubRow, just compact — identical gradient sweep
                        and hover behavior as the parent row, not a
                        hand-rolled approximation of it. */}
                    {group.items.map((item) => (
                      <HubRow
                        key={item.id}
                        compact
                        section={{ ...item, gradient: group.gradient }}
                        onClick={() => onOpenItem(item.id)}
                        badge={
                          item.soon ? (
                            <span className="text-[9px] font-black uppercase tracking-widest text-[#768994] group-hover:text-white/80 bg-slate-100 group-hover:bg-white/15 px-2 py-1 rounded-full transition-colors duration-300">
                              Coming soon
                            </span>
                          ) : null
                        }
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

    </div>
  );
}
