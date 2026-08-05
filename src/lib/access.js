// ── Access control ────────────────────────────────────────────────────────────
// Wrike user IDs allowed into Administration. Lives in its own tiny module —
// NOT in Management.jsx — because App and the Rail need it at startup, and an
// import from Management.jsx would pull the whole (lazy-loaded) Administration
// chunk into the main bundle just to read this list.
//
// Your Wrike ID is shown on the Profile Hub page (under your name, first 8
// chars). An empty list means everyone gets access.
//
// This list is mirrored in the `profiles_write` RLS policy (see schema.sql),
// which is what actually permits editing other people's department/position
// and the Sync-from-Wrike upsert. Adding someone here without adding them
// there gets them the Administration UI but silently-failing writes.
export const MANAGEMENT_IDS = [
  "KUAWDLVN", "KUAQT4JC",
];
