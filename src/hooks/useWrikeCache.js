import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "../lib/supabaseClient";
import {
  loadLocalTasks,
  saveLocalTasks,
  removeLocalTasks,
  getLocalCursor,
  advanceLocalCursor,
  getServerCursor,
  setServerCursor,
  clearLocalTasks,
} from "../lib/localTaskCache";
import {
  TRACKING_START,
  RECONCILE_EVERY_MS,
  hasChangeTracking,
  pullAll,
  pullSharedChanges,
  reconcileWithServer,
  claimWebhookEvents,
} from "../lib/sharedTaskSync";
import {
  enrichTasks,
  filterToTeams,
  hydrateMissingFolders,
  parseWrikeData,
  getStudioName,
  getFilmName,
  buildChildToParents,
  buildFilmCodeMappings,
  keepsDescription,
  PRINT_HUB_RE,
} from "../lib/wrikeEnrich";
import { subscribeToWrikeTaskEvents } from "../lib/wrikeWebhookSubscription";
import { fetchAllFolders } from "../lib/wrikeCampaign";
import { fetchWrikeMeta } from "../lib/wrikeMeta";
import { usesTeamBoard } from "../lib/departments";

const FIELDS_FILTER = encodeURIComponent(
  "[customFields,parentIds,responsibleIds,subTaskIds,description]"
);
const SYNC_INTERVAL_MS  = 15 * 60 * 1000;   // re-sync if data is >15 min old
const META_MAX_AGE_MS   = 24 * 60 * 60 * 1000; // refresh folder/contact dicts daily
const LOOKBACK_MONTHS   = 2;                 // how far back the full refresh window goes
// Delta pulls re-read a day behind the cursor so rows a teammate upserted
// late (their Wrike updatedDate predates our cursor) still get picked up.
const CURSOR_OVERLAP_MS = 24 * 60 * 60 * 1000;
// Folder campaigns are tiny and only derivable when a folder dictionary is
// in memory (now rare) — persist them locally between sessions.
const FOLDER_CAMPAIGNS_KEY = "xyi_folder_campaigns_v1";
// wrike_sync_meta is one shared row for the whole team: the dictionaries are
// workspace-wide, and sharing last_synced_at means if anyone synced in the
// last 15 minutes, nobody else hits Wrike at all.
const SHARED_META_ID = "shared";
// Bump to force a one-time full re-pull of the local mirror. v2: pagination
// gained .order("id") — unordered .range() pages overlapped/skipped rows, so
// v1 mirrors are silently missing thousands of tasks.
const CACHE_FORMAT = "2";
const CACHE_FORMAT_KEY = "xyi_cache_format";
// Load-time repairs whose answer rarely changes: how long a confirmed-real gap
// is left alone, and how often the (mostly fruitless) studio backfill runs.
const REPAIR_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
const STUDIO_PROBE_AT_KEY = "xyi_studio_probe_at";
const STUDIO_PROBE_EVERY_MS = 24 * 60 * 60 * 1000;

// Guards the mount hydration against React StrictMode's dev double-invoke —
// without it every dev reload downloaded the Supabase cache twice.
let bootStarted = false;

// A task's permalink is always https://www.wrike.com/open.htm?id=<id>, so it's
// stripped from the stored copy (~1.4 MB across the cache). Memory and the local
// mirror keep it.
const stripForStorage = ({ permalink, ...rest }) => rest;

// ---------------------------------------------------------------------------
// Paginate through Wrike tasks updated after `sinceIso`
// ---------------------------------------------------------------------------
async function fetchWrikeTasks(sinceIso) {
  const dateFilter = encodeURIComponent(`{"start":"${sinceIso}"}`);
  let rawTasks = [];
  let nextPageToken = null;

  while (true) {
    const url = nextPageToken
      ? `/api/wrike/tasks?nextPageToken=${nextPageToken}`
      : `/api/wrike/tasks?fields=${FIELDS_FILTER}&updatedDate=${dateFilter}&pageSize=1000`;
    console.log("[WrikeCache] fetching:", url);
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[WrikeCache] 400 body:", body);
      throw new Error(`Wrike tasks fetch failed: ${res.status}`);
    }
    const json = await res.json();
    rawTasks = [...rawTasks, ...(json.data || [])];
    nextPageToken = json.nextPageToken;
    if (!nextPageToken) break;
  }

  return rawTasks;
}

