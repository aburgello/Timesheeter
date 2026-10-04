const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const { isManager, rememberAdmin } = await import("../src/lib/access.js");

check("access: before the profile is read, the fallback list decides", [isManager("KUAWDLVN"), isManager("X1")], [true, false]);
rememberAdmin("X1", { department: "Motion" });
check("access: a profile without is_admin changes nothing", isManager("X1"), false);
rememberAdmin("X1", { is_admin: true, left_at: null });
check("access: is_admin grants it", isManager("X1"), true);
check("access: the cache is for that person only", isManager("KUAWDLVN"), true);
rememberAdmin("KUAWDLVN", { is_admin: false });
check("access: unticking removes it", isManager("KUAWDLVN"), false);
rememberAdmin("X1", { is_admin: true, left_at: "2026-10-01T00:00:00Z" });
check("access: a leaver loses it", isManager("X1"), false);
