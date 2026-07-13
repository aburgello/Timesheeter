// Local IndexedDB mirror of the shared Supabase wrike_tasks_cache table.
//
// The task cache is 18k+ rows (tens of MB with MATRIX tableHtml) and used to
// be re-downloaded in full from Supabase on every page load — the main source
// of egress overage. Each browser now keeps a complete copy here and only
// pulls rows whose updated_date moved past the local cursor.
//
// All helpers fail soft: if IndexedDB is unavailable (private mode, quota),
// callers fall back to the old full-download behaviour.

const DB_NAME = "xyi-wrike-cache";
const DB_VERSION = 1;
const TASKS = "tasks";
const META = "meta";
const CURSOR_KEY = "cursor";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TASKS)) db.createObjectStore(TASKS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadLocalTasks() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(TASKS, "readonly").objectStore(TASKS).getAll();
      req.onsuccess = () => { db.close(); resolve(req.result || []); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  } catch {
    return [];
  }
}

export async function saveLocalTasks(tasks) {
  const valid = (tasks || []).filter((t) => t?.id);
  if (!valid.length) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(TASKS, "readwrite");
      const store = tx.objectStore(TASKS);
      valid.forEach((t) => store.put(t));
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch {
    /* cache write failures are non-fatal */
  }
}

// Remove purged tasks from the mirror — without this, tasks deleted from the
// shared cache (reassigned off the Motion team, webhook purges) resurrect
// from IndexedDB on every reload.
export async function removeLocalTasks(ids) {
  if (!ids?.length) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(TASKS, "readwrite");
      const store = tx.objectStore(TASKS);
      ids.forEach((id) => store.delete(id));
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch {
    /* non-fatal */
  }
}

export async function getLocalCursor() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(META, "readonly").objectStore(META).get(CURSOR_KEY);
      req.onsuccess = () => { db.close(); resolve(req.result || null); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  } catch {
    return null;
  }
}

// Move the delta cursor forward to the newest updatedDate in `tasks`.
// Never moves backwards, so partial merges can call it freely.
export async function advanceLocalCursor(tasks) {
  const maxUpdated = (tasks || []).reduce(
    (m, t) => (t?.updatedDate && t.updatedDate > m ? t.updatedDate : m),
    ""
  );
  if (!maxUpdated) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(META, "readwrite");
      const store = tx.objectStore(META);
      const req = store.get(CURSOR_KEY);
      req.onsuccess = () => {
        if (!req.result || maxUpdated > req.result) store.put(maxUpdated, CURSOR_KEY);
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch {
    /* non-fatal */
  }
}