// Fetch-by-id returns every field we need by default and 400s if they're named
// in fields=, so no fields param here. Only the list endpoint needs FIELDS_FILTER.
async function fetchOneTask(id) {
  try {
    const r = await fetch(`/api/wrike/tasks/${id}`);
    if (r.ok) return (await r.json()).data?.[0] || null;
  } catch (e) {
    console.warn(`[WrikeCache] refetch ${id} error`, e);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Re-fetch specific tasks by id, up to 100 per request. Used where the list
// endpoint's pages 2+ dropped optional fields (description, subTaskIds), and by
// every webhook handler, so a live-patched task has the same fields as a synced one.
// ---------------------------------------------------------------------------
async function fetchBatched(ids) {
  const out = [];
  // Batch up to 100 IDs per request — Wrike supports comma-separated IDs.
  const BATCH = 100;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    let ok = false;
    try {
      const r = await fetch(`/api/wrike/tasks/${batch.join(",")}`);
      if (r.ok) {
        out.push(...((await r.json()).data || []));
        ok = true;
      }
    } catch (e) {
      console.warn(`[WrikeCache] batch refetch error`, e);
    }
    if (ok) continue;
    // One bad id (deleted / no longer shared with this account) fails the
    // whole comma-list — retry per id so the rest of the batch isn't lost
    // with it.
    for (const id of batch) {
      const task = await fetchOneTask(id);
      if (task) out.push(task);
    }
  }
  return out;
}

// Several components react to the same webhook event; collapse their concurrent
// requests for a task into one. Entries go as soon as they settle, so this is
// not a cache.
const inflight = new Map();

export async function fetchTasksByIds(ids) {
  const unique = [...new Set(ids)];
  const pending = unique.filter((id) => !inflight.has(id));

  if (pending.length) {
    const batch = fetchBatched(pending);
    for (const id of pending) {
      const p = batch
        .then((tasks) => tasks.find((t) => t.id === id) || null)
        .catch(() => null)
        .finally(() => { if (inflight.get(id) === p) inflight.delete(id); });
      inflight.set(id, p);
    }
  }

  const results = await Promise.all(unique.map((id) => inflight.get(id)));
  return results.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Root studio folders whose direct children are film/campaign folders
// ---------------------------------------------------------------------------
const STUDIO_FOLDER_TITLES = ["WARNER BROS", "SONY"];

function deriveFolderCampaigns(folderDictionary) {
  const campaigns = [];
  const seen = new Set();
  for (const folder of Object.values(folderDictionary)) {
    if (!STUDIO_FOLDER_TITLES.includes(folder.title?.trim().toUpperCase())) continue;
    for (const childId of folder.childIds || []) {
      if (seen.has(childId)) continue;
      seen.add(childId);
      const child = folderDictionary[childId];
      if (!child?.title) continue;
      const title = child.title.trim().replace(/_/g, " ");
      if (!title || title.startsWith("_") || title.toUpperCase().includes("ARCHIVE") || title.toUpperCase().includes("TEMPLATE")) continue;
      campaigns.push({
        id: `folder-${childId}`,
        folderId: childId,
        title,
        wrikeLink: `https://www.wrike.com/open.htm?id=${childId}`,
        studioHint: "Others",
        isFolder: true,
        notes: [],
        matrices: [],
        links: [],
      });
    }
  }
  return campaigns;
}

// ---------------------------------------------------------------------------
// Whose tasks the shared cache keeps
// ---------------------------------------------------------------------------
// Wrike ids of everyone in a department with a team board (see
// departments.js usesTeamBoard). Throws if profiles can't be read or come back
// empty, so a sync never mistakes "couldn't load the team" for "nobody is on
// it" and purges the cache.
let teamIdsCache = { at: 0, ids: null };
const TEAM_IDS_TTL_MS = 5 * 60 * 1000;

async function loadTeamIds() {
  if (teamIdsCache.ids && Date.now() - teamIdsCache.at < TEAM_IDS_TTL_MS) return teamIdsCache.ids;
  const { data, error } = await supabase
    .from("profiles")
    .select("wrike_user_id, department")
    .not("department", "is", null);
  if (error) throw new Error(`team roster unavailable: ${error.message}`);
  const ids = (data || []).filter((p) => p.wrike_user_id && usesTeamBoard(p.department)).map((p) => p.wrike_user_id);
  if (!ids.length) throw new Error("team roster is empty");
  teamIdsCache = { at: Date.now(), ids: new Set(ids) };
  return teamIdsCache.ids;
}

// ---------------------------------------------------------------------------
// Catching up with the shared cache on load
// ---------------------------------------------------------------------------
// The older catch-up: rows whose Wrike updatedDate passed the local cursor
// (everything when there's no local copy). Misses removals and rows rewritten
// without a Wrike change, so it's only the fallback now.
async function updatedDateCatchUp(hasLocal) {
  const cursor = hasLocal ? await getLocalCursor() : null;
  const sinceOverlap = cursor
    ? new Date(new Date(cursor).getTime() - CURSOR_OVERLAP_MS).toISOString()
    : null;
  let pulled = [];
  const PAGE = 1000;
  let page = 0;
  while (true) {
    // .range() needs an ORDER BY, or pages overlap and skip rows.
    let q = supabase
      .from("wrike_tasks_cache")
      .select("task_data")
      .order("id")
      .range(page * PAGE, (page + 1) * PAGE - 1);
    if (sinceOverlap) q = q.gt("updated_date", sinceOverlap);
    const { data, error } = await q;
    if (error || !data?.length) break;
    pulled = [...pulled, ...data.map((r) => r.task_data)];
    if (data.length < PAGE) break;
    page++;
  }
  return pulled;
}

// Catch-up from the cache's own change log (see sharedTaskSync.js): rows
// written and ids removed since this browser last looked, plus a weekly
// two-way id check against the server. Throws on failure; the caller then
// falls back to updatedDateCatchUp.
const RECONCILED_AT_KEY = "xyi_cache_reconciled_at";

async function changeLogCatchUp(local) {
  if (!local.length) {
    const { tasks, cursor } = await pullAll(supabase);
    localStorage.setItem(RECONCILED_AT_KEY, String(Date.now()));
    return { pulled: tasks, removedIds: [], cursor, full: true };
  }
  let cursor = await getServerCursor();
  let pulled = [];
  if (!cursor) {
    // First run with the change log: the old catch-up covers what changed
    // before it existed.
    pulled = await updatedDateCatchUp(true);
    cursor = TRACKING_START;
  }
  const changes = await pullSharedChanges(supabase, cursor);
  const removedIds = [...changes.removedIds];
  pulled.push(...changes.tasks);

  const lastReconciled = Number(localStorage.getItem(RECONCILED_AT_KEY)) || 0;
  if (Date.now() - lastReconciled > RECONCILE_EVERY_MS) {
    const { goneIds, missingTasks } = await reconcileWithServer(supabase, local.map((t) => t.id));
    console.log(`[WrikeCache] id check: ${goneIds.length} stale, ${missingTasks.length} missing`);
    removedIds.push(...goneIds);
    pulled.push(...missingTasks);
    localStorage.setItem(RECONCILED_AT_KEY, String(Date.now()));
  }
  return { pulled, removedIds, cursor: changes.cursor, full: false };
}

// Incoming copy wins, but a parsed MATRIX table is never lost to a sparser copy.
function mergeIncoming(map, t) {
  const existing = map.get(t.id);
  if (existing?.tableHtml && !t.tableHtml) {
    map.set(t.id, { ...t, tableHtml: existing.tableHtml, notesText: t.notesText || existing.notesText });
  } else {
    map.set(t.id, t);
  }
}

// ---------------------------------------------------------------------------
// Main hook
// ---------------------------------------------------------------------------
export function useWrikeCache() {
  const [tasks, setTasks]                       = useState([]);
  const [folderCampaigns, setFolderCampaigns]   = useState([]);
  const [filmCodeMappings, setFilmCodeMappings] = useState({});
  const [isSyncing, setIsSyncing]               = useState(false);
  const [isScanning, setIsScanning]             = useState(false);
  const [lastSynced, setLastSynced]             = useState(null);
  const [syncError, setSyncError]               = useState(null);
  const syncingRef  = useRef(false);
  const scanningRef = useRef(false);
  // Live mirror of `tasks` for non-reactive readers (sync/webhook relevance
  // checks) — reading state inside those callbacks would go stale.
  const tasksRef = useRef([]);
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);
  // Dictionaries needed to enrich a single webhook-pushed task outside of a
  // full sync() call — sync() only keeps these as local variables, so we
  // mirror the latest copy here whenever mount-load or sync() refreshes them.
  const enrichCtxRef = useRef({
    folderDictionary: {},
    contactDictionary: {},
    statusDictionary: {},
    childToParent: {},
    filmCodeMappings: {},
  });

  const wrikeUserId = localStorage.getItem("wrike_user_id");

  // --- Load cached tasks on mount: local mirror first, then Supabase deltas ---
  // The shared cache is tens of MB, so each browser keeps a local mirror and only
  // pulls rows whose updated_date passed its cursor. A full download happens once
  // per browser.
  useEffect(() => {
    if (bootStarted) return;
    bootStarted = true;
    (async () => {
      // 1) Hydrate from the local mirror — unless its format is stale, in
      // which case ignore it and re-pull everything once.
      const formatOk = localStorage.getItem(CACHE_FORMAT_KEY) === CACHE_FORMAT;
      const local = formatOk ? await loadLocalTasks() : [];
      const map = new Map(local.map((t) => [t.id, t]));
      if (local.length) setTasks(local);
      try {
        const fc = JSON.parse(localStorage.getItem(FOLDER_CAMPAIGNS_KEY) || "[]");
        if (fc.length) setFolderCampaigns(fc);
      } catch { /* ignore */ }

      // 2) Catch up with the shared cache: from its change log when the
      // database has one, else by Wrike's updatedDate as before.
      let result = null;
      if (await hasChangeTracking(supabase)) {
        try {
          result = await changeLogCatchUp(local);
        } catch (e) {
          console.warn("[WrikeCache] change-log catch-up failed, using updatedDate:", e.message);
        }
      }
      if (!result) {
        result = { pulled: await updatedDateCatchUp(local.length > 0), removedIds: [], cursor: null, full: !local.length };
      }
      const { pulled, removedIds } = result;
      console.log(
        `[WrikeCache] hydrate: ${local.length} local, ${pulled.length} pulled, ${removedIds.length} removed ` +
        `${result.full ? "(cold start)" : "(delta)"}${result.cursor ? "" : " [updatedDate]"}`
      );

      // A complete download replaces the mirror, so nothing the server no
      // longer has survives in it. Only for the change-log path, whose full
      // pull throws rather than return part of the table.
      if (result.full && result.cursor) await clearLocalTasks();
      removedIds.forEach((id) => map.delete(id));
      pulled.forEach((t) => mergeIncoming(map, t));
      if (pulled.length || removedIds.length) {
        setTasks([...map.values()]);
        await saveLocalTasks(result.full ? [...map.values()] : pulled.map((t) => map.get(t.id)));
        await removeLocalTasks(removedIds);
      }
      if (result.cursor) await setServerCursor(result.cursor);
      const loaded = [...map.values()];
      await advanceLocalCursor(loaded);
      localStorage.setItem(CACHE_FORMAT_KEY, CACHE_FORMAT);

      // Load latest meta — light fields only. The folder/contact/status
      // dictionaries are multi-MB blobs; they're fetched further down only
      // if something actually needs repairing.
      const { data: meta } = await supabase
        .from("wrike_sync_meta")
        .select("last_synced_at,film_code_mappings")
        .eq("wrike_user_id", SHARED_META_ID)
        .maybeSingle();
      if (meta?.last_synced_at) setLastSynced(new Date(meta.last_synced_at));
      if (meta?.film_code_mappings && Object.keys(meta.film_code_mappings).length) {
        setFilmCodeMappings(meta.film_code_mappings);
      }
      // Only the (small) film mappings are available here — the mount select
      // deliberately skips the multi-MB dictionaries. The webhook handler
      // lazily fetches them on its first event if they're still empty.
      enrichCtxRef.current = {
        ...enrichCtxRef.current,
        filmCodeMappings: meta?.film_code_mappings || {},
      };

      // --- SELF-HEAL + STUDIO BACKFILL ---
      // Re-fetch broken cached tasks by id, refresh a sparse folder dictionary, then
      // fill in studioName where it's missing.
      if (wrikeUserId && loaded.length) {
        // Broken cached copies: MATRIX tasks missing parentIds or their table, and Print
        // launch hubs cached from list pages 2+ without subTaskIds (the Launch Tracker
        // needs them for its market links).
        // A refetch that comes back the same means the gap is real (a hub with
        // no subtasks yet), so a checked task is left alone for a week. The mark
        // is saved in the shared cache, so one check covers every browser, and a
        // sync that rewrites the task drops it.
        const recentlyChecked = (t) =>
          t._repairCheckedAt && Date.now() - Date.parse(t._repairCheckedAt) < REPAIR_RECHECK_MS;
        const broken = loaded.filter(
          (t) =>
            !recentlyChecked(t) &&
            ((t.title?.toUpperCase().includes("MATRIX") && (!t.tableHtml || !t.parentIds?.length)) ||
              (t.title && PRINT_HUB_RE.test(t.title) && (!t.subTaskIds?.length || !t.notesText)))
        );
        // Nothing to heal: skip the block, and with it the 1 MB folder_dictionary
        // download. Most cached tasks have no resolvable studio at all, so the
        // studio backfill runs at most daily rather than on every load.
        const lastStudioProbe = Number(localStorage.getItem(STUDIO_PROBE_AT_KEY)) || 0;
        const needsStudioProbe =
          Date.now() - lastStudioProbe > STUDIO_PROBE_EVERY_MS && loaded.some((t) => !t.studioName);
        // Launch-hub subtasks that aren't cached. Most were completed before the sync
        // window, so no sync will ever pull them; backfill them by id once.
        const cachedIds = new Set(loaded.map((t) => t.id));
        const subIdsOfHubs = () => [...new Set(
          loaded
            .filter((t) => t.title && PRINT_HUB_RE.test(t.title))
            .flatMap((t) => t.subTaskIds || [])
            .filter((id) => !cachedIds.has(id))
        )];
        if (broken.length === 0 && !needsStudioProbe && subIdsOfHubs().length === 0) return;

        // Only now pay for the dictionary blobs (status/contact dicts ride
        // along so backfilled subtasks get real workflow-status names).
        const { data: dictRow } = await supabase
          .from("wrike_sync_meta")
          .select("folder_dictionary,contact_dictionary,status_dictionary")
          .eq("wrike_user_id", SHARED_META_ID)
          .maybeSingle();

        if (broken.length > 0) {
          console.log(`[WrikeCache] repairing ${broken.length} MATRIX/launch-hub tasks (missing table/parentIds/subTaskIds)`);
          const refetched = await fetchTasksByIds(broken.map((t) => t.id));
          const refetchedById = new Map(refetched.map((t) => [t.id, t]));
          const checkedAt = new Date().toISOString();
          const repaired = broken
            .map((t) => {
              const full = refetchedById.get(t.id);
              if (!full) return { ...t, _repairCheckedAt: checkedAt };
              const parsed = parseWrikeData(full.description);
              return {
                ...t,
                _repairCheckedAt: checkedAt,
                parentIds: full.parentIds || t.parentIds,
                subTaskIds: full.subTaskIds?.length ? full.subTaskIds : t.subTaskIds,
                responsibleIds: full.responsibleIds || t.responsibleIds,
                tableHtml: parsed.tableHtml || t.tableHtml,
                notesText: parsed.notesText || t.notesText,
                extractedPathData: parsed.extractedPathData || t.extractedPathData,
              };
            });
          if (repaired.length) {
            for (const t of repaired) {
              await supabase.from("wrike_tasks_cache").update({ task_data: t }).eq("id", t.id);
            }
            await saveLocalTasks(repaired);
            setTasks((prev) => {
              const m = new Map(prev.map((p) => [p.id, p]));
              repaired.forEach((t) => m.set(t.id, t));
              return [...m.values()];
            });
            // Update loaded so the studio backfill below sees the repaired parentIds
            repaired.forEach((t) => {
              const idx = loaded.findIndex((l) => l.id === t.id);
              if (idx >= 0) loaded[idx] = t;
            });
            console.log(`[WrikeCache] repaired ${repaired.length} MATRIX tasks`);
          }
        }

        // Get fresh folder dictionary. The cached Supabase copy may be unusable for
        // tree-climbing if it predates the childIds fix (childIds absent or empty),
        // so we build the reverse parent map and re-fetch whenever it comes out empty.
        let fd = dictRow?.folder_dictionary || {};
        let c2p = buildChildToParents(fd);
        if (Object.keys(fd).length < 500 || Object.keys(c2p).length === 0) {
          console.log("[WrikeCache] folder dict sparse or missing childIds — fetching fresh from Wrike");
          let freshFd = {};
          try {
            freshFd = await fetchAllFolders();
          } catch (e) {
            console.warn("[WrikeCache] fresh folder fetch failed, keeping the cached copy:", e.message);
          }
          if (Object.keys(freshFd).length > 100) {
            fd = freshFd;
            c2p = buildChildToParents(fd);
            console.log(`[WrikeCache] fresh folder dict: ${Object.keys(fd).length} folders`);
            supabase.from("wrike_sync_meta").upsert({ wrike_user_id: SHARED_META_ID, folder_dictionary: fd });
          }
        }
        console.log(`[WrikeCache] backfill: ${Object.keys(fd).length} folders, ${Object.keys(c2p).length} parent links`);
        enrichCtxRef.current = { ...enrichCtxRef.current, folderDictionary: fd, childToParent: c2p };
        const derived = deriveFolderCampaigns(fd);
        if (derived.length > 0) {
          console.log(`[WrikeCache] folder campaigns derived: ${derived.length}`);
          setFolderCampaigns(derived);
          try { localStorage.setItem(FOLDER_CAMPAIGNS_KEY, JSON.stringify(derived)); } catch { /* ignore */ }
        }

        const needsStudio = needsStudioProbe ? loaded.filter((t) => !t.studioName) : [];
        if (needsStudioProbe) localStorage.setItem(STUDIO_PROBE_AT_KEY, String(Date.now()));
        if (needsStudio.length > 0 && Object.keys(fd).length > 100) {
          const backfilled = needsStudio
            .map((t) => ({ ...t, studioName: getStudioName(t, fd, c2p) }))
            .filter((t) => t.studioName);
          if (backfilled.length > 0) {
            setTasks((prev) => {
              const m = new Map(prev.map((p) => [p.id, p]));
              backfilled.forEach((t) => m.set(t.id, t));
              return [...m.values()];
            });
            backfilled.forEach((t) => {
              supabase.from("wrike_tasks_cache").update({ task_data: t }).eq("id", t.id);
            });
            saveLocalTasks(backfilled);
            console.log(`[WrikeCache] studio backfilled ${backfilled.length} tasks`);
          }
        }

        // --- PRINT LAUNCH SUBTASK BACKFILL ---
        // Fetch and enrich the hub subtasks the sync window can't reach and persist them
        // to both caches. Recomputed after the repair above, so a hub that just got its
        // subTaskIds back is included in this pass.
        const missingSubIds = subIdsOfHubs();
        if (missingSubIds.length > 0) {
          console.log(`[WrikeCache] backfilling ${missingSubIds.length} print launch subtasks`);
          const rawSubs = await fetchTasksByIds(missingSubIds);
          if (rawSubs.length > 0) {
            const enrichedSubs = enrichTasks(
              rawSubs,
              fd,
              dictRow?.contact_dictionary || {},
              dictRow?.status_dictionary || {},
              c2p,
              enrichCtxRef.current.filmCodeMappings || {}
            );
            const rows = enrichedSubs.map((t) => ({
              id: t.id,
              wrike_user_id: wrikeUserId,
              task_data: stripForStorage(t),
              updated_date: t.updatedDate ?? null,
            }));
            for (let i = 0; i < rows.length; i += 500) {
              await supabase.from("wrike_tasks_cache").upsert(rows.slice(i, i + 500), { onConflict: "id" });
            }
            await saveLocalTasks(enrichedSubs);
            setTasks((prev) => {
              const m = new Map(prev.map((p) => [p.id, p]));
              enrichedSubs.forEach((t) => m.set(t.id, t));
              return [...m.values()];
            });
            console.log(`[WrikeCache] backfilled ${enrichedSubs.length} print launch subtasks`);
          }
        }
      }
    })();
  }, []);

  // --- Core sync function ---
  const sync = useCallback(async ({ fullRefresh = false } = {}) => {
    if (!wrikeUserId) return;
    if (syncingRef.current) return;
    syncingRef.current = true;
    setIsSyncing(true);
    setSyncError(null);

    try {
      // Resolve wrike_user_id — re-fetch from API if localStorage was cleared
      let userId = wrikeUserId;
      if (!userId) {
        const meRes = await fetch("/api/wrike/contacts?me=true");
        if (meRes.ok) {
          const meJson = await meRes.json();
          userId = meJson.data?.[0]?.id;
          if (userId) localStorage.setItem("wrike_user_id", userId);
        }
      }
      if (!userId) throw new Error("Could not resolve Wrike user ID");

      // Light probe first: "did we sync recently?" must not drag the multi-MB
      // dictionary blobs across the wire. sync() fires speculatively (mount,
      // board tab switches) and usually skips — only a real sync below
      // pays for the full meta row.
      if (!fullRefresh) {
        const { data: probe } = await supabase
          .from("wrike_sync_meta")
          .select("last_synced_at")
          .eq("wrike_user_id", SHARED_META_ID)
          .maybeSingle();
        const lastProbe = probe?.last_synced_at ? new Date(probe.last_synced_at).getTime() : 0;
        if (Date.now() - lastProbe < SYNC_INTERVAL_MS) {
          console.log("[WrikeCache] skipping sync — last synced", probe?.last_synced_at);
          return;
        }
      }

      // Read existing meta (last sync time + cached dicts) — one shared row
      const { data: meta } = await supabase
        .from("wrike_sync_meta")
        .select("*")
        .eq("wrike_user_id", SHARED_META_ID)
        .maybeSingle();

      const now = Date.now();
      const lastSync = meta?.last_synced_at ? new Date(meta.last_synced_at).getTime() : 0;

      // Determine the lookback window — always format as 2026-03-24T00:00:00Z (no ms, no offset)
      const toWrikeDate = (d) => new Date(d).toISOString().split(".")[0] + "Z";
      const sinceIso = fullRefresh || !meta?.last_synced_at
        ? toWrikeDate(new Date(new Date().setMonth(new Date().getMonth() - LOOKBACK_MONTHS)))
        : toWrikeDate(meta.last_synced_at);

      // Refresh folder/contact/status dicts once a day, on their own clock
      // (dictionaries_refreshed_at): measured from last_synced_at they never got a day
      // old while anyone was syncing. Without that column, falls back to last_synced_at.
      const hasDictClock = !!meta && "dictionaries_refreshed_at" in meta;
      const dictRefreshedAt = hasDictClock
        ? (meta.dictionaries_refreshed_at ? new Date(meta.dictionaries_refreshed_at).getTime() : 0)
        : lastSync;
      const metaAge = now - dictRefreshedAt;
      const folderDictSize = Object.keys(meta?.folder_dictionary || {}).length;
      const needsMetaRefresh = fullRefresh || metaAge > META_MAX_AGE_MS || !meta?.folder_dictionary || folderDictSize < 10;

      let folderDictionary  = meta?.folder_dictionary  || {};
      let contactDictionary = meta?.contact_dictionary || {};
      let statusDictionary  = meta?.status_dictionary  || {};
      const existingFilmMappings = meta?.film_code_mappings || {};
      let dictionariesComplete = false;

      if (needsMetaRefresh) {
        ({ folderDictionary, contactDictionary, statusDictionary, complete: dictionariesComplete } =
          await fetchWrikeMeta({ folderDictionary, contactDictionary, statusDictionary }));
      }

      // Fetch tasks changed since last sync
      const rawTasks = await fetchWrikeTasks(sinceIso);

      // Fill in folders the dictionary lacks. If that's incomplete (rate limit), say
      // so: climbs over a partial tree give confident wrong answers.
      if (rawTasks.length > 0) {
        const hydration = await hydrateMissingFolders(rawTasks, folderDictionary);
        if (!hydration.complete) {
          console.warn(
            `[WrikeCache] enriching against an incomplete folder tree ` +
            `(${hydration.unresolved.length} unresolved after ${hydration.rounds} round(s))`
          );
        }
      }

      // Keep only tasks some team needs (the filter uses fields every page has).
      // Launch-hub subtasks are relevant by membership, not title (digital waves'
      // subtasks have no "_Print_" marker), so anything under a known hub is kept.
      const hubSubIds = new Set(
        [...tasksRef.current, ...rawTasks]
          .filter((t) => t.title && PRINT_HUB_RE.test(t.title))
          .flatMap((t) => t.subTaskIds || [])
      );
      const teamIds = await loadTeamIds();
      const relevantMap = new Map(
        filterToTeams(rawTasks, folderDictionary, teamIds).map((t) => [t.id, t])
      );
      for (const t of rawTasks) {
        if (hubSubIds.has(t.id)) relevantMap.set(t.id, t);
      }
      const relevant = [...relevantMap.values()];

      // Tasks that changed and no longer pass the filter (e.g. reassigned) are purged,
      // or their stale copy would stay forever. Only ids actually cached: a full
      // refresh sees ~15k others, too many for one DELETE URL.
      const cachedIdSet = new Set(tasksRef.current.map((t) => t.id));
      const droppedIds = rawTasks
        .filter((t) => !relevantMap.has(t.id) && cachedIdSet.has(t.id))
        .map((t) => t.id);

      // List pages 2+ come back without descriptions. Re-fetch them only for tasks
      // that keep one after enrichment (MATRIX, Print launch hubs); anyone else's is
      // discarded anyway.
      const missingDesc = relevant
        .filter((t) => !t.description && keepsDescription(t.title))
        .map((t) => t.id);
      if (missingDesc.length > 0) {
        console.log(`[WrikeCache] re-fetching descriptions for ${missingDesc.length} tasks`);
        const refetched = await fetchTasksByIds(missingDesc);
        const byId = new Map(refetched.map((t) => [t.id, t]));
        relevant.forEach((t) => {
          const full = byId.get(t.id);
          if (full) {
            t.description = full.description;
            t.customFields = full.customFields;
            // The paginated list dropped these base fields too (pages 2+ lose
            // the whole fields param) — restore them or hubs get cached with
            // no subTaskIds and the Launch Tracker loses its market links.
            if (!t.subTaskIds?.length && full.subTaskIds?.length) t.subTaskIds = full.subTaskIds;
            if (!t.parentIds?.length && full.parentIds?.length) t.parentIds = full.parentIds;
            if (!t.responsibleIds?.length && full.responsibleIds?.length) t.responsibleIds = full.responsibleIds;
          }
        });
      }

      // Build reverse childToParent map for upward BFS studio detection
      const childToParent = buildChildToParents(folderDictionary);

      // Derive folder-based campaigns from Warner Bros / Sony root folders
      if (needsMetaRefresh) {
        const derived = deriveFolderCampaigns(folderDictionary);
        if (derived.length > 0) {
          console.log(`[WrikeCache] folder campaigns (sync): ${derived.length}`);
          setFolderCampaigns(derived);
          try { localStorage.setItem(FOLDER_CAMPAIGNS_KEY, JSON.stringify(derived)); } catch { /* ignore */ }
        }
      }

      // Enrich the relevant set (parses description → tableHtml + notesText)
      const filtered = enrichTasks(relevant, folderDictionary, contactDictionary, statusDictionary, childToParent, existingFilmMappings);

      // Upsert to Supabase in batches, and mirror into the local IndexedDB
      // cache so the next page load doesn't need to re-download these rows.
      if (filtered.length > 0) {
        const rows = filtered.map((t) => ({
          id: t.id,
          wrike_user_id: userId,
          task_data: stripForStorage(t),
          updated_date: t.updatedDate ?? null,
        }));
        const BATCH = 500;
        for (let i = 0; i < rows.length; i += BATCH) {
          // PK is (id) — one shared row per task; wrike_user_id records who
          // synced it last.
          await supabase.from("wrike_tasks_cache").upsert(rows.slice(i, i + BATCH), { onConflict: "id" });
        }
        await saveLocalTasks(filtered);
        await advanceLocalCursor(filtered);
      }
      if (droppedIds.length > 0) {
        // Chunked — ids travel in the querystring, and one giant .in() list
        // exceeds the URL limit and kills the connection.
        for (let i = 0; i < droppedIds.length; i += 200) {
          await supabase.from("wrike_tasks_cache").delete().in("id", droppedIds.slice(i, i + 200));
        }
        await removeLocalTasks(droppedIds);
        console.log(`[WrikeCache] purged ${droppedIds.length} task(s) no team needs any more`);
      }

      // Collect code→filmName mappings discovered in this sync and merge with existing
      const newMappings = buildFilmCodeMappings(filtered);
      const mergedFilmMappings = { ...existingFilmMappings, ...newMappings };
      if (Object.keys(newMappings).length > 0) {
        setFilmCodeMappings(mergedFilmMappings);
        console.log(`[WrikeCache] film code mappings: ${Object.keys(mergedFilmMappings).length} total, ${Object.keys(newMappings).length} new this sync`);
      }

      // Persist meta. Each dictionary written is either fresh and complete or the copy
      // already there (fetchWrikeMeta keeps the previous copy of a failed list).
      await supabase.from("wrike_sync_meta").upsert({
        wrike_user_id: SHARED_META_ID,
        last_synced_at: new Date().toISOString(),
        folder_dictionary:  needsMetaRefresh ? folderDictionary  : (meta?.folder_dictionary  ?? {}),
        contact_dictionary: needsMetaRefresh ? contactDictionary : (meta?.contact_dictionary ?? {}),
        status_dictionary:  needsMetaRefresh ? statusDictionary  : (meta?.status_dictionary  ?? {}),
        film_code_mappings: mergedFilmMappings,
        // Only sent if the column exists, and only after a complete refresh, so a
        // failed refresh is retried on the next sync.
        ...(hasDictClock && dictionariesComplete
          ? { dictionaries_refreshed_at: new Date().toISOString() }
          : {}),
      });
      enrichCtxRef.current = {
        folderDictionary,
        contactDictionary,
        statusDictionary,
        childToParent,
        filmCodeMappings: mergedFilmMappings,
      };

      // Merge into state, then fill studioName where missing using the in-memory
      // folder dictionary (older tasks outside the sync window are never re-enriched).
      setTasks((prev) => {
        const map = new Map(prev.map((t) => [t.id, t]));
        droppedIds.forEach((id) => map.delete(id));
        filtered.forEach((t) => map.set(t.id, t));
        const merged = [...map.values()];

        const needsStudio = merged.filter((t) => !t.studioName);
        if (needsStudio.length > 0 && Object.keys(folderDictionary).length > 0) {
          const backfilled = [];
          needsStudio.forEach((t) => {
            const studio = getStudioName(t, folderDictionary, childToParent);
            if (studio) {
              const updated = { ...t, studioName: studio };
              map.set(t.id, updated);
              backfilled.push(updated);
            }
          });
          if (backfilled.length > 0) {
            console.log(`[WrikeCache] studio backfilled ${backfilled.length} tasks (sync)`);
            backfilled.forEach((t) => {
              supabase.from("wrike_tasks_cache").update({ task_data: t }).eq("id", t.id);
            });
            saveLocalTasks(backfilled);
          }
        }

        return [...map.values()];
      });

      const syncedAt = new Date();
      setLastSynced(syncedAt);
    } catch (err) {
      console.error("Wrike cache sync failed:", err);
      setSyncError(err.message);
    } finally {
      syncingRef.current = false;
      setIsSyncing(false);
    }
  }, [wrikeUserId]);

  // --- Background sync on mount (after cache loads) ---
  useEffect(() => {
    if (!wrikeUserId) return;
    const t = setTimeout(() => sync(), 500);
    return () => clearTimeout(t);
  }, [wrikeUserId, sync]);

  const syncNow = useCallback(() => sync({ fullRefresh: true }), [sync]);

  // --- Live updates: Wrike webhook events via Supabase Realtime ---
  // The Worker writes a row to wrike_webhook_events per changed task. Fetch those
  // tasks and run them through the same filter and enrichment as sync(). The
  // 15-minute sync covers missed webhooks and times when no tab is open.
  // Pull what other tabs have written to the shared cache since this browser
  // last looked. Used instead of fetching from Wrike for webhook events another
  // tab claimed.
  const catchUpFromSharedCache = useCallback(async () => {
    const cursor = await getServerCursor();
    if (!cursor) return;
    const { tasks: changed, removedIds, cursor: next } = await pullSharedChanges(supabase, cursor);
    if (changed.length || removedIds.length) {
      setTasks((prev) => {
        const map = new Map(prev.map((t) => [t.id, t]));
        removedIds.forEach((id) => map.delete(id));
        changed.forEach((t) => mergeIncoming(map, t));
        return [...map.values()];
      });
      await saveLocalTasks(changed);
      await removeLocalTasks(removedIds);
    }
    await setServerCursor(next);
  }, []);

  // Debounced: a quiet spell of 8s, or at most a minute during a busy one, so
  // a steady stream of events costs one small read a minute, not one per event.
  const catchUpTimer = useRef(null);
  const catchUpFirstAsked = useRef(0);
  const scheduleCatchUp = useCallback(() => {
    const now = Date.now();
    if (!catchUpTimer.current) catchUpFirstAsked.current = now;
    clearTimeout(catchUpTimer.current);
    const wait = Math.min(8000, Math.max(0, catchUpFirstAsked.current + 60000 - now));
    catchUpTimer.current = setTimeout(() => {
      catchUpTimer.current = null;
      catchUpFromSharedCache().catch((e) => console.warn("[WrikeCache] shared cache catch-up failed", e));
    }, wait);
  }, [catchUpFromSharedCache]);
  useEffect(() => () => clearTimeout(catchUpTimer.current), []);

  const handleWebhookTaskIds = useCallback(async (allIds, events = []) => {
    if (!allIds.length) return;

    // Every open tab gets every event. Only the tab that claims an event
    // fetches from Wrike and writes the shared cache; the rest catch up from
    // the cache. Without claiming (older database, or no event ids), every tab
    // handles everything, as before.
    let ids = allIds;
    let deletedIds = [];
    const claimed = events.length ? await claimWebhookEvents(supabase, events.map((e) => e.id)) : null;
    if (claimed) {
      const won = events.filter((e) => claimed.has(Number(e.id)));
      if (won.length < events.length) scheduleCatchUp();
      deletedIds = [...new Set(won.filter((e) => e.event_type === "TaskDeleted").map((e) => e.task_id))];
      ids = [...new Set(won.map((e) => e.task_id))].filter((id) => !deletedIds.includes(id));
    }

    // Deleted in Wrike: remove from the shared cache (which records the
    // removal for other browsers) and from here.
    if (deletedIds.length) {
      for (let i = 0; i < deletedIds.length; i += 200) {
        await supabase.from("wrike_tasks_cache").delete().in("id", deletedIds.slice(i, i + 200));
      }
      await removeLocalTasks(deletedIds);
      setTasks((prev) => prev.filter((t) => !deletedIds.includes(t.id)));
    }
    if (!ids.length) return;

    let ctx = enrichCtxRef.current;
    if (Object.keys(ctx.folderDictionary).length === 0) {
      // No dictionaries in memory yet (e.g. tab just opened, sync() hasn't run) —
      // fall back to the shared meta row in Supabase. Paid at most once per
      // session, and only if a webhook event arrives before a full sync.
      const { data: meta } = await supabase
        .from("wrike_sync_meta")
        .select("folder_dictionary,contact_dictionary,status_dictionary,film_code_mappings")
        .eq("wrike_user_id", SHARED_META_ID)
        .maybeSingle();
      ctx = {
        folderDictionary: meta?.folder_dictionary || {},
        contactDictionary: meta?.contact_dictionary || {},
        statusDictionary: meta?.status_dictionary || {},
        childToParent: buildChildToParents(meta?.folder_dictionary || {}),
        filmCodeMappings: meta?.film_code_mappings || {},
      };
      enrichCtxRef.current = ctx;
    }

    const raw = await fetchTasksByIds(ids);
    if (!raw.length) return;

    // Same relevance check sync() applies — a webhook-changed task that no
    // longer (or never did) pass filterToTeams must not be added to the
    // shared cache, and must be purged if it's there from before. Launch-hub
    // subtasks are relevant by membership (see sync()) — a status change on a
    // digital wave's per-market subtask must update it, not purge it.
    const hubSubIds = new Set(
      [...tasksRef.current, ...raw]
        .filter((t) => t.title && PRINT_HUB_RE.test(t.title))
        .flatMap((t) => t.subTaskIds || [])
    );
    let teamIds;
    try {
      teamIds = await loadTeamIds();
    } catch (e) {
      // Without the roster we can't tell what to keep; the next sync covers it.
      console.warn("[WrikeCache] webhook update skipped:", e.message);
      return;
    }
    const relevantMap = new Map(
      filterToTeams(raw, ctx.folderDictionary, teamIds).map((t) => [t.id, t])
    );
    for (const t of raw) {
      if (hubSubIds.has(t.id)) relevantMap.set(t.id, t);
    }
    const relevant = [...relevantMap.values()];
    const droppedIds = raw.filter((t) => !relevantMap.has(t.id)).map((t) => t.id);

    const enriched = enrichTasks(
      relevant,
      ctx.folderDictionary,
      ctx.contactDictionary,
      ctx.statusDictionary,
      ctx.childToParent,
      ctx.filmCodeMappings
    );

    if (enriched.length > 0) {
      const rows = enriched.map((t) => ({
        id: t.id,
        wrike_user_id: wrikeUserId,
        task_data: stripForStorage(t),
        updated_date: t.updatedDate ?? null,
      }));
      await supabase.from("wrike_tasks_cache").upsert(rows, { onConflict: "id" });
      // Mirror pushed tasks locally so the next reload's delta doesn't need
      // to re-download them.
      await saveLocalTasks(enriched);
      await advanceLocalCursor(enriched);
    }
    if (droppedIds.length > 0) {
      await supabase.from("wrike_tasks_cache").delete().in("id", droppedIds);
      await removeLocalTasks(droppedIds);
    }

    setTasks((prev) => {
      const map = new Map(prev.map((p) => [p.id, p]));
      droppedIds.forEach((id) => map.delete(id));
      enriched.forEach((t) => map.set(t.id, t));
      return [...map.values()];
    });
    console.log(`[WrikeCache] realtime: updated ${enriched.length}, purged ${droppedIds.length} task(s) from webhook event(s)`);
  }, [wrikeUserId, scheduleCatchUp]);

  useEffect(() => {
    if (!wrikeUserId) return;
    return subscribeToWrikeTaskEvents(handleWebhookTaskIds);
  }, [wrikeUserId, handleWebhookTaskIds]);

  // --- Broad film-code mapping scan (all tasks, not just the cached ones) ---
  // Fetches every task from the last 2 years with minimal fields (parentIds only),
  // runs getFilmName via tree-climb on each, and persists newly discovered code→name
  // pairs without touching last_synced_at or the task cache.
  const scanFilmMappings = useCallback(async () => {
    if (!wrikeUserId) return;
    if (scanningRef.current) return;
    scanningRef.current = true;
    setIsScanning(true);

    try {
      // Load existing mappings + folder dict from the shared meta row
      const { data: meta } = await supabase
        .from("wrike_sync_meta")
        .select("folder_dictionary, film_code_mappings")
        .eq("wrike_user_id", SHARED_META_ID)
        .maybeSingle();

      let fd = meta?.folder_dictionary || {};
      const existingMappings = meta?.film_code_mappings || filmCodeMappings;

      // Fetch a fresh folder dict if the cached one is too sparse to tree-climb
      if (Object.keys(fd).length < 100) {
        try {
          fd = await fetchAllFolders();
        } catch (e) {
          console.warn("[FilmScan] folder fetch failed:", e.message);
        }
        console.log(`[FilmScan] fetched ${Object.keys(fd).length} folders`);
      }

      // Build reverse childId→parentId map so getFilmName can climb deep hierarchies
      // even when the flat folder list only returned childIds (not parentIds).
      const childToParent = buildChildToParents(fd);

      // Fetch all tasks updated in the last 2 years — minimal fields (parentIds only,
      // no descriptions) so the response is fast and lightweight.
      const SCAN_FIELDS = encodeURIComponent("[parentIds]");
      const since = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000)
        .toISOString().split(".")[0] + "Z";
      const dateFilter = encodeURIComponent(`{"start":"${since}"}`);

      let allTasks = [];
      let nextPageToken = null;
      while (true) {
        const url = nextPageToken
          ? `/api/wrike/tasks?nextPageToken=${nextPageToken}`
          : `/api/wrike/tasks?fields=${SCAN_FIELDS}&updatedDate=${dateFilter}&pageSize=1000`;
        const r = await fetch(url);
        if (!r.ok) { console.warn("[FilmScan] task fetch failed", r.status); break; }
        const j = await r.json();
        allTasks = [...allTasks, ...(j.data || [])];
        nextPageToken = j.nextPageToken;
        if (!nextPageToken) break;
      }
      console.log(`[FilmScan] ${allTasks.length} tasks to scan`);

      const newMappings = {};
      for (const task of allTasks) {
        if (!task.title) continue;
        const rawPrefix = task.title.split(/[_|-]/)[0].trim();
        // Only well-formed codes (2–8 uppercase alphanumeric chars starting with a letter)
        if (!/^[A-Z][A-Z0-9]{1,7}$/.test(rawPrefix)) continue;
        // Skip codes we already know
        if (existingMappings[rawPrefix] || newMappings[rawPrefix]) continue;

        const filmName = getFilmName(task, fd, "", {}, childToParent);
        if (!filmName || filmName === "Unknown Project") continue;

        // Skip if the result is just the title-cased prefix (raw fallback, not useful)
        const fallbackName = rawPrefix.charAt(0) + rawPrefix.slice(1).toLowerCase();
        if (filmName === fallbackName) continue;

        newMappings[rawPrefix] = filmName;
      }

      const merged = { ...existingMappings, ...newMappings };
      setFilmCodeMappings(merged);
      console.log(`[FilmScan] ${Object.keys(newMappings).length} new mappings, ${Object.keys(merged).length} total`);

      await supabase
        .from("wrike_sync_meta")
        .update({ film_code_mappings: merged })
        .eq("wrike_user_id", SHARED_META_ID);
    } catch (err) {
      console.error("[FilmScan] failed:", err);
    } finally {
      scanningRef.current = false;
      setIsScanning(false);
    }
  }, [wrikeUserId, filmCodeMappings]);

  // `sync` (soft) respects the 15-min interval — cheap to call speculatively,
  // e.g. whenever a page that depends on fresh data becomes active.
  // `syncNow` forces a full refresh regardless of how recently synced.
  return { tasks, folderCampaigns, filmCodeMappings, isSyncing, isScanning, lastSynced, syncError, sync, syncNow, scanFilmMappings };
}
