// ── Access control ────────────────────────────────────────────────────────────
// Wrike user IDs allowed into Administration. Lives in its own tiny module —
// NOT in Management.jsx — because App and the Rail need it at startup, and an
// import from Management.jsx would pull the whole (lazy-loaded) Administration
// chunk into the main bundle just to read this list.
//
// Your Wrike ID is shown on the Profile Hub page (under your name, first 8
// chars). An empty list means everyone gets access.
//
// This list is mirrored in the `profiles_write` RLS policy and the
// `guard_can_debug_pull` trigger (see schema.sql), which are what actually
// permit editing other people's department/position, the Sync-from-Wrike
// upsert and granting Debug Pull. Adding someone here without adding them
// there gets them the Administration UI but silently-failing writes.
export const MANAGEMENT_IDS = [
  "KUAWDLVN", // Antonio Burgello
  "KUAQT4JC", // Guillaume Rater
  "KUAQGSEW", // Ben Gladwyn
];

// Administration is these people and nobody else — no department reaches it.
export const isManager = (wrikeUserId) =>
  MANAGEMENT_IDS.length === 0 || MANAGEMENT_IDS.includes(wrikeUserId);

// The pages a manager has whatever their department: Administration, and the
// Job Book, which is otherwise the Project Managers' alone. Listed in the
// order they lead the menu.
export const MANAGER_PAGE_IDS = ["management", "jobbook"];
