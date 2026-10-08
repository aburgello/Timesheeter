import React, { useState, useEffect } from "react";
import { X, Shield, CheckCircle, AlertCircle, Zap, Eye } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useDepartmentPreviewState, setDepartmentPreview } from "../hooks/useDepartment";
import { isServiceAccount, hasLeft } from "../lib/people";
import { SystemStatusCard } from "./management/SystemStatusCard";

export default function AdminModal({ onClose }) {
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [webhookState, setWebhookState] = useState({ status: "idle", message: "" });
  const departmentPreview = useDepartmentPreviewState();
  // The real list (Administration › Departments), so a department added there
  // can be previewed straight away.
  const [departments, setDepartments] = useState([]);
  useEffect(() => {
    supabase.from("job_departments").select("name").order("name")
      .then(({ data }) => setDepartments((data || []).map((d) => d.name).filter(Boolean)));
  }, []);

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
          const realProfiles = profileData.filter((p) => !isServiceAccount(p.wrike_user_id) && !hasLeft(p));
          setProfiles(realProfiles);
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

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
            <p className="text-[11px] text-[#768994] font-medium">System status and department preview. Visible only to you.</p>
          </div>
          <button onClick={onClose} className="ml-auto text-[#768994] hover:text-[#122027] transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Stats bar */}
        <div className="grid grid-cols-2 divide-x divide-[#dce4ec] border-b border-[#dce4ec]">
          {[
            { label: "Team members", value: profiles.length },
            { label: "Active today", value: profiles.filter((p) => p.updated_at && new Date(p.updated_at) > new Date(Date.now() - 86400000)).length },
          ].map(({ label, value }) => (
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
          {departments.map((dept) => (
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

        <div className="overflow-y-auto flex-1 p-4">
          <SystemStatusCard />
        </div>
      </div>
    </div>
  );
}