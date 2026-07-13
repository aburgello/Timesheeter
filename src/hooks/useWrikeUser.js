import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { setWrikeUserId } from "../lib/supabaseClient";

// Lifetime stats are expensive to compute (full pagination of every completed
// task), so we cache the three resulting counts per user and only re-run the
// fetch in the background when the cache is older than this.
const STATS_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const statsKey = (uid) => `xyi_lifetime_stats_${uid}`;

/**
 * Fetches the current Wrike user from the personal token in localStorage.
 * Also provides handleFetchLifetimeStats and the derived task counts.
 */
export function useWrikeUser(wrikeData, triggerToast) {
  const [wrikeUser, setWrikeUser] = useState(null);
  const [userStats, setUserStats] = useState({
    month: 0,
    year: 0,
    allTime: 0,
    loading: false,
    fetched: false,
    syncedAt: null,
  });

  // Keep toast callback in a ref so handleFetchLifetimeStats stays stable even
  // if a caller (e.g. Tracker) passes a new triggerToast on every render.
  const triggerToastRef = useRef(triggerToast);
  useEffect(() => { triggerToastRef.current = triggerToast; });

  // Tracks which user we've already hydrated/refreshed so the effect's side
  // effects run at most once per user — immune to dependency churn.
  const hydratedRef = useRef(null);

  useEffect(() => {
    if (!wrikeUser) {
      fetch("/api/wrike/contacts?me=true")
        .then((res) => {
          if (!res.ok) throw new Error(`Wrike API error ${res.status}`);
          return res.json();
        })
        .then((json) => {
          if (json.data?.length > 0) {
            const { id, firstName, lastName, profiles, avatarUrl } =
              json.data[0]; // ← update destructure
            setWrikeUser({ id, firstName });
            setWrikeUserId(id, {
              firstName,
              lastName,
              email: profiles?.[0]?.email,
              avatarUrl,
            }); // ← pass profile data
          }
        })
        .catch((err) => {
          console.error("Failed to fetch Wrike user:", err.message);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFetchLifetimeStats = useCallback(
    async (silent = false) => {
      const uid = wrikeUser?.id;
      if (!uid) return;
      setUserStats((prev) => ({ ...prev, loading: true }));

      try {
        let rawTasks = [];
        let nextPageToken = null;
        let hasMore = true;

        while (hasMore) {
          let url = `/api/wrike/tasks?responsibles=[${uid}]&status=Completed&pageSize=1000`;
          if (nextPageToken) url += `&nextPageToken=${nextPageToken}`;

          const response = await fetch(url);
          const json = await response.json();
          rawTasks = [...rawTasks, ...(json.data || [])];
          nextPageToken = json.nextPageToken;
          hasMore = !!nextPageToken;
        }

        const now = new Date();
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(now.getDate() - 30);
        const startOfYear = new Date(now.getFullYear(), 0, 1);

        let monthCount = 0;
        let yearCount = 0;

        rawTasks.forEach((task) => {
          const d = new Date(
            task.completedDate || task.updatedDate || task.createdDate || 0
          );
          if (d >= thirtyDaysAgo) monthCount++;
          if (d >= startOfYear) yearCount++;
        });

        const syncedAt = new Date().toISOString();
        const counts = { month: monthCount, year: yearCount, allTime: rawTasks.length };
        setUserStats({ ...counts, loading: false, fetched: true, syncedAt });
        try {
          localStorage.setItem(statsKey(uid), JSON.stringify({ ...counts, syncedAt }));
        } catch (_) { /* storage full / disabled — non-fatal */ }
        if (!silent) triggerToastRef.current?.("Lifetime stats synced!", "success");
      } catch (err) {
        setUserStats((prev) => ({ ...prev, loading: false }));
        if (!silent) triggerToastRef.current?.("Failed to fetch stats.");
      }
    },
    [wrikeUser?.id]
  );

  // Load cached stats instantly, then refresh in the background when stale.
  // Guarded so it runs its side effects at most once per user.
  useEffect(() => {
    const uid = wrikeUser?.id;
    if (!uid || hydratedRef.current === uid) return;
    hydratedRef.current = uid;

    let cached = null;
    try {
      cached = JSON.parse(localStorage.getItem(statsKey(uid)) || "null");
    } catch (_) { /* ignore parse errors */ }

    if (cached) {
      setUserStats({
        month: cached.month ?? 0,
        year: cached.year ?? 0,
        allTime: cached.allTime ?? 0,
        loading: false,
        fetched: true,
        syncedAt: cached.syncedAt ?? null,
      });
    }

    const ageMs = cached?.syncedAt ? Date.now() - new Date(cached.syncedAt).getTime() : Infinity;
    if (ageMs > STATS_TTL_MS) {
      handleFetchLifetimeStats(true); // background, no toast
    }
  }, [wrikeUser?.id, handleFetchLifetimeStats]);

  const completedTasksCount = useMemo(() => {
    if (!wrikeData || !wrikeUser?.firstName) return 0;
    return wrikeData.filter(
      (t) =>
        t.assignees?.includes(wrikeUser.firstName) &&
        (t.status === "Completed" || t.status === "Delivered")
    ).length;
  }, [wrikeData, wrikeUser]);

  const myActiveWrikeTasks = useMemo(() => {
    if (!wrikeData || !wrikeUser?.firstName) return [];
    return wrikeData.filter(
      (t) => t.status === "Active" && t.assignees?.includes(wrikeUser.firstName)
    );
  }, [wrikeData, wrikeUser]);

  const myCompletedWrikeTasks = useMemo(() => {
    if (!wrikeData || !wrikeUser?.firstName) return [];
    return wrikeData.filter(
      (t) =>
        (t.status === "Completed" || t.status === "Delivered") &&
        t.assignees?.includes(wrikeUser.firstName)
    );
  }, [wrikeData, wrikeUser]);

  return {
    wrikeUser,
    userStats,
    handleFetchLifetimeStats,
    completedTasksCount,
    myActiveWrikeTasks,
    myCompletedWrikeTasks,
  };
}
