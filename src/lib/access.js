// ── Access control ────────────────────────────────────────────────────────────
// Its own tiny module, not part of Management.jsx, because App and the Rail
// need it at startup and Administration is lazy-loaded.
//
// Who may open Administration is profiles.is_admin, ticked in Administration ›
// People. The database enforces it (the profiles_write policy and the
// guard_profile_grants trigger); this only decides what the app offers.
//
// The flag is cached per person so the menu is right on the first frame.
// MANAGEMENT_IDS is the answer only until the signed-in person's profile has
// been read with the is_admin column in it.
const ADMIN_CACHE_KEY = "xyi_is_admin";

export const MANAGEMENT_IDS = [
  "KUAWDLVN", // Antonio Burgello
  "KUAQT4JC", // Guillaume Rater
  "KUAQGSEW", // Ben Gladwyn
];

function cachedAdmin(wrikeUserId) {
  try {
    const saved = JSON.parse(localStorage.getItem(ADMIN_CACHE_KEY) || "null");
    return saved?.uid === wrikeUserId ? saved.admin : undefined;
  } catch {
    return undefined;
  }
}

// Called with the signed-in person's profile row (read with select *).
export function rememberAdmin(wrikeUserId, profile) {
  if (!wrikeUserId || !profile || !("is_admin" in profile)) return;
  const admin = !!profile.is_admin && !profile.left_at;
  localStorage.setItem(ADMIN_CACHE_KEY, JSON.stringify({ uid: wrikeUserId, admin }));
}

export const isManager = (wrikeUserId) => {
  const cached = cachedAdmin(wrikeUserId);
  return cached !== undefined ? cached : MANAGEMENT_IDS.includes(wrikeUserId);
};

// The pages a manager has whatever their department: Administration, and the
// Job Book and Order Forms, which are otherwise the Project Managers' alone.
// Listed in the order they lead the menu.
export const MANAGER_PAGE_IDS = ["management", "jobbook", "orderforms"];
