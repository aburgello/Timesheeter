// ── Access control ────────────────────────────────────────────────────────────
// Wrike user IDs allowed into Administration. Lives in its own tiny module —
// NOT in Management.jsx — because App and the Rail need it at startup, and an
// import from Management.jsx would pull the whole (lazy-loaded) Administration
// chunk into the main bundle just to read this list.
//
// Your Wrike ID is shown on the Profile Hub page (under your name, first 8
// chars). An empty list means everyone gets access.
export const MANAGEMENT_IDS = [
  "KUAWDLVN", "KUAQT4JC",
];
