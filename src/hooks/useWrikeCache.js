import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "../lib/supabaseClient";
import {
  loadLocalTasks,
  saveLocalTasks,
  removeLocalTasks,
  getLocalCursor,
  advanceLocalCursor,
} from "../lib/localTaskCache";
import {
  enrichTasks,
  filterToMotionTeam,
  hydrateMissingFolders,
  parseWrikeData,
  getStudioName,
  getFilmName,
  buildChildToParent,
  buildFilmCodeMappings,
} from "../lib/wrikeEnrich";
import { subscribeToWrikeTaskEvents } from "../lib/wrikeWebhookSubscription";

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

// Guards the mount hydration against React StrictMode's dev double-invoke —
// without it every dev reload downloaded the Supabase cache twice.
let bootStarted = false;

// A task's permalink is always https://www.wrike.com/open.htm?id=<id>, so
// storing it is ~1.4 MB of pure redundancy across 25k rows that every cold
// start then re-downloads. Strip it from the *stored* copy only — the
// in-memory object and the local IndexedDB mirror keep it, and the one
// consumer that read it without an id fallback (Canvas) now reconstructs it.
const stripForStorage = ({ permalink, ...rest }) => rest;

// ---------------------------------------------------------------------------
// Fetch folders, contacts, workflows from Wrike
// ---------------------------------------------------------------------------
async function fetchWrikeMeta() {
  // Paginate folders — childIds is NOT returned by default on the flat /folders
  // list, so request it explicitly. We store childIds and build a reverse
  // childToParent map for upward tree climbing (parentIds is never returned).
  const folderDictionary = {};
  const FOLDER_FIELDS = encodeURIComponent("[childIds]");
  let folderUrl = `/api/wrike/folders?fields=${FOLDER_FIELDS}`;
  while (folderUrl) {
    const fRes = await fetch(folderUrl);
    if (!fRes.ok) { console.warn("[WrikeCache] folders fetch failed", fRes.status); break; }
    const fJson = await fRes.json();
    fJson.data?.forEach((f) => { folderDictionary[f.id] = { id: f.id, title: f.title, childIds: f.childIds || [] }; });
    folderUrl = fJson.nextPageToken
      ? `/api/wrike/folders?fields=${FOLDER_FIELDS}&nextPageToken=${fJson.nextPageToken}`
      : null;
  }
  console.log(`[WrikeCache] folder dictionary loaded: ${Object.keys(folderDictionary).length} folders`);

  const [cRes, wRes] = await Promise.all([
    fetch("/api/wrike/contacts"),
    fetch("/api/wrike/workflows"),
  ]);

  const contactDictionary = {};
  (await cRes.json()).data?.forEach((u) => {
    contactDictionary[u.id] = `${u.firstName || ""} ${u.lastName || ""}`.trim();
  });

  const statusDictionary = {};
  (await wRes.json()).data?.forEach((wf) => {
    wf.customStatuses?.forEach((s) => { statusDictionary[s.id] = s.name; });
  });

  return { folderDictionary, contactDictionary, statusDictionary };
}

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

// Progressively smaller field lists to retry with. Wrike rejects the WHOLE
// request with 400 "Fields parameter value 'X' not allowed" if ANY field in
// fields= isn't visible to the connected account for that specific task —
// seen for customFields on a task outside this account's custom-field
// visibility scope (custom fields can be scoped per space/team in Wrike).
// This is real per-task access control, not something a fixed field list can
// predict — so a single such task must degrade gracefully (fewer fields)
// rather than fail the whole fetch and vanish from whatever list needed it.
const FIELDS_FALLBACKS = [
  FIELDS_FILTER,
  encodeURIComponent("[parentIds,responsibleIds,subTaskIds,description]"),
  null, // bare Wrike defaults, no optional fields — always succeeds
];

// Which fallback tier Wrike actually accepted for a given task, remembered so
// repeat webhook events for the same task skip straight to the request that
// works instead of re-earning the same 400s every time. A handful of tasks get
// touched by Wrike automation every few seconds, and each event was re-walking
// the whole ladder — hundreds of known-doomed requests a minute against a
// rate-limited API.
//
// Entries expire: field visibility is account/space scoped and can change (a
// task moves into a space we can see), so a degraded task is retried at full
// fields once a day rather than being written off forever.
const FIELD_TIER_KEY = "xyi_wrike_field_tier_v1";
const FIELD_TIER_TTL_MS = 24 * 60 * 60 * 1000;

