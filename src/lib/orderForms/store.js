// Loaded order forms, kept in this browser's IndexedDB and nowhere else.
//
// Order data must not go to Supabase: its tables are readable with the public
// anon key. Sharing files between PMs means replacing this module with one
// backed by locked-down tables, not adding a sync here.
//
// Every helper fails soft. Without IndexedDB (private mode, quota) the page
// still works for the session and says the file won't be remembered.

const DB_NAME = "xyi-order-forms";
const DB_VERSION = 1;
const FILES = "files";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(FILES)) req.result.createObjectStore(FILES, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, work) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(FILES, mode);
      const req = work(tx.objectStore(FILES));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function listFiles() {
  try {
    const files = await run("readonly", (store) => store.getAll());
    return (files || []).sort((a, b) => b.loadedAt.localeCompare(a.loadedAt));
  } catch {
    return [];
  }
}

// false when the file couldn't be kept.
export async function saveFile(file) {
  try {
    await run("readwrite", (store) => store.put(file));
    return true;
  } catch {
    return false;
  }
}

export async function removeFile(id) {
  try {
    await run("readwrite", (store) => store.delete(id));
  } catch {
    // Nothing to undo: the page has already dropped it from view.
  }
}
