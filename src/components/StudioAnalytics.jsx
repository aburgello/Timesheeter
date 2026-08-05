import React, { useState, useEffect, useMemo, useRef } from "react";
import { Activity, CheckCircle2, Clock, Film, Table2, BarChart3, RefreshCw } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { cleanNamePart } from "../lib/formatName";
import { zoomFactor } from "../utils/zoom";

// Management-facing analytics, fed from two pools:
//  1) The in-memory Wrike task cache (wrikeData prop — the same 25k-task
//     array App already holds for Canvas/Hub/Timesheeter). Charts read it
//     directly: zero extra Supabase egress, which matters after this month's
//     quota blowout.
//  2) The timesheet rows in Supabase (`tasks` table) — young data (started
//     July 2026), so its chart is labeled as growing rather than pretending
//     to be history.
//
// Colors were validated with the dataviz palette checker against the white
// card surface (CVD ΔE 47.2 worst adjacent pair — well clear). Aqua and
// amber sit below 3:1 contrast, which is legal only with relief: every bar
// carries a direct value label, and every chart has a table toggle.
const SERIES = {
  blue:   "#2a78d6",
  aqua:   "#1baf7a",
  amber:  "#eda100",
  violet: "#4a3aa7",
  orange: "#eb6834",
};
const INK = "#122027";
const MUTED = "#768994";
const GRID = "#eef1f5";

// ── tiny data helpers ────────────────────────────────────────────────────────

// Timesheet time_spent formats, same set useTasks.js's parseDbTime accepts:
// "H:MM" (current), decimal hours ("0.5", legacy), integer minutes ("30").
function toHours(v) {
  if (!v || v === "none") return 0;
  const s = String(v);
  const hm = s.match(/^(\d+):(\d{2})$/);
  if (hm) return parseInt(hm[1]) + parseInt(hm[2]) / 60;
  const n = parseFloat(s);
  if (isNaN(n) || n <= 0) return 0;
  return s.includes(".") ? n : n / 60;
}

// tasks.date is dd/mm/yyyy (normalized 12 Jul 2026 — one stale-bundle batch
// had written m/d/yyyy before that).
function parseDdMmYyyy(s) {
  if (!s) return null;
  const [d, m, y] = s.split("/").map(Number);
  if (!d || !m || !y) return null;
  return new Date(y, m - 1, d);
}

const fmtInt = (n) => n.toLocaleString("en-GB");
const fmtHours = (n) => (n >= 100 ? Math.round(n).toLocaleString("en-GB") : n.toFixed(1)) + "h";

// Normalize a title/name to bare alphanumerics for fuzzy film matching.
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// ── chart card scaffolding ───────────────────────────────────────────────────