const fieldTiers = (() => {
  try {
    const stored = JSON.parse(localStorage.getItem(FIELD_TIER_KEY) || "{}");
    const now = Date.now();
    return new Map(
      Object.entries(stored).filter(([, e]) => e && now - e.at < FIELD_TIER_TTL_MS)
    );
  } catch {
    return new Map();
  }
})();

function getFieldTier(id) {
  const entry = fieldTiers.get(id);
  if (!entry || Date.now() - entry.at >= FIELD_TIER_TTL_MS) return 0;
  return entry.tier;
}

let persistTimer = null;
function setFieldTier(id, tier) {
  // Tier 0 is the default — only degraded tasks are worth remembering.
  if (tier === 0) {
    if (!fieldTiers.delete(id)) return;
  } else {
    if (fieldTiers.get(id)?.tier === tier) return;
    fieldTiers.set(id, { tier, at: Date.now() });
  }
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      localStorage.setItem(FIELD_TIER_KEY, JSON.stringify(Object.fromEntries(fieldTiers)));
    } catch { /* quota — the in-memory map still does the job this session */ }
  }, 1000);
}

const taskUrl = (ids, fields) =>
  fields ? `/api/wrike/tasks/${ids}?fields=${fields}` : `/api/wrike/tasks/${ids}`;

