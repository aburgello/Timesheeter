// The admin panel's "is Wrike syncing?" card. See lib/systemStatus.js for what
// each line means and when it warns.
import { useCallback, useEffect, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { statusLines, findOurWebhook } from "../../lib/systemStatus";

const DOT = {
  ok: "bg-emerald-500",
  warn: "bg-amber-400",
  bad: "bg-rose-500",
  info: "bg-slate-300",
};

async function loadStatus() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [meta, event, cache, removed, hooks] = await Promise.all([
    supabase.from("wrike_sync_meta").select("last_synced_at,dictionaries_refreshed_at,people_synced_at").eq("wrike_user_id", "shared").maybeSingle(),
    supabase.from("wrike_webhook_events").select("occurred_at").order("occurred_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("wrike_tasks_cache").select("id", { count: "estimated", head: true }),
    supabase.from("wrike_tasks_cache_removed").select("id", { count: "exact", head: true }).gt("removed_at", since),
    fetch("/api/wrike/webhooks").then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  return {
    lastSyncedAt: meta.data?.last_synced_at ?? null,
    dictionariesAt: meta.data?.dictionaries_refreshed_at ?? null,
    peopleSyncedAt: meta.data?.people_synced_at,
    lastEventAt: event.data?.occurred_at ?? null,
    webhook: hooks ? findOurWebhook(hooks.data, window.location.origin) : undefined,
    cacheRows: cache.error ? null : cache.count,
    removedRecently: removed.error ? null : removed.count,
  };
}

export function SystemStatusCard() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await loadStatus());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const register = async () => {
    setRegistering("Registering…");
    try {
      const res = await fetch("/api/wrike/webhook/register", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      setRegistering(res.ok ? "Registered" : `Failed: ${data.error || res.status}`);
      if (res.ok) refresh();
    } catch (e) {
      setRegistering(`Failed: ${e.message}`);
    }
  };

  const lines = status ? statusLines(status) : [];
  const hookLine = lines.find((l) => l.id === "webhook");

  return (
    <div className="bg-white rounded-3xl border border-[#dce4ec] shadow-sm p-5">
      <div className="flex items-center gap-2 mb-3">
        <Activity className="w-4 h-4 text-[#768994]" />
        <h3 className="text-sm font-bold text-[#2b3a44] flex-1">System status</h3>
        <button
          onClick={refresh}
          disabled={loading}
          className="p-1.5 rounded-lg text-[#768994] hover:bg-slate-100 disabled:opacity-50"
          title="Check again"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>
      {!status ? (
        <p className="text-xs text-[#768994]">Checking…</p>
      ) : (
        <ul className="grid gap-x-8 gap-y-1.5 sm:grid-cols-2">
          {lines.map((l) => (
            <li key={l.id} className="flex items-center gap-2 text-xs">
              <span className={`w-2 h-2 rounded-full shrink-0 ${DOT[l.level]}`} />
              <span className="text-[#768994] flex-1 truncate">{l.label}</span>
              <span className="font-semibold text-[#2b3a44] tabular-nums">{l.value}</span>
            </li>
          ))}
        </ul>
      )}
      {hookLine?.level === "bad" && (
        <div className="mt-3 flex items-center gap-3 text-xs">
          <span className="text-rose-600 flex-1">
            Boards only catch up on the 15-minute sync until live updates are registered again.
          </span>
          <button
            onClick={register}
            disabled={registering === "Registering…"}
            className="px-3 py-1.5 rounded-lg bg-[#2b3a44] text-white font-semibold disabled:opacity-50"
          >
            Register again
          </button>
          {registering && <span className="text-[#768994]">{registering}</span>}
        </div>
      )}
    </div>
  );
}
