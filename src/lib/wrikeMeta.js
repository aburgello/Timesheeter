// The three workspace-wide lookup tables every enrichment reads: folders (for
// climbing to a task's film, studio and market), contacts (assignee names, and
// so Motion-team membership), and workflow statuses. Kept on the shared
// wrike_sync_meta row by useWrikeCache and refreshed once a day.
//
// Each of the three is all-or-nothing. A list that fails to download in full
// comes back as `previous`'s copy, never as whatever arrived before the
// failure, and `complete` says whether all three were fresh.
//
// This used to keep partial results. The folder loop stopped at the first bad
// page and returned the pages before it; the contact and workflow requests
// weren't checked at all, so a 429 produced an empty dictionary. Whatever came
// back was then written to the shared meta row, which every member's enrichment
// reads, so one rate-limited refresh could blank everyone's contact names
// (every assignee shows as "User", and the Motion-team filter, which matches on
// those names, stops recognising anyone) until someone forced another refresh.
//
// Folders come from fetchAllFolders, the one folder-tree download, which
// retries rate limits, throws rather than returning part of the tree, and
// drops recycle-bin folders. There used to be five separate copies of that
// loop, and three of them kept the recycle bin.
import { fetchAllFolders } from "./wrikeCampaign";
import { fetchRetrying } from "./fetchPool";

async function fetchList(path) {
  const res = await fetchRetrying(path);
  if (!res.ok) throw new Error(`${path} failed (${res.status})`);
  const data = (await res.json()).data;
  if (!Array.isArray(data) || data.length === 0) throw new Error(`${path} returned nothing`);
  return data;
}

export async function fetchWrikeMeta(previous = {}) {
  const [folders, contacts, workflows] = await Promise.allSettled([
    fetchAllFolders(),
    fetchList("/api/wrike/contacts"),
    fetchList("/api/wrike/workflows"),
  ]);

  let complete = true;
  const keep = (result, name, build) => {
    if (result.status === "fulfilled") return build(result.value);
    complete = false;
    console.warn(`[WrikeMeta] ${name} refresh failed, keeping the previous copy:`, result.reason?.message);
    return previous[name] || {};
  };

  const folderDictionary = keep(folders, "folderDictionary", (byId) => byId);
  const contactDictionary = keep(contacts, "contactDictionary", (list) => {
    const out = {};
    list.forEach((u) => { out[u.id] = `${u.firstName || ""} ${u.lastName || ""}`.trim(); });
    return out;
  });
  const statusDictionary = keep(workflows, "statusDictionary", (list) => {
    const out = {};
    list.forEach((wf) => wf.customStatuses?.forEach((st) => { out[st.id] = st.name; }));
    return out;
  });
  console.log(`[WrikeMeta] folder dictionary: ${Object.keys(folderDictionary).length} folders${complete ? "" : " (refresh incomplete)"}`);

  return { folderDictionary, contactDictionary, statusDictionary, complete };
}
