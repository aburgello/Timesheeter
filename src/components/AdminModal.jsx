import React, { useState, useEffect } from "react";
import { X, Shield, Users, Clock, Key, RefreshCw, CheckCircle, AlertCircle, Zap, Eye } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { ALL_DEPARTMENTS } from "../lib/departments";
import { useDepartmentPreviewState, setDepartmentPreview } from "../hooks/useDepartment";
import { isServiceAccount } from "../lib/people";

export default function AdminModal({ onClose }) {
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [taskCounts, setTaskCounts] = useState({});
  const [webhookState, setWebhookState] = useState({ status: "idle", message: "" });
  const departmentPreview = useDepartmentPreviewState();

  const registerWebhook = async () => {
    setWebhookState({ status: "loading", message: "" });
    try {
      const res = await fetch("/api/wrike/webhook/register", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setWebhookState({ status: "success", message: `Live sync enabled (webhook ${data.webhookId})` });
    } catch (e) {
      setWebhookState({ status: "error", message: e.message });
    }
  };

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const { data: profileData } = await supabase
          .from("profiles")
          .select("*")
          .order("updated_at", { ascending: false });

        if (profileData) {
          // Wrike's own service accounts (AM Team, Magic Wrike, All
          // proofreaders) sync into profiles like any real contact but
          // aren't people — never count them toward team stats here.
          const realProfiles = profileData.filter((p) => !isServiceAccount(p.wrike_user_id));
          setProfiles(realProfiles);

          // Fetch task counts per user
          const ids = realProfiles.map((p) => p.wrike_user_id);
          const counts = {};
          await Promise.all(
            ids.map(async (uid) => {
              const { count } = await supabase
                .from("tasks")
                .select("id", { count: "exact", head: true })
                .eq("wrike_user_id", uid);
              counts[uid] = count || 0;
            })
          );
          setTaskCounts(counts);
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const fmtDate = (iso) => {
    if (!iso) return "Never";
    const d = new Date(iso);
    const mins = Math.floor((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  const hasToken = (p) => !!p.wrike_user_id; // proxy — if they have a row they've loaded the app

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-[#122027]/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-3xl w-full max-w-2xl shadow-2xl border border-[#dce4ec] overflow-hidden max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="h-1.5 bg-gradient-to-r from-[#122027] to-[#12a0e1]" />
        <div className="flex items-center gap-3 px-6 py-4 border-b border-[#dce4ec] bg-slate-50/50">
          <div className="p-2 bg-[#122027] rounded-xl">
            <Shield className="w-4 h-4 text-white" />
          </div>
          <div>
            <h2 className="text-base font-black text-[#122027]">Admin Panel</h2>
            <p className="text-[11px] text-[#768994] font-medium">Team overview — visible only to you</p>
          </div>
          <button onClick={onClose} className="ml-auto text-[#768994] hover:text-[#122027] transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Stats bar */}
        <div className="grid grid-cols-3 divide-x divide-[#dce4ec] border-b border-[#dce4ec]">
          {[
            { label: "Team members", value: profiles.length, icon: Users },
            { label: "Total rows logged", value: Object.values(taskCounts).reduce((a, b) => a + b, 0), icon: Clock },
            { label: "Active today", value: profiles.filter((p) => p.updated_at && new Date(p.updated_at) > new Date(Date.now() - 86400000)).length, icon: CheckCircle },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} className="px-5 py-3 text-center">
              <div className="text-xl font-black text-[#122027]">{loading ? "—" : value}</div>
              <div className="text-[10px] font-black text-[#768994] uppercase tracking-wider mt-0.5">{label}</div>
            </div>
          ))}
        </div>

        {/* Live sync setup */}
        <div className="flex items-center gap-3 px-6 py-3 border-b border-[#dce4ec] bg-slate-50/50">
          <button
            onClick={registerWebhook}
            disabled={webhookState.status === "loading"}
            className="flex items-center gap-1.5 text-[11px] font-black text-[#122027] bg-white border border-[#dce4ec] hover:border-[#12a0e1] rounded-full px-3 py-1.5 transition-colors disabled:opacity-50"
          >
            <Zap className={`w-3 h-3 text-[#12a0e1] ${webhookState.status === "loading" ? "animate-pulse" : ""}`} />
            {webhookState.status === "loading" ? "Enabling…" : "Enable live task sync"}
          </button>
          {webhookState.status === "success" && (
            <span className="flex items-center gap-1 text-[10px] font-bold text-[#1cc1a5]">
              <CheckCircle className="w-3 h-3" /> {webhookState.message}
            </span>
          )}
          {webhookState.status === "error" && (
            <span className="flex items-center gap-1 text-[10px] font-bold text-red-500">
              <AlertCircle className="w-3 h-3" /> {webhookState.message}
            </span>
          )}
        </div>

        {/* Department preview — swaps Home/Rail/command-palette/the board to
            show exactly what another department's page set looks like,
            without touching your own real profiles.department row. Every
            useDepartment() caller (App, Home, Rail) picks this up instantly
            via the preview-change event; a persistent banner (mounted once
            in App.jsx) reminds you it's active while you navigate around. */}
        <div className="flex items-center gap-2 px-6 py-3 border-b border-[#dce4ec] bg-slate-50/50 flex-wrap">
          <span className="flex items-center gap-1.5 text-[10px] font-black text-[#768994] uppercase tracking-wider mr-1">
            <Eye className="w-3 h-3" /> Preview as
          </span>
          <button
            onClick={() => setDepartmentPreview(null)}
            className={`text-[11px] font-black rounded-full px-3 py-1.5 border transition-colors ${
              !departmentPreview
                ? "bg-[#122027] text-white border-[#122027]"
                : "bg-white text-[#122027] border-[#dce4ec] hover:border-[#12a0e1]"
            }`}
          >
            You
          </button>
          {ALL_DEPARTMENTS.map((dept) => (
            <button
              key={dept}
              onClick={() => setDepartmentPreview(dept)}
              className={`text-[11px] font-black rounded-full px-3 py-1.5 border transition-colors ${
                departmentPreview === dept
                  ? "bg-[#12a0e1] text-white border-[#12a0e1]"
                  : "bg-white text-[#122027] border-[#dce4ec] hover:border-[#12a0e1]"
              }`}
            >
              {dept}
            </button>
          ))}
        </div>

        {/* Team list */}
        <div className="overflow-y-auto flex-1 p-4 space-y-2">
          {loading ? (
            <div className="flex items-center justify-center py-12 gap-3 text-[#768994]">
              <RefreshCw className="w-5 h-5 animate-spin text-[#12a0e1]" />
              <p className="text-sm font-bold">Loading team data…</p>
            </div>
          ) : profiles.length === 0 ? (
            <div className="text-center py-12 text-[#768994]">
              <Users className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm font-bold">No profiles found yet</p>
            </div>
          ) : (
            profiles.map((p) => {
              const initials = `${p.first_name?.[0] || ""}${p.last_name?.[0] || ""}`.toUpperCase() || "?";
              const isAdmin = p.wrike_user_id === "KUAWDLVN";
              const hasData = !!p.first_name;
              const mins = p.updated_at ? Math.floor((Date.now() - new Date(p.updated_at).getTime()) / 60000) : null;
              const isActive = mins !== null && mins < 1440; // active in last 24h

              return (
                <div key={p.wrike_user_id} className="flex items-center gap-4 bg-slate-50 border border-[#dce4ec] rounded-2xl p-4">
                  {/* Avatar */}
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-black text-sm shrink-0 ${
                    hasData
                      ? "bg-gradient-to-br from-[#12a0e1] to-[#1cc1a5] text-white shadow-sm"
                      : "bg-slate-200 text-slate-500"
                  }`}>
                    {initials}
                  </div>

                  {/* Identity */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-black text-[#122027]">
                        {p.first_name && p.last_name ? `${p.first_name} ${p.last_name}` : "Unknown user"}
                      </p>
                      {isAdmin && (
                        <span className="text-[9px] font-black text-[#122027] bg-[#122027]/10 px-1.5 py-0.5 rounded-full uppercase tracking-wider">
                          Admin
                        </span>
                      )}
                      {!hasData && (
                        <span className="flex items-center gap-1 text-[9px] font-black text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full uppercase tracking-wider">
                          <AlertCircle className="w-2.5 h-2.5" /> No profile
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                      {p.email && <span className="text-[11px] text-[#768994]">{p.email}</span>}
                      <span className="text-[10px] font-mono text-[#768994] opacity-60">{p.wrike_user_id}</span>
                    </div>
                  </div>

                  {/* Stats */}
                  <div className="flex items-center gap-4 shrink-0 text-right">
                    <div>
                      <p className="text-base font-black text-[#122027]">{taskCounts[p.wrike_user_id] ?? "—"}</p>
                      <p className="text-[9px] font-black text-[#768994] uppercase tracking-wider">rows</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className={`w-2 h-2 rounded-full ${isActive ? "bg-[#1cc1a5]" : "bg-slate-300"}`} />
                      <span className="text-[10px] font-bold text-[#768994]">{fmtDate(p.updated_at)}</span>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}