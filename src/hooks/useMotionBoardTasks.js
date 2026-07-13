import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";
import { enrichTasks, buildChildToParent } from "../lib/wrikeEnrich";
import { subscribeToWrikeTaskEvents } from "../lib/wrikeWebhookSubscription";
import { fetchTasksByIds } from "./useWrikeCache";
import { MOTION_TEAM_NAME_MAP } from "../constants";

const FIELDS = encodeURIComponent("[customFields,parentIds,responsibleIds,subTaskIds,description]");

// yyyy-MM-ddTHH:mm:ss — Wrike's dueDate filter rejects a trailing "Z"
// (unlike the updatedDate filter elsewhere, which requires one); confirmed
// via the actual 400 "Parameter 'dueDate' value is invalid" response.
const toWrikeDate = (d) => new Date(d).toISOString().split(".")[0];

function endOfNextWorkWeek() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const dayOfWeek = now.getDay(); // 0 = Sunday .. 6 = Saturday
  const daysUntilNextMonday = ((8 - dayOfWeek) % 7) || 7;
  const nextMonday = new Date(now);
  nextMonday.setDate(now.getDate() + daysUntilNextMonday);
  const nextFriday = new Date(nextMonday);
  nextFriday.setDate(nextMonday.getDate() + 4);
  nextFriday.setHours(23, 59, 59, 999);
  return nextFriday;
}

async function fetchContactDictionary() {
  const res = await fetch("/api/wrike/contacts");
  const contacts = (await res.json()).data || [];
  const contactDictionary = {};
  contacts.forEach((c) => {
    contactDictionary[c.id] = `${c.firstName || ""} ${c.lastName || ""}`.trim();
  });
  return { contacts, contactDictionary };
}

function resolveTeamIds(contacts) {
  const names = Object.keys(MOTION_TEAM_NAME_MAP);
  return contacts
    .filter((c) => {
      const name = `${c.firstName || ""} ${c.lastName || ""}`.trim();
      return names.includes(name) || name.includes("Riccardo");
    })
    .map((c) => c.id);
}

async function fetchFolderDictionary() {
  // Reuse the last synced copy — folder structure changes rarely, no need to
  // refetch the whole tree on every Motion Board mount.
  const { data: meta } = await supabase
    .from("wrike_sync_meta")
    .select("folder_dictionary,status_dictionary")
    .order("last_synced_at", { ascending: false })
    .limit(1)
    .single();
  let folderDictionary = meta?.folder_dictionary || {};
  const statusDictionary = meta?.status_dictionary || {};

  if (Object.keys(folderDictionary).length < 100) {
    // Cache empty/sparse (e.g. fresh deploy, no sync has run yet) — fall
    // back to a fresh fetch, same self-heal pattern useWrikeCache.js uses.
    const fresh = {};
    const FF = encodeURIComponent("[childIds]");
    let url = `/api/wrike/folders?fields=${FF}`;
    while (url) {
      try {
        const r = await fetch(url);
        if (!r.ok) break;
        const j = await r.json();
        j.data?.forEach((f) => { fresh[f.id] = { id: f.id, title: f.title, childIds: f.childIds || [] }; });
        url = j.nextPageToken ? `/api/wrike/folders?fields=${FF}&nextPageToken=${j.nextPageToken}` : null;
      } catch { break; }
    }
    if (Object.keys(fresh).length > 0) folderDictionary = fresh;
  }

  return { folderDictionary, statusDictionary };
}

async function fetchBoardTasks(teamIds, dueDateEnd) {
  const dueDateFilter = encodeURIComponent(JSON.stringify({ end: toWrikeDate(dueDateEnd) }));
  // Wrike wants a JSON array here, not repeated query params — same style as
  // its other list/object filters (fields=[...], dueDate={...}). Confirmed via
  // a 400 "Parameter 'responsibles' value is invalid" on the repeated form.
  const responsiblesFilter = encodeURIComponent(JSON.stringify(teamIds));
  let rawTasks = [];
  let nextPageToken = null;
  while (true) {
    const url = nextPageToken
      ? `/api/wrike/tasks?nextPageToken=${nextPageToken}`
      : `/api/wrike/tasks?status=Active&dueDate=${dueDateFilter}&responsibles=${responsiblesFilter}&fields=${FIELDS}&pageSize=1000`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn("[MotionBoard] tasks fetch failed", res.status, await res.text().catch(() => ""));
      break;
    }
    const json = await res.json();
    rawTasks = [...rawTasks, ...(json.data || [])];
    nextPageToken = json.nextPageToken;
    if (!nextPageToken) break;
  }
  return rawTasks;
}