async function fetchOneTask(id, startTier = getFieldTier(id)) {
  for (let tier = startTier; tier < FIELDS_FALLBACKS.length; tier++) {
    try {
      const r = await fetch(taskUrl(id, FIELDS_FALLBACKS[tier]));
      if (r.ok) {
        setFieldTier(id, tier);
        return (await r.json()).data?.[0] || null;
      }
    } catch (e) {
      console.warn(`[WrikeCache] refetch ${id} error`, e);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Re-fetch specific tasks by ID *with* the fields param.
// Wrike pagination drops optional fields (description, customFields) on pages
// 2+, so tasks from later pages come back without their description — which is
// where the MATRIX table + notes live. Fetching by ID guarantees we get them.
//
// Explicit fields= (not just relying on get-by-id defaults) — callers of this
// function read parentIds and customFields off the result (the MATRIX repair
// and the sync-time description backfill below), and every webhook-driven
// caller (useWrikeCache's and useMotionBoardTasks' realtime patch) needs the
// same enrichment inputs a full sync gets, so a live-patched task's project/
// studio name and Motion-team relevance don't silently degrade versus one
// that came from a full resync.
// ---------------------------------------------------------------------------
async function fetchBatched(ids) {
  const out = [];
  // Batch up to 100 IDs per request — Wrike supports comma-separated IDs.
  const BATCH = 100;

  // Group by remembered field tier: a task known to reject customFields would
  // 400 the whole batch it rides in, so it goes out with its own tier's peers
  // rather than poisoning the batch and forcing everyone into per-id retries.
  const byTier = new Map();
  for (const id of ids) {
    const tier = getFieldTier(id);
    if (!byTier.has(tier)) byTier.set(tier, []);
    byTier.get(tier).push(id);
  }

  for (const [tier, tierIds] of byTier) {
    for (let i = 0; i < tierIds.length; i += BATCH) {
      const batch = tierIds.slice(i, i + BATCH);
      let ok = false;
      try {
        const r = await fetch(taskUrl(batch.join(","), FIELDS_FALLBACKS[tier]));
        if (r.ok) {
          out.push(...((await r.json()).data || []));
          ok = true;
        }
      } catch (e) {
        console.warn(`[WrikeCache] batch refetch error`, e);
      }
      if (ok) continue;
      // Batch failed — some task in it has a field-visibility issue we hadn't
      // seen yet (see FIELDS_FALLBACKS above). Fall back per-id, tiering fields
      // down per task instead of losing the whole batch to one bad task.
      //
      // A one-id batch pins the blame: that task just failed at this tier, so
      // start it at the next one. With >1 id the culprit is unknown — the rest
      // are likely fine at this tier — so each retries from its own memo.
      const startTier = batch.length === 1 ? tier + 1 : undefined;
      for (const id of batch) {
        const task = await fetchOneTask(id, startTier ?? getFieldTier(id));
        if (task) out.push(task);
      }
    }
  }
  return out;
}

// Four components subscribe to the same webhook event stream and each asked for
// the same changed task independently, so one Wrike edit fanned out into four
// identical fetch ladders. Collapse concurrent callers onto one request per
// task. Entries are dropped as soon as they settle — this coalesces the fan-out
// of a single event, it is not a result cache, so a task that genuinely changes
// again is always refetched.
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

  // --- Load cached tasks on mount: IndexedDB mirror first, Supabase deltas only ---
  // Load all rows regardless of wrike_user_id — single-team tool, cache is shared.
  // The full cache is tens of MB; downloading it from Supabase on every page
  // load (twice, under StrictMode) was burning GBs of egress per day. Now the
  // browser hydrates instantly from its local mirror and only pulls rows whose
  // updated_date moved past the local cursor. A full download happens exactly
  // once per browser (cold start / cleared site data).
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

      // 2) Delta-pull changed rows from Supabase (full pull only on cold start)
      const cursor = local.length ? await getLocalCursor() : null;
      const sinceOverlap = cursor
        ? new Date(new Date(cursor).getTime() - CURSOR_OVERLAP_MS).toISOString()
        : null;
      let pulled = [];
      const PAGE = 1000;
      let page = 0;
      while (true) {
        // .order("id") is load-bearing: .range() pagination without an ORDER
        // BY is non-deterministic in Postgres — pages overlapped and skipped,
        // silently dropping thousands of tasks from what the app saw.
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
      console.log(
        `[WrikeCache] hydrate: ${local.length} local, ${pulled.length} pulled ${cursor ? "(delta)" : "(cold start)"}`
      );

      if (pulled.length) {
        for (const t of pulled) {
          const existing = map.get(t.id);
          // Incoming row wins, but never lose a parsed MATRIX table to a
          // sparser copy of the same task.
          if (existing?.tableHtml && !t.tableHtml) {
            map.set(t.id, { ...t, tableHtml: existing.tableHtml, notesText: t.notesText || existing.notesText });
          } else {
            map.set(t.id, t);
          }
        }
        setTasks([...map.values()]);
        // Cold start mirrors everything; delta runs only write what changed
        await saveLocalTasks(cursor ? pulled.map((t) => map.get(t.id)) : [...map.values()]);
      }
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
      // MATRIX tasks that predate parentIds in FIELDS_FILTER have parentIds=undefined.
      // Re-fetch those by ID to get full data. Also re-fetch any still missing tableHtml.
      // After repair, fetch a fresh folder dict if the Supabase copy is sparse, then
      // backfill studioName on every task that still lacks it.
      if (wrikeUserId && loaded.length) {
        const broken = loaded.filter(
          (t) => t.title?.toUpperCase().includes("MATRIX") && (!t.tableHtml || !t.parentIds?.length)
        );
        // Nothing to heal → skip the whole block, most importantly the
        // multi-MB folder_dictionary download it needs. This is the steady
        // state: repairs and backfills persist, so after one clean pass this
        // costs zero egress.
        const needsStudioProbe = loaded.some((t) => !t.studioName);
        if (broken.length === 0 && !needsStudioProbe) return;

        // Only now pay for the dictionary blob
        const { data: dictRow } = await supabase
          .from("wrike_sync_meta")
          .select("folder_dictionary")
          .eq("wrike_user_id", SHARED_META_ID)
          .maybeSingle();

        if (broken.length > 0) {
          console.log(`[WrikeCache] repairing ${broken.length} MATRIX tasks (missing table/parentIds)`);
          const refetched = await fetchTasksByIds(broken.map((t) => t.id));
          const refetchedById = new Map(refetched.map((t) => [t.id, t]));
          const repaired = broken
            .filter((t) => refetchedById.get(t.id))
            .map((t) => {
              const full = refetchedById.get(t.id);
              const parsed = parseWrikeData(full.description);
              return {
                ...t,
                parentIds: full.parentIds || t.parentIds,
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
        let c2p = buildChildToParent(fd);
        if (Object.keys(fd).length < 500 || Object.keys(c2p).length === 0) {
          console.log("[WrikeCache] folder dict sparse or missing childIds — fetching fresh from Wrike");
          const freshFd = {};
          const FF = encodeURIComponent("[childIds]");
          let folderUrl = `/api/wrike/folders?fields=${FF}`;
          let logged = false;
          while (folderUrl) {
            try {
              const fRes = await fetch(folderUrl);
              if (!fRes.ok) { console.warn("[WrikeCache] folders fetch failed", fRes.status); break; }
              const fJson = await fRes.json();
              if (!logged && fJson.data?.[0]) {
                console.log("[WrikeCache] sample folder:", JSON.stringify(fJson.data[0]));
                logged = true;
              }
              fJson.data?.forEach((f) => { freshFd[f.id] = { id: f.id, title: f.title, childIds: f.childIds || [] }; });
              folderUrl = fJson.nextPageToken
                ? `/api/wrike/folders?fields=${FF}&nextPageToken=${fJson.nextPageToken}`
                : null;
            } catch { break; }
          }
          if (Object.keys(freshFd).length > 100) {
            fd = freshFd;
            c2p = buildChildToParent(fd);
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

        const needsStudio = loaded.filter((t) => !t.studioName);
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
      // Motion Board tab switches) and usually skips — only a real sync below
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

      // Refresh folder/contact/status dicts if stale or missing
      const metaAge = now - lastSync;
      const folderDictSize = Object.keys(meta?.folder_dictionary || {}).length;
      const needsMetaRefresh = fullRefresh || metaAge > META_MAX_AGE_MS || !meta?.folder_dictionary || folderDictSize < 10;

      let folderDictionary  = meta?.folder_dictionary  || {};
      let contactDictionary = meta?.contact_dictionary || {};
      let statusDictionary  = meta?.status_dictionary  || {};
      const existingFilmMappings = meta?.film_code_mappings || {};

      if (needsMetaRefresh) {
        ({ folderDictionary, contactDictionary, statusDictionary } = await fetchWrikeMeta());
      }

      // Fetch tasks changed since last sync
      const rawTasks = await fetchWrikeTasks(sinceIso);

      // Hydrate any missing archive folder IDs
      if (rawTasks.length > 0) {
        await hydrateMissingFolders(rawTasks, folderDictionary);
      }

      // Filter to the motion-team-relevant subset FIRST (filter only uses base
      // fields — title/parentIds/responsibleIds/subTaskIds — present on every page).
      const relevant = filterToMotionTeam(rawTasks, folderDictionary, contactDictionary);

      // Tasks Wrike reports as changed but that no longer pass the filter
      // (e.g. reassigned off the Motion team) must be purged from the cache —
      // otherwise their stale pre-change copy lingers there forever, since
      // nothing else ever revisits a task once it drops out of relevance.
      const relevantIds = new Set(relevant.map((t) => t.id));
      const droppedIds = rawTasks.filter((t) => !relevantIds.has(t.id)).map((t) => t.id);

      // Re-fetch descriptions for any relevant task missing one (pagination drops
      // the fields param on pages 2+). This restores the MATRIX table + notes.
      const missingDesc = relevant.filter((t) => !t.description).map((t) => t.id);
      if (missingDesc.length > 0) {
        console.log(`[WrikeCache] re-fetching descriptions for ${missingDesc.length} tasks`);
        const refetched = await fetchTasksByIds(missingDesc);
        const byId = new Map(refetched.map((t) => [t.id, t]));
        relevant.forEach((t) => {
          const full = byId.get(t.id);
          if (full) {
            t.description = full.description;
            t.customFields = full.customFields;
          }
        });
      }

      // Build reverse childToParent map for upward BFS studio detection
      const childToParent = buildChildToParent(folderDictionary);

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
        await supabase.from("wrike_tasks_cache").delete().in("id", droppedIds);
        await removeLocalTasks(droppedIds);
        console.log(`[WrikeCache] purged ${droppedIds.length} task(s) no longer Motion-relevant`);
      }

      // Collect code→filmName mappings discovered in this sync and merge with existing
      const newMappings = buildFilmCodeMappings(filtered);
      const mergedFilmMappings = { ...existingFilmMappings, ...newMappings };
      if (Object.keys(newMappings).length > 0) {
        setFilmCodeMappings(mergedFilmMappings);
        console.log(`[WrikeCache] film code mappings: ${Object.keys(mergedFilmMappings).length} total, ${Object.keys(newMappings).length} new this sync`);
      }

      // Persist updated meta to the shared row
      await supabase.from("wrike_sync_meta").upsert({
        wrike_user_id: SHARED_META_ID,
        last_synced_at: new Date().toISOString(),
        folder_dictionary:  needsMetaRefresh ? folderDictionary  : (meta?.folder_dictionary  ?? {}),
        contact_dictionary: needsMetaRefresh ? contactDictionary : (meta?.contact_dictionary ?? {}),
        status_dictionary:  needsMetaRefresh ? statusDictionary  : (meta?.status_dictionary  ?? {}),
        film_code_mappings: mergedFilmMappings,
      });
      enrichCtxRef.current = {
        folderDictionary,
        contactDictionary,
        statusDictionary,
        childToParent,
        filmCodeMappings: mergedFilmMappings,
      };

      // Merge new tasks into state, then backfill studioName on any task still missing it.
      // Archived tasks (outside the lookback window) are never re-enriched, so we use the
      // live in-memory folderDictionary (always complete) rather than the Supabase-stored copy.
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

  // --- Live updates: Wrike webhook events pushed via Supabase Realtime ---
  // The Worker (worker/index.js) receives Wrike webhooks and writes lightweight
  // {task_id, event_type} rows into wrike_webhook_events. We pick those up here,
  // fetch just the changed task(s), and run them through the same enrichTasks
  // pipeline sync() uses — this is the fast path; sync()'s 15-min poll remains
  // the fallback for missed webhook deliveries or when no tab is open.
  const handleWebhookTaskIds = useCallback(async (ids) => {
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
        childToParent: buildChildToParent(meta?.folder_dictionary || {}),
        filmCodeMappings: meta?.film_code_mappings || {},
      };
      enrichCtxRef.current = ctx;
    }

    const raw = await fetchTasksByIds(ids);
    if (!raw.length) return;

    // Same relevance check sync() applies — a webhook-changed task that no
    // longer (or never did) pass filterToMotionTeam must not be added to the
    // shared cache, and must be purged if it's there from before.
    const relevant = filterToMotionTeam(raw, ctx.folderDictionary, ctx.contactDictionary);
    const relevantIds = new Set(relevant.map((t) => t.id));
    const droppedIds = raw.filter((t) => !relevantIds.has(t.id)).map((t) => t.id);

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
  }, [wrikeUserId]);

  useEffect(() => {
    if (!wrikeUserId) return;
    return subscribeToWrikeTaskEvents(handleWebhookTaskIds);
  }, [wrikeUserId, handleWebhookTaskIds]);

  // --- Broad film-code mapping scan (all tasks, not just Motion-filtered) ---
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
        const FF = encodeURIComponent("[childIds]");
        let url = `/api/wrike/folders?fields=${FF}`;
        while (url) {
          try {
            const r = await fetch(url);
            if (!r.ok) break;
            const j = await r.json();
            j.data?.forEach((f) => { fd[f.id] = { id: f.id, title: f.title, childIds: f.childIds || [] }; });
            url = j.nextPageToken
              ? `/api/wrike/folders?fields=${FF}&nextPageToken=${j.nextPageToken}`
              : null;
          } catch { break; }
        }
        console.log(`[FilmScan] fetched ${Object.keys(fd).length} folders`);
      }

      // Build reverse childId→parentId map so getFilmName can climb deep hierarchies
      // even when the flat folder list only returned childIds (not parentIds).
      const childToParent = buildChildToParent(fd);

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
