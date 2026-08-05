import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { supabase } from "./supabaseClient";

// ── Yjs over Supabase Realtime ───────────────────────────────────────────────
// A minimal Yjs provider on Supabase Realtime broadcast. There's no official
// one, and the community y-supabase is alpha, unmaintained since early 2023,
// and says outright it isn't for production — so this is deliberately small
// enough to read in one sitting rather than a dependency to inherit.
//
// Protocol, such as it is:
//   • "sync"   — a peer joined and is asking for state, carrying its own state
//                vector so we can reply with just the diff it's missing.
//   • "update" — an incremental document update.
//   • "aware"  — awareness (cursors/selection/presence).
//
// EGRESS is the design constraint here, not latency. Every broadcast fans out
// to each other connected client, and this account has no headroom (see the
// notes in ExcalidrawPageEditor about how a chatty writer took the database
// down). Document updates are cheap — a keystroke is tens of bytes and only
// happens when someone actually types. Awareness is the expensive one: it can
// fire on every mouse move, forever, for as long as a tab is left open, and
// that is the thing that turns "a bit of collaboration" into gigabytes. Hence
// AWARENESS_THROTTLE_MS and the disconnect-on-hidden behaviour below; both are
// load-bearing, not polish.

const AWARENESS_THROTTLE_MS = 200; // ≤5 cursor updates/sec, not the ~20 y-protocols will happily emit
const IDLE_DISCONNECT_MS = 60_000; // a backgrounded tab shouldn't hold a live channel

const b64 = {
  encode: (bytes) => {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  },
  decode: (str) => {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

export function createSupabaseYProvider({ doc, room, user, onSynced }) {
  const awareness = new Awareness(doc);
  const clientId = doc.clientID;
  let channel = null;
  let destroyed = false;
  let awarenessTimer = null;
  let pendingAwareness = false;
  let idleTimer = null;

  if (user) {
    awareness.setLocalStateField("user", { name: user.name, color: user.color });
  }

  const send = (event, payload) => {
    if (!channel || destroyed) return;
    channel.send({ type: "broadcast", event, payload });
  };

  const onDocUpdate = (update, origin) => {
    // Skip updates we applied from a peer, or we'd echo them straight back.
    if (origin === "remote") return;
    send("update", { from: clientId, update: b64.encode(update) });
  };

  // Coalesce awareness into at most one broadcast per throttle window. Without
  // this, moving the mouse across the editor emits a steady stream of updates
  // to every peer — the dominant cost of collaborative editing by a wide
  // margin, and pure waste since nobody can perceive a cursor moving at 20Hz.
  const sendAwareness = () => {
    if (destroyed) return;
    send("aware", { from: clientId, update: b64.encode(encodeAwarenessUpdate(awareness, [clientId])) });
  };

  const flushAwareness = () => {
    awarenessTimer = null;
    if (!pendingAwareness || destroyed) return;
    pendingAwareness = false;
    sendAwareness();
  };

  const onAwarenessUpdate = ({ added, updated, removed }) => {
    if (![...added, ...updated, ...removed].includes(clientId)) return;
    pendingAwareness = true;
    if (!awarenessTimer) awarenessTimer = setTimeout(flushAwareness, AWARENESS_THROTTLE_MS);
  };

  const connect = () => {
    if (channel || destroyed) return;
    channel = supabase.channel(`ynote:${room}`, { config: { broadcast: { self: false } } });

    channel
      .on("broadcast", { event: "update" }, ({ payload }) => {
        if (payload.from === clientId) return;
        Y.applyUpdate(doc, b64.decode(payload.update), "remote");
      })
      .on("broadcast", { event: "aware" }, ({ payload }) => {
        if (payload.from === clientId) return;
        applyAwarenessUpdate(awareness, b64.decode(payload.update), "remote");
      })
      .on("broadcast", { event: "sync" }, ({ payload }) => {
        if (payload.from === clientId) return;
        // A peer joined and told us what it already has. Reply with only the
        // delta it's missing rather than the whole document.
        const diff = Y.encodeStateAsUpdate(doc, b64.decode(payload.sv));
        send("update", { from: clientId, update: b64.encode(diff) });
        // ...and say who we are. Awareness isn't part of a document state
        // vector, so the reply above carries none of it: without this a
        // joiner can't see anyone already in the note until their cursor
        // happens to move.
        sendAwareness();
      })
      .subscribe((status) => {
        if (status !== "SUBSCRIBED" || destroyed) return;
        // Announce ourselves with our state vector so any peer can send us
        // what we're missing. If nobody answers we simply keep what we loaded
        // from the database, which is the correct outcome for a solo editor.
        send("sync", { from: clientId, sv: b64.encode(Y.encodeStateVector(doc)) });
        // Announce who we are as well. The local user state is set at
        // construction, before the awareness listener below exists, so it
        // never produced a broadcast — and broadcasts aren't retained, so
        // peers already in the note would otherwise never learn we joined.
        // Two small messages per join, not per keystroke: the throttling that
        // matters (cursor spam) is untouched.
        sendAwareness();
        onSynced?.();
      });
  };

  const disconnect = () => {
    if (!channel) return;
    removeAwarenessStates(awareness, [clientId], "local");
    // Say goodbye before the channel goes. removeAwarenessStates bumps our
    // clock and leaves the state null, so this encodes as "I'm gone" and peers
    // drop us immediately. Without it they keep showing us until awareness
    // times us out on its own ~30s later — a stale face in the presence list
    // long after the tab closed.
    sendAwareness();
    supabase.removeChannel(channel);
    channel = null;
  };

  // A hidden tab has nobody looking at it, so holding the channel open only
  // spends egress relaying updates into the void. Reconnecting re-syncs via
  // the state vector above, so nothing is lost by dropping out.
  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(disconnect, IDLE_DISCONNECT_MS);
    } else {
      clearTimeout(idleTimer);
      connect();
    }
  };

  doc.on("update", onDocUpdate);
  awareness.on("update", onAwarenessUpdate);
  document.addEventListener("visibilitychange", onVisibility);
  connect();

  return {
    awareness,
    destroy() {
      clearTimeout(awarenessTimer);
      clearTimeout(idleTimer);
      doc.off("update", onDocUpdate);
      awareness.off("update", onAwarenessUpdate);
      document.removeEventListener("visibilitychange", onVisibility);
      // Before `destroyed`, deliberately: disconnect() broadcasts our goodbye,
      // and send() is a no-op once destroyed is set. Flipping the flag first
      // silently swallowed that last message.
      disconnect();
      destroyed = true;
      awareness.destroy();
    },
  };
}
