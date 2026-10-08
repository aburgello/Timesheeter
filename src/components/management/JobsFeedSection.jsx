// The jobs feed: everyone's timesheet rows by week, for operations.
// Also used by the PMs' Job Book page.
//
// Part of Administration. Split out of components/Management.jsx, which is
// still the entry point and re-exports what other screens import.
import { useState, useEffect, useCallback, useMemo } from "react";
import { Check, Search, Download, UploadCloud } from "lucide-react";
import { supabase, selectAll } from "../../lib/supabaseClient";
import { jobKey, bookFilmTitle } from "../../utils/wrikeHelpers";
import { parseTimeToHours, parseTimeToSeconds, secondsToHM } from "../../utils/timeHelpers";
import { useColumnResize } from "../../lib/useColumnResize";
import { toIsoDate } from "../../utils/dates";
import { fullName as cleanFullName } from "../../lib/formatName";
import { clientKey, formatMoney, hourlyRate, indexRates } from "../../lib/rateCards";
import { FeedSelect } from "./fields";
import { ImportModal } from "./ImportModal";

// ── Jobs Feed ─────────────────────────────────────────────────────────────────
// Exported: also rendered inside the PMs' standalone Job Book page (JobBook.jsx).
// ── Week helpers (ISO weeks, Monday-start) ───────────────────────────────────
// The feed is read week-by-week ("view by week"), so the period pickers are
// weeks rather than months. ISO week numbering matches the numbering the
// reports this view replaces already use.
const mondayOf = (d) => {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return m;
};
const isoWeekNo = (d) => {
  // Shift to the Thursday of the same week — the ISO rule that decides which
  // year (and therefore which week 1) a boundary week belongs to.
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
};
const isoDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// How far back the week pickers reach. 18 months covers the current and prior
// financial year, which is as far as anyone reads this feed back.
const WEEKS_BACK = 78;
// A task's job number and film both live inside the composed job label
// ("Forgotten Island : XY025164, INT - Titles"), which is authoritative — the
// task's own film_title column can lag a rename. Shared by the filters, the
// cells and the export so all three agree on what a row's film is.
const feedJobNo = (e) => {
  const s = e.job_number || "";
  // Everything between the film separator (when there is one) and the
  // description — a label can be "Film : XY1, Desc", "XY1, Desc" or bare "XY1".
  const colon = s.indexOf(" : ");
  const after = colon < 0 ? s : s.slice(colon + 3);
  const comma = after.indexOf(",");
  return (comma > 0 ? after.slice(0, comma) : after).trim();
};
//
// The Job Book outranks the label, though. The label is itself a snapshot from
// when the time was pulled, so a row saved as "Gmf : XY026245, Quotes Quad"
// went on saying Gmf after the book named the job George Michael The Faith
// Tour. _bookFilm is looked up by XY code in load() below.
const feedFilm = (e) => {
  if (e._bookFilm) return e._bookFilm;
  const colon = (e.job_number || "").indexOf(" : ");
  return colon > 0 ? e.job_number.slice(0, colon).trim() : (e.film_title || "");
};
// The description as it actually reads on the folder — the tail of the job
// label, after the code. The task's own project_description column is a copy
// taken when the time was logged and goes stale when a job is renamed, so the
// label wins and the column is only a fallback.
const feedDesc = (e) => {
  const s = e.job_number || "";
  const comma = s.indexOf(",", s.indexOf(" : ") + 1);
  const fromLabel = comma > 0 ? s.slice(comma + 1).trim() : "";
  return fromLabel || e.project_description || e._job?.project_description || "";
};
// Decimal hours from a stored duration — the shared parser, so this agrees
// with what the grid displays and with what the Tracker/Legacy pages compute.
// It used to read a bare integer as MINUTES, which mattered here more than
// anywhere: this feeds the rate × hours money column, so a "2" (two hours,
// which is what the 0.25-step dropdown writes) was billed as 0.03 hours.
const hoursOf = parseTimeToHours;
export function JobsFeedSection() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  // Period — a week range, defaulting to the current week at both ends.
  const [weekFrom, setWeekFrom] = useState("");
  const [weekTo, setWeekTo] = useState("");
  // The rest of the filter bar. "" means "all" for every one of these; the
  // legacy screen's unbilled-hours / billing-times / submitted-only controls
  // have no equivalent data in TimeHub (tasks carries no billed or submitted
  // flag), so they're deliberately absent rather than shown inert.
  const [jobNoFilter, setJobNoFilter] = useState("");
  const [clientFilter, setClientFilter] = useState("");
  const [deptFilter, setDeptFilter] = useState("");
  const [filmFilter, setFilmFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [staffFilter, setStaffFilter] = useState("");
  const [officeFilter, setOfficeFilter] = useState("");
  const [fixedCostFilter, setFixedCostFilter] = useState("Both"); // Both | Yes | No
  const [showImport, setShowImport] = useState(false);
  // Matches the report this replaces, which defaults to leaving unbilled time
  // (waiting time and anything else zero-rated) out of the totals.
  const [includeUnbilled, setIncludeUnbilled] = useState(false);

  // Filter dropdowns read the reference tables, not just the values that
  // happen to appear in the loaded rows — a client with no logged time yet is
  // still a client you'd want to filter to (and see the empty result).
  const [refLists, setRefLists] = useState({ clients: [], films: [], departments: [], categories: [] });
  useEffect(() => {
    Promise.all([
      supabase.from("clients").select("name").order("name"),
      supabase.from("films").select("title").order("title"),
      supabase.from("job_departments").select("name").order("name"),
      supabase.from("job_categories").select("name").order("name"),
    ]).then(([c, f, d, cat]) => setRefLists({
      clients: (c.data || []).map(x => x.name),
      films: (f.data || []).map(x => x.title),
      departments: (d.data || []).map(x => x.name),
      categories: (cat.data || []).map(x => x.name),
    }));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    // Read through the Worker's service-role endpoint, not supabase directly:
    // the tasks table has a per-user RLS policy, so a browser query would only
    // return the caller's own rows. This management feed must show everyone's.
    //
    // "date" is a text column with mixed historical formats (dd/mm/yyyy and
    // ISO), so filtering it at the DB level is unreliable (lexicographic string
    // compare). Fetch everything and filter by month client-side after
    // normalising to ISO.
    let allTasks = [];
    try {
      const res = await fetch("/api/jobs-feed");
      if (res.ok) allTasks = await res.json();
      else console.error("[JobsFeed] /api/jobs-feed failed", res.status);
    } catch (e) {
      console.error("[JobsFeed] /api/jobs-feed error", e);
    }

    // Everything is filtered client-side below — the endpoint returns the whole
    // table either way, so narrowing here would only mean refetching on every
    // filter change.
    const tasks = [...(allTasks || [])];

    // Sort by the job's actual date (not by row id / sync time) — id only
    // reflects when a row was pulled into the app, which can be well after
    // the work date it's tagged with. Rows without a parseable date fall
    // to the bottom; ties break by most-recently-synced first.
    tasks.sort((a, b) => {
      const da = a.work_date || toIsoDate(a.date) || "";
      const db = b.work_date || toIsoDate(b.date) || "";
      if (da !== db) return db.localeCompare(da);
      return (b.id || 0) - (a.id || 0);
    });

    if (!tasks?.length) { setEntries([]); setLoading(false); return; }

    const userIds = [...new Set(tasks.map(t => t.wrike_user_id).filter(Boolean))];
    const jobNums = [...new Set(tasks.map(t => t.job_number).filter(Boolean))];

    const [{ data: profiles }, { data: jobs }, { data: positions }, { data: cats }, { data: clients }, { data: clientRates }] = await Promise.all([
      userIds.length
        ? supabase.from("profiles").select("wrike_user_id, first_name, last_name, department, position_id").in("wrike_user_id", userIds)
        : Promise.resolve({ data: [] }),
      // The whole book, not just the exact labels in the feed: a row whose label
      // has drifted from the book's ("Gmf : XY026245, …" vs "George Michael The
      // Faith Tour : XY026245, …") still has to find its job, by code.
      jobNums.length
        ? selectAll("jobs", "id, job_number, film_title, client, office, print_digital, job_work_category, ordered_by, billed_to, fixed_cost")
            .then((data) => ({ data }))
        : Promise.resolve({ data: [] }),
      supabase.from("positions").select("id, rate_role_id"),
      supabase.from("job_categories").select("name, unbilled, rate_role_id"),
      supabase.from("clients").select("id, name, currency"),
      supabase.from("client_rates").select("client_id, rate_role_id, hourly_rate"),
    ]);

    const profileMap = Object.fromEntries((profiles || []).map(p => [p.wrike_user_id, p]));
    const jobMap = Object.fromEntries((jobs || []).map(j => [j.job_number, j]));
    // Same tie-break as useJobLookup: when a code has several rows, the one with
    // a film, a client and the canonical "Film : CODE" form wins, then lowest id.
    const jobScore = (j) => (j.film_title ? 1 : 0) + (j.client ? 1 : 0) + ((j.job_number || "").includes(" : ") ? 1 : 0);
    const jobByCode = {};
    for (const j of jobs || []) {
      if (!j.job_number) continue;
      const k = jobKey(j.job_number);
      const cur = jobByCode[k];
      if (!cur || jobScore(j) > jobScore(cur) || (jobScore(j) === jobScore(cur) && j.id < cur.id)) jobByCode[k] = j;
    }
    const roleByPosition = Object.fromEntries((positions || []).map(p => [p.id, p.rate_role_id]));
    const clientByName = Object.fromEntries((clients || []).map(c => [clientKey(c.name), c]));
    const cards = indexRates(clientRates);
    const catMap = Object.fromEntries((cats || []).map(c => [c.name, c]));

    setEntries(tasks.map(t => {
      const p = profileMap[t.wrike_user_id];
      const cat = catMap[t.category];
      const unbilled = !!cat?.unbilled;
      const job = jobMap[t.job_number] || (t.job_number && jobByCode[jobKey(t.job_number)]) || {};
      // Priced from the rate card of the client the row shows; see hourlyRate
      // for which line of it, and for when there's no price.
      const client = clientByName[clientKey(t.client || job.client)];
      return {
        ...t,
        _iso: t.work_date || toIsoDate(t.date),
        _name: p ? cleanFullName(p.first_name, p.last_name) : "—",
        _dept: p?.department || "",
        _unbilled: unbilled,
        _rate: hourlyRate({
          unbilled,
          categoryRoleId: cat?.rate_role_id,
          positionRoleId: roleByPosition[p?.position_id],
          card: client && cards.get(client.id),
        }),
        _currency: client?.currency || "USD",
        _job: job,
        _bookFilm: t.job_number ? bookFilmTitle(jobByCode[jobKey(t.job_number)]) : "",
      };
    }));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Every week from the current one back, newest first — the option set shared
  // by both period pickers.
  const weekOptions = useMemo(() => {
    const start = mondayOf(new Date());
    return Array.from({ length: WEEKS_BACK }, (_, i) => {
      const m = new Date(start);
      m.setDate(m.getDate() - i * 7);
      const end = new Date(m);
      end.setDate(end.getDate() + 6);
      return {
        key: isoDate(m),
        start: isoDate(m),
        end: isoDate(end),
        label: `${m.toLocaleDateString("en-GB", { month: "long", year: "numeric" })} (Week:${isoWeekNo(m)})`,
      };
    });
  }, []);

  // Default both ends to the current week once the options exist.
  useEffect(() => {
    if (!weekOptions.length) return;
    setWeekFrom(f => f || weekOptions[0].key);
    setWeekTo(t => t || weekOptions[0].key);
  }, [weekOptions]);

  // The picked range, normalised — picking an "until" week earlier than the
  // "view" week reads as a range either way rather than showing nothing.
  const range = useMemo(() => {
    const a = weekOptions.find(w => w.key === weekFrom);
    const b = weekOptions.find(w => w.key === weekTo);
    if (!a || !b) return null;
    return a.start <= b.start ? { from: a.start, to: b.end } : { from: b.start, to: a.end };
  }, [weekOptions, weekFrom, weekTo]);

  // Values present in the feed, for the two dropdowns with no reference table
  // of their own (Staff and Office).
  const optionsFor = useCallback((pick) => {
    const seen = new Set();
    entries.forEach(e => { const v = pick(e); if (v) seen.add(v); });
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [entries]);

  const staffOptions = useMemo(() => optionsFor(e => (e._name === "—" ? "" : e._name)), [optionsFor]);
  const officeOptions = useMemo(() => optionsFor(e => e._job?.office), [optionsFor]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const jobQ = jobNoFilter.trim().toLowerCase();
    return entries.filter(e => {
      // Rows with an unparseable date can't be placed in a week, so a week
      // range excludes them rather than silently dragging them along.
      if (range && !(e._iso && e._iso >= range.from && e._iso <= range.to)) return false;
      if (!includeUnbilled && e._unbilled) return false;
      if (jobQ && !feedJobNo(e).toLowerCase().includes(jobQ)) return false;
      if (clientFilter && e.client !== clientFilter) return false;
      if (deptFilter && e._dept !== deptFilter) return false;
      if (filmFilter && feedFilm(e) !== filmFilter) return false;
      if (categoryFilter && e.category !== categoryFilter) return false;
      if (staffFilter && e._name !== staffFilter) return false;
      if (officeFilter && (e._job?.office || "") !== officeFilter) return false;
      if (fixedCostFilter !== "Both") {
        const hasFixed = e._job?.fixed_cost != null && Number(e._job.fixed_cost) > 0;
        if (fixedCostFilter === "Yes" ? !hasFixed : hasFixed) return false;
      }
      if (q && !(
        (e.job_number || "").toLowerCase().includes(q) ||
        (e.client || "").toLowerCase().includes(q) ||
        feedFilm(e).toLowerCase().includes(q) ||
        (e._name || "").toLowerCase().includes(q) ||
        (e.project_description || "").toLowerCase().includes(q)
      )) return false;
      return true;
    });
  }, [entries, search, range, includeUnbilled, jobNoFilter, clientFilter, deptFilter,
      filmFilter, categoryFilter, staffFilter, officeFilter, fixedCostFilter]);

  const fmtDate = (d) => {
    if (!d) return "—";
    try {
      // ISO "2026-06-29" → "29.06.26"
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        const [y, m, day] = d.split("-");
        return `${day}.${m}.${y.slice(2)}`;
      }
      // Legacy "dd/mm/yyyy" → "29.06.26"
      const slash = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (slash) return `${slash[1]}.${slash[2]}.${slash[3].slice(2)}`;
      return d;
    } catch { return d; }
  };
  // Any stored shape → "H:MM", via the shared parser/formatter so this column
  // can't disagree with the same row on the Legacy or Tracker pages.
  const fmtNum = (n) => secondsToHM(parseTimeToSeconds(n), "—");

  const COLS = [
    { key: "job_number",          label: ["Job #"],                    px: 80  },
    { key: "date",                label: ["Date"],                     px: 64  },
    { key: "client",              label: ["Client"],                   px: 130 },
    { key: "office",              label: ["Off."],                     px: 38  },
    { key: "print_digital",       label: ["P/D"],                      px: 44  },
    { key: "film_title",          label: ["Film"],                     px: 120 },
    { key: "job_category",        label: ["Job", "Cat."],              px: 72  },
    { key: "project_description", label: ["Project", "Description"],   px: 140 },
    { key: "category",            label: ["Item", "Category"],         px: 140 },
    { key: "client_amends",       label: ["CA"],                       px: 30  },
    { key: "is_3d",               label: ["3D"],                       px: 28  },
    { key: "costs",               label: ["Costs"],                    px: 68  },
    { key: "ordered_by",          label: ["Ordered", "By"],            px: 100 },
    { key: "billed_to",           label: ["Billed", "To"],             px: 100 },
    { key: "worked_on",           label: ["Worked", "On By"],          px: 100 },
    { key: "hourly_rate",         label: ["Rate"],                     px: 56  },
    { key: "time_spent",          label: ["Time"],                     px: 44  },
    { key: "extra_time",          label: ["Extra"],                    px: 44  },
    { key: "over_time",           label: ["OT"],                       px: 38  },
    { key: "total",               label: ["Total"],                    px: 60  },
  ];

  const { widths, resizeHandle } = useColumnResize("mgmt-jobsfeed-cols", COLS);

  const getCellValue = (e, key) => {
    const j = e._job || {};
    switch (key) {
      case "job_number":          return feedJobNo(e) || "—";
      case "date":                return fmtDate(e.date);
      case "client":              return e.client || "—";
      case "office":              return j.office || "—";
      case "print_digital":       return j.print_digital || "—";
      case "film_title":          return feedFilm(e) || "—";
      case "job_category":        return j.job_work_category || "—";
      case "project_description": return feedDesc(e) || "—";
      case "category":            return e.category || "—";
      case "client_amends":       return e.client_amends ? <Check className="w-3.5 h-3.5 text-emerald-500 mx-auto" /> : "";
      case "is_3d":               return e.is_3d ? <Check className="w-3.5 h-3.5 text-emerald-500 mx-auto" /> : "";
      case "costs":               return j.fixed_cost != null ? `£${parseFloat(j.fixed_cost).toFixed(2)}` : "—";
      case "ordered_by":          return j.ordered_by || "—";
      case "billed_to":           return j.billed_to || "—";
      case "worked_on":           return e._name;
      case "hourly_rate":         return formatMoney(e._rate, e._currency);
      case "time_spent":          return fmtNum(e.time_spent);
      case "extra_time":          return fmtNum(e.additional_time);
      // No over-time column on tasks — nothing to read, so it's a constant
      // rather than a number that looks derived.
      case "over_time":           return "0.00";
      // Rate × every hour on the row (logged + additional). The rows this
      // replaces only ever carried logged time, so the two agree there.
      case "total": {
        const hrs = hoursOf(e.time_spent) + hoursOf(e.additional_time);
        return hrs > 0 && e._rate != null ? formatMoney(e._rate * hrs, e._currency) : "—";
      }
      default:                    return "—";
    }
  };

  // Text-only version of getCellValue for the export — the two boolean
  // columns render a checkmark icon on screen, which can't go in a CSV cell.
  const getCellText = (e, key) => {
    if (key === "client_amends") return e.client_amends ? "Yes" : "";
    if (key === "is_3d") return e.is_3d ? "Yes" : "";
    return getCellValue(e, key);
  };

  // Same CSV-Blob-and-click-a-link approach as the app's other export
  // (App.jsx's "Download CSV" palette action) — Excel opens CSV natively,
  // so there's no need for an xlsx-writing dependency just for this.
  // Exports whatever the filter bar is currently showing, not the full
  // unfiltered table.
  const exportToExcel = () => {
    const headers = COLS.map(c => c.label.join(" "));
    const rows = filtered.map(e => COLS.map(c => getCellText(e, c.key)));
    // Leading BOM — Excel doesn't sniff UTF-8 for a local CSV file without
    // one and falls back to Windows-1252, which mangles the em-dash
    // placeholder (and anything else non-ASCII) into "â€"".
    const csv = "\uFEFF" + [headers, ...rows]
      .map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const a = document.createElement("a");
    a.href = url;
    const scope = range ? `${range.from}_to_${range.to}` : "All";
    a.download = `ProjectTime_${scope}_${new Date().toISOString().split("T")[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Filter bar. Two rows, mirroring the report this replaces: the period
          on top, then the narrowing filters. Client / Dept / Film / Categories
          list their whole reference table, so a client with no logged time is
          still selectable (and honestly returns nothing); Staff and Office have
          no table of their own and list what's in the feed. "(All …)" clears. */}
      <div className="rounded-2xl border border-[#dce4ec] bg-[#fbfdff] px-4 py-3 flex flex-col gap-2.5">
        <div className="flex items-center gap-2 flex-wrap text-sm text-[#33454f]">
          <span className="font-bold text-[#122027]">View Week</span>
          <FeedSelect value={weekFrom} onChange={setWeekFrom} className="w-[215px]" allLabel={null}
            options={weekOptions.map(w => ({ value: w.key, label: w.label }))} />
          <span className="font-bold text-[#122027]">Until</span>
          <FeedSelect value={weekTo} onChange={setWeekTo} className="w-[215px]" allLabel={null}
            options={weekOptions.map(w => ({ value: w.key, label: w.label }))} />
          <span className="text-[#768994]">and</span>
          <FeedSelect value={includeUnbilled ? "Do" : "Do Not"} onChange={v => setIncludeUnbilled(v === "Do")}
            allLabel={null} className="w-[110px]"
            options={[{ value: "Do Not", label: "Do Not" }, { value: "Do", label: "Do" }]} />
          <span className="text-[#768994]">include unbilled hours.</span>
          <span className="text-[#768994]">Office is</span>
          <FeedSelect value={officeFilter} onChange={setOfficeFilter} allLabel="All Offices" className="w-[150px]"
            options={officeOptions.map(o => ({ value: o, label: o }))} />
        </div>

        <div className="flex items-center gap-2 flex-wrap text-sm text-[#33454f]">
          <label className="flex items-center gap-1.5">
            <span className="text-[#768994]">Job No:</span>
            <input value={jobNoFilter} onChange={e => setJobNoFilter(e.target.value)}
              placeholder="(All Jobs)"
              className="w-[120px] border border-[#dce4ec] rounded-xl px-3 py-2.5 text-sm font-bold text-[#122027] outline-none focus:border-[#12a0e1] hover:border-[#12a0e1] bg-white placeholder-[#b0bec5] placeholder:font-medium transition-colors" />
          </label>
          <span className="text-[#768994]">Client:</span>
          <FeedSelect value={clientFilter} onChange={setClientFilter} allLabel="(All Clients)" className="w-[200px]"
            options={refLists.clients.map(o => ({ value: o, label: o }))} />
          <span className="text-[#768994]">Dept:</span>
          <FeedSelect value={deptFilter} onChange={setDeptFilter} allLabel="(All Departments)" className="w-[185px]"
            options={refLists.departments.map(o => ({ value: o, label: o }))} />
          <span className="text-[#768994]">Film:</span>
          <FeedSelect value={filmFilter} onChange={setFilmFilter} allLabel="(All Films)" className="w-[200px]"
            options={refLists.films.map(o => ({ value: o, label: o }))} />
          <span className="text-[#768994]">Categories:</span>
          <FeedSelect value={categoryFilter} onChange={setCategoryFilter} allLabel="All Categories" className="w-[200px]"
            options={refLists.categories.map(o => ({ value: o, label: o }))} />
          <span className="text-[#768994]">Staff:</span>
          <FeedSelect value={staffFilter} onChange={setStaffFilter} allLabel="All Staff" className="w-[170px]"
            options={staffOptions.map(o => ({ value: o, label: o }))} />
          <span className="text-[#768994]">Fixed Cost:</span>
          <FeedSelect value={fixedCostFilter} onChange={setFixedCostFilter} allLabel={null} className="w-[100px]"
            options={[{ value: "Both", label: "Both" }, { value: "Yes", label: "Yes" }, { value: "No", label: "No" }]} />
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#b0bec5]" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search job, client, film, person…"
            className="w-full pl-9 pr-3 py-2 border border-[#dce4ec] rounded-xl text-sm text-[#122027] outline-none focus:border-[#1cc1a5] bg-white"
          />
        </div>
        <div className="flex items-center gap-3 ml-auto">
          <span className="text-xs font-bold text-[#768994]">
            {loading ? "Loading…" : `${filtered.length} entr${filtered.length === 1 ? "y" : "ies"}`}
          </span>
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-white border border-[#dce4ec] hover:border-[#1cc1a5] text-[#122027] text-xs font-bold rounded-xl transition-[border-color] ease-[cubic-bezier(0.16,1,0.3,1)]"
          >
            <UploadCloud className="w-3.5 h-3.5" />
            Import CSV
          </button>
          <button
            onClick={exportToExcel}
            disabled={loading || filtered.length === 0}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-white border border-[#dce4ec] hover:border-slate-300 text-[#122027] text-xs font-bold rounded-xl transition-[border-color] ease-[cubic-bezier(0.16,1,0.3,1)] disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            Export to Excel
          </button>
        </div>
      </div>

      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onImported={load}
        />
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-[#dce4ec] shadow-sm">
        <table className="border-collapse text-[11px] w-full" style={{ tableLayout: "fixed", minWidth: `${COLS.reduce((s, c) => s + widths[c.key], 0)}px` }}>
          <colgroup>
            {COLS.map(c => <col key={c.key} style={{ width: widths[c.key] }} />)}
          </colgroup>
          <thead>
            <tr>
              {COLS.map(c => (
                <th
                  key={c.key}
                  className="relative px-2 py-2.5 text-center font-black uppercase tracking-widest text-[9px] text-white bg-[#0d1b22] border-r border-white/5 last:border-r-0 whitespace-nowrap overflow-hidden"
                >
                  {Array.isArray(c.label) ? c.label.map((l, i) => <span key={i} className="block leading-tight">{l}</span>) : c.label}
                  {resizeHandle(c.key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={COLS.length} className="px-4 py-8 text-center text-[#768994]">Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={COLS.length} className="px-4 py-8 text-center text-[#768994]">No entries for this period</td></tr>
            ) : filtered.map((e, i) => (
              <tr key={e.id} className={`border-b border-[#f0f4f8] align-top ${i % 2 === 0 ? "bg-white" : "bg-[#f8fafc]"} hover:bg-[#edf5fb] transition-colors`}>
                {COLS.map(c => {
                  const val = getCellValue(e, c.key);
                  const isCheck = c.key === "client_amends" || c.key === "is_3d";
                  const isMono = ["time_spent", "extra_time", "over_time", "total", "hourly_rate", "costs"].includes(c.key);
                  const noWrap = ["date", "office", "print_digital", "client_amends", "is_3d", "time_spent", "extra_time", "over_time", "total", "hourly_rate", "costs"].includes(c.key);
                  return (
                    <td
                      key={c.key}
                      className={`px-2 py-1.5 border-r border-[#f0f4f8] last:border-r-0 overflow-hidden ${isCheck ? "text-center" : ""} ${isMono ? "font-mono text-[10px]" : ""} ${noWrap ? "whitespace-nowrap" : ""} text-[#122027]`}
                    >
                      <span className={`block leading-snug ${noWrap ? "truncate" : ""} ${c.key === "job_number" ? "font-black text-[#1cc1a5]" : "font-medium"}`}>
                        {val}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