function ChartCard({ title, subtitle, rows, valueFmt, children }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <div className="bg-white border border-[#dce4ec] rounded-2xl p-5 shadow-sm min-w-0">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h3 className="font-display text-sm font-bold text-[#122027] tracking-tight">{title}</h3>
          {subtitle && <p className="text-[11px] text-[#768994] mt-0.5">{subtitle}</p>}
        </div>
        <button
          onClick={() => setAsTable((t) => !t)}
          title={asTable ? "Show chart" : "Show as table"}
          className="shrink-0 w-7 h-7 rounded-lg border border-[#dce4ec] text-[#768994] hover:text-[#122027] hover:border-slate-300 flex items-center justify-center transition-colors"
        >
          {asTable ? <BarChart3 className="w-3.5 h-3.5" /> : <Table2 className="w-3.5 h-3.5" />}
        </button>
      </div>
      {asTable ? (
        <div className="overflow-y-auto max-h-72">
          <table className="w-full text-xs">
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className="border-b border-[#eef1f5] last:border-b-0">
                  <td className="py-1.5 pr-3 text-[#122027] font-medium">{r.label}</td>
                  <td className="py-1.5 text-right text-[#768994] font-mono tabular-nums">{valueFmt(r.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        children
      )}
    </div>
  );
}

// Shared tooltip: one absolutely-positioned pill per chart, driven by hover.
function useTooltip() {
  const [tip, setTip] = useState(null); // { x, y, text }
  const show = (e, text) => {
    const box = e.currentTarget.closest("[data-chart]").getBoundingClientRect();
    // clientX and box.left are both visual pixels under html{zoom:1.1}; their
    // difference is a visual delta, but the tooltip is an absolute child of the
    // (zoomed) chart, so its left/top are re-zoomed on paint. Divide back to
    // layout space or the pill drifts ~10% off the cursor.
    const z = zoomFactor();
    setTip({ x: (e.clientX - box.left) / z, y: (e.clientY - box.top) / z, text });
  };
  const hide = () => setTip(null);
  const node = tip && (
    <div
      className="pointer-events-none absolute z-10 bg-[#122027] text-white text-[11px] font-bold rounded-lg px-2.5 py-1.5 shadow-lg whitespace-nowrap"
      style={{ left: tip.x + 12, top: tip.y - 34 }}
    >
      {tip.text}
    </div>
  );
  return { show, hide, node };
}

// Horizontal bar path: flat at the baseline (left), 4px rounded at the data
// end — per the mark spec, the rounding marks where the data stops.
function hBarPath(x, y, w, h, r = 4) {
  const rr = Math.min(r, w, h / 2);
  return `M${x},${y} h${w - rr} a${rr},${rr} 0 0 1 ${rr},${rr} v${h - 2 * rr} a${rr},${rr} 0 0 1 -${rr},${rr} h-${w - rr} z`;
}
// Vertical bar: flat baseline (bottom), rounded top.
function vBarPath(x, y, w, h, r = 4) {
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h} v-${h - rr} a${rr},${rr} 0 0 1 ${rr},-${rr} h${w - 2 * rr} a${rr},${rr} 0 0 1 ${rr},${rr} v${h - rr} z`;
}

// Measure the wrapper's layout width so each SVG's viewBox can match it 1:1.
// The charts used a fixed 560-wide viewBox with preserveAspectRatio="none",
// which stretched every glyph and rounded corner horizontally on any card
// wider than 560px (worst on the full-width "Hours logged by client" card).
// With viewBox width == the rendered width, 1 unit = 1 px: text is crisp, and
// the page's html { zoom } scales the whole chart uniformly (no distortion).
// contentRect.width is the layout (pre-zoom) width — exactly what we want.
function useElementWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      if (w) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

// ── horizontal top-N bar chart ───────────────────────────────────────────────

function BarsH({ rows, color, valueFmt }) {
  const { show, hide, node } = useTooltip();
  const [ref, W] = useElementWidth();
  const max = Math.max(...rows.map((r) => r.value), 1);
  const ROW_H = 26, GAP = 8, LABEL_W = 148, VAL_W = 52;
  const height = rows.length * (ROW_H + GAP) - GAP;
  const trackW = Math.max(W - LABEL_W - VAL_W, 1);
  return (
    <div className="relative" data-chart ref={ref} style={{ minHeight: height }}>
      {node}
      {W > 0 && (
      <svg width="100%" height={height} viewBox={`0 0 ${W} ${height}`} className="block">
        {rows.map((r, i) => {
          const y = i * (ROW_H + GAP);
          const w = Math.max((r.value / max) * trackW, 3);
          return (
            <g key={r.label}>
              <text x={LABEL_W - 8} y={y + ROW_H / 2 + 4} textAnchor="end" fontSize="11" fontWeight="600" fill={INK}>
                {r.label.length > 20 ? r.label.slice(0, 19) + "…" : r.label}
              </text>
              <path
                d={hBarPath(LABEL_W, y + 3, w, ROW_H - 6)}
                fill={color}
                onMouseMove={(e) => show(e, `${r.label} — ${valueFmt(r.value)}`)}
                onMouseLeave={hide}
              />
              <text x={LABEL_W + w + 6} y={y + ROW_H / 2 + 4} fontSize="11" fontWeight="700" fill={MUTED}>
                {valueFmt(r.value)}
              </text>
            </g>
          );
        })}
      </svg>
      )}
    </div>
  );
}

// ── monthly vertical bar chart ───────────────────────────────────────────────

function BarsMonthly({ rows, color, valueFmt = fmtInt, tipSuffix = "completed" }) {
  const { show, hide, node } = useTooltip();
  const [ref, W] = useElementWidth();
  const max = Math.max(...rows.map((r) => r.value), 1);
  const H = 190, PAD_B = 22, PAD_T = 18;
  const bw = W / rows.length;
  const peakIdx = rows.findIndex((r) => r.value === max);
  return (
    <div className="relative" data-chart ref={ref} style={{ minHeight: H }}>
      {node}
      {W > 0 && (
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} className="block">
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={W} y1={PAD_T + (H - PAD_B - PAD_T) * f} y2={PAD_T + (H - PAD_B - PAD_T) * f} stroke={GRID} strokeWidth="1" />
        ))}
        <line x1="0" x2={W} y1={H - PAD_B} y2={H - PAD_B} stroke="#dce4ec" strokeWidth="1" />
        {rows.map((r, i) => {
          const h = Math.max((r.value / max) * (H - PAD_B - PAD_T), r.value > 0 ? 3 : 0);
          const x = i * bw + bw * 0.18;
          const w = bw * 0.64;
          // Selective direct labels — peak + latest month only; hover covers the rest.
          const labeled = i === peakIdx || i === rows.length - 1;
          return (
            <g key={r.label}>
              {h > 0 && (
                <path
                  d={vBarPath(x, H - PAD_B - h, w, h)}
                  fill={color}
                  onMouseMove={(e) => show(e, `${r.full} — ${valueFmt(r.value)} ${tipSuffix}`)}
                  onMouseLeave={hide}
                />
              )}
              {labeled && r.value > 0 && (
                <text x={x + w / 2} y={H - PAD_B - h - 5} textAnchor="middle" fontSize="10" fontWeight="700" fill={INK}>
                  {valueFmt(r.value)}
                </text>
              )}
              {i % 2 === 0 && (
                <text x={x + w / 2} y={H - 7} textAnchor="middle" fontSize="9.5" fontWeight="600" fill={MUTED}>
                  {r.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      )}
    </div>
  );
}

// ── campaign progress: completed vs backlog, per film ────────────────────────
// Pure HTML/flex (no SVG) so labels never distort under the app's zoom. Each
// row's track length is the campaign's total task count relative to the busiest;
// the green fill is the completed share, the muted remainder is the live backlog.
function BarsProgress({ rows }) {
  const max = Math.max(...rows.map((r) => r.total), 1);
  return (
    <div className="space-y-2">
      {rows.map((r) => {
        const trackPct = (r.total / max) * 100;
        const donePct = r.total ? (r.done / r.total) * 100 : 0;
        return (
          <div key={r.label} className="flex items-center gap-3">
            <div className="w-[150px] shrink-0 text-right text-[11px] font-semibold text-[#122027] truncate" title={r.label}>
              {r.label}
            </div>
            <div className="flex-1 min-w-0">
              <div
                className="h-[18px] rounded-md bg-[#eef1f5] overflow-hidden"
                style={{ width: `${Math.max(trackPct, 2)}%` }}
                title={`${r.label} — ${r.done} completed, ${r.active} active`}
              >
                <div className="h-full bg-[#1baf7a]" style={{ width: `${donePct}%` }} />
              </div>
            </div>
            <div className="shrink-0 w-[104px] text-[10px] font-bold tabular-nums">
              <span className="text-[#0f766e]">{r.pct}%</span>
              <span className="text-[#b0bec5]"> · {r.done}/{r.total}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── KPI tile ─────────────────────────────────────────────────────────────────

function StatTile({ icon: Icon, label, value, sub }) {
  return (
    <div className="bg-white border border-[#dce4ec] rounded-2xl p-4 shadow-sm">
      <div className="flex items-center gap-2 text-[#768994] mb-2">
        <Icon className="w-3.5 h-3.5" />
        <span className="text-[10px] font-black uppercase tracking-widest">{label}</span>
      </div>
      <div className="font-display text-2xl font-bold text-[#122027] leading-none">{value}</div>
      {sub && <p className="text-[10px] text-[#768994] mt-1.5">{sub}</p>}
    </div>
  );
}

// ── the dashboard ────────────────────────────────────────────────────────────

export default function StudioAnalytics({ wrikeData = [] }) {
  const [logRows, setLogRows] = useState(null); // null = loading
  const [filmNorms, setFilmNorms] = useState([]); // curated film titles, normalized
  const [deptMap, setDeptMap] = useState({}); // wrike_user_id -> department

  useEffect(() => {
    let cancelled = false;
    supabase
      .from("tasks")
      .select("date, time_spent, additional_time, client, wrike_user_id")
      .order("id")
      .then(({ data }) => { if (!cancelled) setLogRows(data || []); });
    return () => { cancelled = true; };
  }, []);

  // Who's in which department — to re-cut logged hours by team.
  useEffect(() => {
    let cancelled = false;
    supabase.from("profiles").select("wrike_user_id, department").then(({ data }) => {
      if (cancelled) return;
      const m = {};
      (data || []).forEach((p) => { if (p.wrike_user_id) m[p.wrike_user_id] = p.department || "Unassigned"; });
      setDeptMap(m);
    });
    return () => { cancelled = true; };
  }, []);

  // Curated film list (Administration → Films) keeps "Campaign progress" honest:
  // Wrike's folder-climbed projectName is noisy (junk like "Film", "Edit", "Zal"
  // leaks in), so a campaign only counts if it matches a real film. Titles under
  // 5 chars are dropped so a stray short one can't substring-match everything.
  useEffect(() => {
    let cancelled = false;
    supabase.from("films").select("title").then(({ data }) => {
      if (cancelled) return;
      setFilmNorms((data || []).map((f) => norm(f.title)).filter((n) => n.length >= 5));
    });
    return () => { cancelled = true; };
  }, []);

  const now = new Date();
  const stats = useMemo(() => {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    let active = 0, completedThisMonth = 0;
    for (const t of wrikeData) {
      if (t.status === "Active") active++;
      if (t.completedDate && new Date(t.completedDate) >= monthStart) completedThisMonth++;
    }
    const hours30 = (logRows || []).reduce((s, r) => {
      const d = parseDdMmYyyy(r.date);
      if (!d || now - d > 30 * 86400000) return s;
      return s + toHours(r.time_spent) + toHours(r.additional_time);
    }, 0);
    return { active, completedThisMonth, hours30 };
  }, [wrikeData, logRows]); // eslint-disable-line react-hooks/exhaustive-deps

  const monthly = useMemo(() => {
    const buckets = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      buckets.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
        label: d.toLocaleDateString("en-GB", { month: "short" }),
        full: d.toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
        value: 0,
      });
    }
    const byKey = new Map(buckets.map((b) => [b.key, b]));
    for (const t of wrikeData) {
      if (!t.completedDate) continue;
      const b = byKey.get(t.completedDate.slice(0, 7));
      if (b) b.value++;
    }
    return buckets;
  }, [wrikeData]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per real-film campaign: completed vs still-active (backlog), from the task
  // cache. done = has a completed date; backlog = status "Active". Junk campaign
  // names are dropped by cross-checking projectName against the curated films.
  const campaigns = useMemo(() => {
    const per = new Map();
    for (const t of wrikeData) {
      const name = t.projectName;
      if (!name || name === "Unknown Project") continue;
      let rec = per.get(name);
      if (!rec) { rec = { done: 0, active: 0 }; per.set(name, rec); }
      if (t.completedDate) rec.done++;
      else if (t.status === "Active") rec.active++;
    }
    // Match either way — the campaign name contains a film title, or (for a
    // folder-shortened campaign) a film title contains the name. The reverse
    // match is length-guarded so short junk ("Film", "Edit") can't match.
    const isRealFilm = (name) => {
      const p = norm(name);
      if (p.length < 3) return false;
      return filmNorms.some((fn) => p.includes(fn) || (p.length >= 5 && fn.includes(p)));
    };
    const all = [...per.entries()]
      .filter(([name]) => isRealFilm(name))
      .map(([label, v]) => ({
        label,
        done: v.done,
        active: v.active,
        total: v.done + v.active,
        pct: v.done + v.active ? Math.round((v.done / (v.done + v.active)) * 100) : 0,
      }))
      .filter((r) => r.total > 0);
    return {
      top: [...all].sort((a, b) => b.total - a.total).slice(0, 12),
      inProduction: all.filter((r) => r.active > 0).length,
    };
  }, [wrikeData, filmNorms]); // eslint-disable-line react-hooks/exhaustive-deps

  const hoursByClient = useMemo(() => {
    const perClient = new Map();
    for (const r of logRows || []) {
      const client = r.client?.trim() || "Unassigned";
      const h = toHours(r.time_spent) + toHours(r.additional_time);
      if (h <= 0) continue;
      perClient.set(client, (perClient.get(client) || 0) + h);
    }
    return [...perClient.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
  }, [logRows]);

  const hoursByDept = useMemo(() => {
    const per = new Map();
    for (const r of logRows || []) {
      const dept = deptMap[r.wrike_user_id] || "Unassigned";
      const h = toHours(r.time_spent) + toHours(r.additional_time);
      if (h <= 0) continue;
      per.set(dept, (per.get(dept) || 0) + h);
    }
    return [...per.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);
  }, [logRows, deptMap]);

  // Logged hours per week, last 10 weeks (Monday-start buckets) — a crunch /
  // capacity read to sit alongside the monthly completed-tasks throughput.
  const weekly = useMemo(() => {
    const monday = (d) => {
      const x = new Date(d);
      x.setHours(0, 0, 0, 0);
      x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
      return x;
    };
    const weeks = [];
    const thisMon = monday(now);
    for (let i = 9; i >= 0; i--) {
      const start = new Date(thisMon);
      start.setDate(start.getDate() - i * 7);
      weeks.push({
        key: start.toISOString().slice(0, 10),
        label: start.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
        full: `Week of ${start.toLocaleDateString("en-GB", { day: "2-digit", month: "long" })}`,
        value: 0,
      });
    }
    const byKey = new Map(weeks.map((w) => [w.key, w]));
    for (const r of logRows || []) {
      const d = parseDdMmYyyy(r.date);
      if (!d) continue;
      const w = byKey.get(monday(d).toISOString().slice(0, 10));
      if (w) w.value += toHours(r.time_spent) + toHours(r.additional_time);
    }
    return weeks;
  }, [logRows]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!wrikeData.length) {
    return (
      <div className="flex items-center justify-center py-16 gap-3 text-[#768994]">
        <RefreshCw className="w-5 h-5 animate-spin text-[#12a0e1]" />
        <p className="text-sm font-bold">Waiting for the task cache to load…</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatTile icon={Activity} label="Active tasks" value={fmtInt(stats.active)} sub="Open across the whole studio, right now" />
        <StatTile icon={CheckCircle2} label="Completed this month" value={fmtInt(stats.completedThisMonth)} sub={now.toLocaleDateString("en-GB", { month: "long", year: "numeric" })} />
        <StatTile icon={Film} label="Films in production" value={fmtInt(campaigns.inProduction)} sub="Real films with active tasks" />
        <StatTile icon={Clock} label="Hours logged" value={logRows === null ? "…" : fmtHours(stats.hours30)} sub="Timesheets, last 30 days" />
      </div>

      {/* Campaign progress — the health hero: completed vs backlog per film. */}
      <ChartCard
        title="Campaign progress"
        subtitle="Completion by film, busiest first — counts are Wrike task tallies, a rough proxy for order volume, so read them as estimates"
        rows={campaigns.top.map((c) => ({ label: c.label, value: c.pct }))}
        valueFmt={(v) => `${v}%`}
      >
        {campaigns.top.length ? (
          <BarsProgress rows={campaigns.top} />
        ) : (
          <p className="text-xs text-[#768994] italic py-6 text-center">
            {filmNorms.length ? "No matching film campaigns in the cache." : "Loading the film list…"}
          </p>
        )}
      </ChartCard>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <ChartCard
          title="Tasks completed per month"
          subtitle="Studio throughput, last 12 months"
          rows={monthly.map((m) => ({ label: m.full, value: m.value }))}
          valueFmt={fmtInt}
        >
          <BarsMonthly rows={monthly} color={SERIES.blue} />
        </ChartCard>

        <ChartCard
          title="Hours logged per week"
          subtitle="Timesheet effort, last 10 weeks — a capacity read alongside output"
          rows={weekly.map((w) => ({ label: w.full, value: w.value }))}
          valueFmt={fmtHours}
        >
          <BarsMonthly rows={weekly} color={SERIES.violet} valueFmt={fmtHours} tipSuffix="logged" />
        </ChartCard>

        <ChartCard
          title="Hours by department"
          subtitle="Where the logged time goes across teams"
          rows={hoursByDept}
          valueFmt={fmtHours}
        >
          {hoursByDept.length ? (
            <BarsH rows={hoursByDept} color={SERIES.aqua} valueFmt={fmtHours} />
          ) : (
            <p className="text-xs text-[#768994] italic py-6 text-center">
              {logRows === null ? "Loading timesheet data…" : "No hours logged yet."}
            </p>
          )}
        </ChartCard>

        <ChartCard
          title="Hours logged by client"
          subtitle="From the new timesheets — young data (started July 2026), grows as the team logs time"
          rows={hoursByClient}
          valueFmt={fmtHours}
        >
          {hoursByClient.length ? (
            <BarsH rows={hoursByClient} color={SERIES.amber} valueFmt={fmtHours} />
          ) : (
            <p className="text-xs text-[#768994] italic py-6 text-center">
              {logRows === null ? "Loading timesheet data…" : "No hours logged yet."}
            </p>
          )}
        </ChartCard>
      </div>
    </div>
  );
}