// Narrow, independent board data source — fetches only Active tasks due today
// through the end of next work week, assigned to a team, once on mount. No
// periodic polling: freshness after that comes entirely from Wrike webhooks
// (worker/index.js -> wrike_webhook_events -> Supabase Realtime), unlike the
// shared useWrikeCache() hook other tabs use, which still needs the full
// historical dataset for logging time.
//
// `externalTeamIds`:
//   - undefined → Motion mode: resolve the team from contacts via the
//     hardcoded MOTION_TEAM_NAME_MAP (+ Riccardo), exactly as before.
//   - array     → Print (or any profiles-derived) mode: use these Wrike user
//     IDs directly as the team; wait until the array is non-empty, and
//     refetch if it changes.
export function useMotionBoardTasks(externalTeamIds) {
  const [boardTasks, setBoardTasks] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const ctxRef = useRef({
    folderDictionary: {},
    contactDictionary: {},
    statusDictionary: {},
    childToParent: {},
    teamIds: [],
    dueDateEnd: endOfNextWorkWeek(),
  });

  const external = externalTeamIds !== undefined;
  // Stable key so the effect refetches only when the actual id set changes,
  // not on every render's fresh array identity.
  const externalKey = external ? [...externalTeamIds].sort().join(",") : null;

  useEffect(() => {
    // External mode with no ids yet (roster still loading) — nothing to fetch.
    if (external && (!externalTeamIds || externalTeamIds.length === 0)) {
      setBoardTasks([]);
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    (async () => {
      try {
        const [{ contacts, contactDictionary }, { folderDictionary, statusDictionary }] = await Promise.all([
          fetchContactDictionary(),
          fetchFolderDictionary(),
        ]);
        const teamIds = external ? externalTeamIds : resolveTeamIds(contacts);
        const dueDateEnd = endOfNextWorkWeek();
        const childToParent = buildChildToParent(folderDictionary);
        ctxRef.current = { folderDictionary, contactDictionary, statusDictionary, childToParent, teamIds, dueDateEnd };

        const raw = await fetchBoardTasks(teamIds, dueDateEnd);
        const enriched = enrichTasks(raw, folderDictionary, contactDictionary, statusDictionary, childToParent, {});
        if (cancelled) return;
        setBoardTasks(enriched);

        const wrikeUserId = localStorage.getItem("wrike_user_id");
        if (enriched.length > 0 && wrikeUserId) {
          const rows = enriched.map((t) => ({
            id: t.id,
            wrike_user_id: wrikeUserId,
            task_data: t,
            updated_date: t.updatedDate ?? null,
          }));
          supabase.from("wrike_tasks_cache").upsert(rows).then(({ error: upsertError }) => {
            if (upsertError) console.warn("[MotionBoard] shared cache upsert failed", upsertError);
          });
        }
      } catch (err) {
        console.error("[MotionBoard] initial fetch failed", err);
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalKey]);

  const handleTaskIds = useCallback(async (ids) => {
    if (!ids.length) return;
    const ctx = ctxRef.current;
    const raw = await fetchTasksByIds(ids);
    if (!raw.length) return;

    const enriched = enrichTasks(raw, ctx.folderDictionary, ctx.contactDictionary, ctx.statusDictionary, ctx.childToParent, {});

    setBoardTasks((prev) => {
      const map = new Map(prev.map((t) => [t.id, t]));
      enriched.forEach((t) => {
        const dueDate = t.dueDate && t.dueDate !== "No Due Date" ? new Date(t.dueDate) : null;
        const inRange = dueDate && !isNaN(dueDate.getTime()) && dueDate <= ctx.dueDateEnd;
        const rawTask = raw.find((r) => r.id === t.id);
        const isTeamTask = rawTask?.responsibleIds?.some((id) => ctx.teamIds.includes(id));
        const belongs = t.status === "Active" && inRange && isTeamTask;
        if (belongs) map.set(t.id, t);
        else map.delete(t.id);
      });
      return [...map.values()];
    });
  }, []);

  useEffect(() => subscribeToWrikeTaskEvents(handleTaskIds), [handleTaskIds]);

  return { boardTasks, isLoading, error };
}
