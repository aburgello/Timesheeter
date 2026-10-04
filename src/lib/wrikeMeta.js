// The three workspace-wide lookup tables enrichment reads: folders (to climb to a
// task's film, studio and market), contacts (assignee names, which decide
// Motion-team membership) and workflow statuses. Stored on the shared
// wrike_sync_meta row by useWrikeCache and refreshed daily.
//
// Each list is all-or-nothing: one that doesn't download in full keeps the
// `previous` copy, and `complete` says whether all three are fresh. A partial or
// empty list written to the shared row would break enrichment for everyone.
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
