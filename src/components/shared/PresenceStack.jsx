import React, { useEffect, useState } from "react";

// Who else is in this note right now.
//
// Reads Yjs awareness — the same state that already drives the collaboration
// carets — so this costs no extra traffic: awareness is broadcast (and
// throttled) whether or not anything renders it. The carets already say
// *where* someone is, but only name them on hover; this says *who* is here
// without having to go hunting for a cursor.
//
// This is presence, not "who has the note open": the provider drops its
// channel once a tab has been hidden for a minute (an egress guard), so a
// note left open in a background tab correctly stops showing its owner here.
export default function PresenceStack({ awareness, max = 4 }) {
  const [peers, setPeers] = useState([]);

  useEffect(() => {
    if (!awareness) {
      setPeers([]);
      return;
    }

    const read = () => {
      const byName = new Map();
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID) return; // that's me
        const u = state?.user;
        if (!u?.name) return;
        // Two tabs from one person are two client ids but one human — keep the
        // lowest id so the stack doesn't show them twice, and doesn't reshuffle
        // when their other tab reconnects.
        const prev = byName.get(u.name);
        if (!prev || clientId < prev.clientId) {
          byName.set(u.name, { clientId, name: u.name, color: u.color });
        }
      });
      const out = [...byName.values()].sort((a, b) => a.clientId - b.clientId);
      setPeers(out);
    };

    read();
    awareness.on("change", read);
    return () => awareness.off("change", read);
  }, [awareness]);

  if (!peers.length) return null;

  const shown = peers.slice(0, max);
  const extra = peers.length - shown.length;

  return (
    <>
      <span className="w-1 h-1 rounded-full bg-[#d5cdbf]" />
      <span
        className="flex items-center gap-2 min-w-0"
        title={`${peers.map((p) => p.name).join(", ")} — here now`}
      >
        <span className="flex -space-x-1.5 shrink-0">
          {shown.map((p) => (
            <span
              key={p.clientId}
              title={p.name}
              className="w-5 h-5 rounded-full grid place-items-center text-[8px] font-black text-white ring-2 ring-white"
              style={{ backgroundColor: p.color || "#8a8073" }}
            >
              {p.name.charAt(0).toUpperCase()}
            </span>
          ))}
          {extra > 0 && (
            <span className="w-5 h-5 rounded-full grid place-items-center text-[8px] font-black text-[#8a8073] bg-[#ece4d8] ring-2 ring-white">
              +{extra}
            </span>
          )}
        </span>
        <span className="font-semibold text-[#8a8073] truncate">
          {peers.length === 1 ? `${peers[0].name} is here` : `${peers.length} others here`}
        </span>
      </span>
    </>
  );
}
