// The Job Book: every job, with filters, editing and the Studio
// Scan. Also used by the PMs' Job Book page.
//
// Part of Administration. Split out of components/Management.jsx, which is
// still the entry point and re-exports what other screens import.
import { useState, useEffect, useCallback, useMemo } from "react";
import { Plus, Pencil, Trash2, Check, Search, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import { supabase, selectAll } from "../../lib/supabaseClient";
import { confirmAction } from "../../lib/confirm";
import { notify } from "../../lib/toast";
import { useColumnResize } from "../../lib/useColumnResize";
import { isoToday } from "../../utils/dates";
import { tokenMatch } from "../../utils/search";
import MonthPicker from "../shared/MonthPicker";
import { JOB_STATUSES } from "./constants";
import { JobModal } from "./JobForm";
import { StudioJobScanModal } from "./StudioJobScanModal";

const STATUS_BADGE = { Inactive: "bg-slate-100 text-slate-500", Active: "bg-[#12a0e1]/10 text-[#12a0e1]", Closed: "bg-[#1cc1a5]/10 text-[#1cc1a5]" };
// ── Job Book Section ───────────────────────────────────────────────────────────
// Exported: also rendered standalone as the PMs' "Job Book" page (JobBook.jsx).
export function JobBookSection({ setActiveTab }) {
  const JOBBOOK_COLS = [
    { key: "job_number",  label: "Job #",               px: 110 },
    { key: "date",        label: "Date",                px: 90  },
    { key: "client",      label: "Client",              px: 140 },
    { key: "office",      label: "Office",              px: 70  },
    { key: "pd",          label: "P/D",                 px: 60  },
    { key: "film",        label: "Film Title",          px: 160 },
    { key: "project",     label: "Project Description", px: 220 },
    { key: "costs",       label: "Costs",               px: 90  },
    { key: "ordered_by",  label: "Ordered By",          px: 120 },
    { key: "billed_to",   label: "Billed To",           px: 120 },
    { key: "status",      label: "Status",              px: 110 },
    { key: "done",        label: "Done",                px: 70  },
    { key: "actions",     label: "",                    px: 90  },
  ];
  const { widths: jbWidths, resizeHandle: jbHandle } = useColumnResize("mgmt-jobbook-cols", JOBBOOK_COLS);

  const [jobs, setJobs]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [search, setSearch]     = useState("");
  // Local, not UTC: toISOString() rolls back a day west of Greenwich, which on
  // the 1st of a month would default this filter to the previous month.
  const [monthFilter, setMonthFilter] = useState(() => isoToday().slice(0, 7));
  const [showModal, setShowModal] = useState(false);
  const [showScan, setShowScan] = useState(false);
  const [editJob, setEditJob]   = useState(null);
  const [saving, setSaving]     = useState(false);
  const [clients, setClients]   = useState([]);
  const [films, setFilms]       = useState([]);
  const [workCategories, setWorkCategories] = useState([]);
  const [descs, setDescs]       = useState([]);
  const [page, setPage]         = useState(0);
  const PER_PAGE = 50;

  // ── Bulk edit ────────────────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkField, setBulkField] = useState("client");
  const [bulkValue, setBulkValue] = useState("");
  const [bulkBusy, setBulkBusy]   = useState(false);

  const loadRef = useCallback(async () => {
    const [c, f, cat, d] = await Promise.all([
      supabase.from("clients").select("name").order("name"),
      supabase.from("films").select("title, created_at").order("created_at", { ascending: false }),
      supabase.from("job_work_categories").select("name").order("name"),
      supabase.from("project_descriptions").select("description").order("description"),
    ]);
    setClients((c.data || []).map(x => x.name));
    setFilms((f.data || []).map(x => x.title));
    setWorkCategories((cat.data || []).map(x => x.name));
    setDescs((d.data || []).map(x => x.description));
  }, []);

  const loadJobs = useCallback(async () => {
    setLoading(true);
    // The whole book — this table paginates client-side, so a 1000-row read
    // just made every page past the first one lie.
    const data = await selectAll("jobs", "*", (q) => {
      if (!monthFilter) return q;
      const start = monthFilter + "-01";
      const end = new Date(monthFilter + "-01");
      end.setMonth(end.getMonth() + 1);
      return q.gte("start_date", start).lt("start_date", end.toISOString().slice(0, 10));
    });
    // selectAll orders by id ascending (its pagination depends on it); the book
    // reads newest-first.
    setJobs(data.slice().reverse());
    setLoading(false);
  }, [monthFilter]);

  useEffect(() => { loadRef(); }, [loadRef]);
  useEffect(() => { loadJobs(); setPage(0); }, [loadJobs]);

  // Every word in the query has to appear somewhere across the job's fields, in
  // any order — so "Eben Titles" finds "Ebenezer : XY026043, INT - Teaser
  // Titles". Also searches the project description, which the old rule ignored.
  const filtered = useMemo(() =>
    jobs.filter(j => tokenMatch(search, j.job_number, j.client, j.film_title,
                                j.project_description, j.job_work_category)),
    [jobs, search]
  );

  const paginated = filtered.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
  const totalPages = Math.ceil(filtered.length / PER_PAGE);

  const handleSave = async (form) => {
    setSaving(true);
    const payload = {
      ...form,
      start_date: form.start_date || null,
      completed_date: form.completed_date || null,
      fixed_cost: form.fixed_cost === "" ? null : parseFloat(form.fixed_cost),
      third_party_cost: form.third_party_cost === "" ? null : parseFloat(form.third_party_cost),
      estimated_cost: form.estimated_cost === "" ? null : parseFloat(form.estimated_cost),
    };
    // supabase-js resolves rather than throws on a database error, so an
    // unchecked write here closed the modal and reported nothing while the row
    // was rejected. That already happened for a duplicate job number; with
    // jobs_job_code_key it also happens for a duplicate CODE under a different
    // label, which is exactly the case someone editing a job is most likely to
    // hit. Keep the modal open and say why.
    const { error } = editJob?.id
      ? await supabase.from("jobs").update(payload).eq("id", editJob.id)
      : await supabase.from("jobs").insert(payload);
    setSaving(false);
    if (error) {
      notify(
        error.code === "23505"
          ? `Job number “${form.job_number}” clashes with a job already in the book — the same XY code can only be filed once.`
          : "Couldn't save the job: " + error.message,
        "error"
      );
      return;
    }
    setShowModal(false); setEditJob(null);
    await loadJobs();
  };

  const toggleDone = async (job) => {
    await supabase.from("jobs").update({ job_done: !job.job_done }).eq("id", job.id);
    setJobs(prev => prev.map(j => j.id === job.id ? { ...j, job_done: !j.job_done } : j));
  };

  // Click cycles Inactive -> Active -> Closed -> Inactive, matching the workflow:
  // new jobs start Inactive, go Active once billing info is filled in, Closed when done.
  const cycleStatus = async (job) => {
    const next = JOB_STATUSES[(JOB_STATUSES.indexOf(job.status || "Inactive") + 1) % JOB_STATUSES.length];
    await supabase.from("jobs").update({ status: next }).eq("id", job.id);
    setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: next } : j));
  };

  const deleteJob = async (id) => {
    const ok = await confirmAction({
      title: "Delete this job?",
      message: "The job and its Job Book record will be removed. This can't be undone.",
      confirmLabel: "Delete job",
      danger: true,
    });
    if (!ok) return;
    await supabase.from("jobs").delete().eq("id", id);
    await loadJobs();
  };

  const formatCost = (j) => {
    if (j.fixed_cost) return `Fixed: $${parseFloat(j.fixed_cost).toLocaleString()}`;
    if (j.estimated_cost) return `Est: $${parseFloat(j.estimated_cost).toLocaleString()}`;
    if (j.third_party_cost) return `3P: $${parseFloat(j.third_party_cost).toLocaleString()}`;
    return "—";
  };

  // Columns that can be set across many rows at once. `type` drives the value
  // control; `list` supplies a datalist of existing values for free-text fields.
  const BULK_FIELDS = [
    { key: "client",              label: "Client",              type: "text",   list: clients },
    { key: "status",             label: "Status",              type: "select", opts: JOB_STATUSES },
    { key: "print_digital",       label: "Print / Digital",     type: "select", opts: ["Digital", "Print", "XYi"] },
    { key: "office",              label: "Office",              type: "text" },
    { key: "film_title",          label: "Film Title",          type: "text",   list: films },
    { key: "project_description", label: "Project Description", type: "text",   list: descs },
    { key: "ordered_by",          label: "Ordered By",          type: "text" },
    { key: "billed_to",           label: "Billed To",           type: "text" },
    { key: "start_date",          label: "Start Date",          type: "date" },
    { key: "job_done",            label: "Done",                type: "bool" },
  ];
  const activeBulkField = BULK_FIELDS.find((f) => f.key === bulkField) || BULK_FIELDS[0];

  // Selection is over the *filtered* set (across pages), so a search + "select
  // all" lets you retag a whole studio's worth of imported rows in one go.
  const filteredIds = useMemo(() => filtered.map((j) => j.id), [filtered]);
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => selectedIds.has(id));
  const toggleRow = (id) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const toggleAllFiltered = () =>
    setSelectedIds(allFilteredSelected ? new Set() : new Set(filteredIds));
  const clearSelection = () => setSelectedIds(new Set());

  const applyBulk = async () => {
    if (!selectedIds.size) return;
    let val;
    if (activeBulkField.type === "bool") val = bulkValue === "yes";
    else if (activeBulkField.type === "date") val = bulkValue || null;
    else val = bulkValue.trim() === "" ? null : bulkValue.trim();

    const ok = await confirmAction({
      title: `Set ${activeBulkField.label} on ${selectedIds.size} job${selectedIds.size === 1 ? "" : "s"}?`,
      message:
        val === null
          ? `This clears ${activeBulkField.label} on every selected row.`
          : `Every selected row's ${activeBulkField.label} becomes “${activeBulkField.type === "bool" ? (val ? "Done" : "Not done") : val}”.`,
      confirmLabel: "Apply to all",
    });
    if (!ok) return;

    setBulkBusy(true);
    const ids = [...selectedIds];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { error: err } = await supabase.from("jobs").update({ [bulkField]: val }).in("id", chunk);
      if (err) { setBulkBusy(false); await confirmAction({ title: "Bulk update failed", message: err.message, confirmLabel: "OK" }); return; }
    }
    setBulkBusy(false);
    clearSelection();
    setBulkValue("");
    await loadJobs();
  };

  const bulkDelete = async () => {
    if (!selectedIds.size) return;
    const n = selectedIds.size;
    const ok = await confirmAction({
      title: `Delete ${n} job${n === 1 ? "" : "s"}?`,
      message: `${n} Job Book row${n === 1 ? "" : "s"} will be permanently removed. This can't be undone. (Rescanning Wrike re-imports them.)`,
      confirmLabel: `Delete ${n}`,
      danger: true,
    });
    if (!ok) return;
    setBulkBusy(true);
    const ids = [...selectedIds];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { error: err } = await supabase.from("jobs").delete().in("id", chunk);
      if (err) { setBulkBusy(false); await confirmAction({ title: "Bulk delete failed", message: err.message, confirmLabel: "OK" }); return; }
    }
    setBulkBusy(false);
    clearSelection();
    await loadJobs();
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <MonthPicker value={monthFilter} onChange={setMonthFilter} />
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#768994]" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search — try “Eben Titles”…"
            className="w-full pl-9 pr-4 py-2 text-sm border border-[#dce4ec] rounded-xl outline-none focus:border-[#1cc1a5] bg-white"
          />
        </div>
        <button onClick={() => setShowScan(true)}
          className="flex items-center gap-1.5 px-4 py-2 bg-white border border-[#dce4ec] hover:border-[#1cc1a5] text-[#122027] text-sm font-bold rounded-xl transition-[border-color] ease-[cubic-bezier(0.16,1,0.3,1)] shrink-0">
          <RefreshCw className="w-4 h-4 text-[#1cc1a5]" /> Scan Wrike
        </button>
        <button onClick={() => setActiveTab?.("jobsSetup")}
          className="flex items-center gap-1.5 px-4 py-2 bg-[#1cc1a5] hover:bg-[#17a892] text-white text-sm font-bold rounded-xl transition-[background-color] ease-[cubic-bezier(0.16,1,0.3,1)] shrink-0">
          <Plus className="w-4 h-4" /> Add Jobs
        </button>
      </div>

      {showScan && (
        <StudioJobScanModal
          onClose={() => setShowScan(false)}
          onApplied={async () => { setShowScan(false); await loadJobs(); }}
        />
      )}

      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] font-black text-[#768994] uppercase tracking-widest">
          {filtered.length} jobs
        </p>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
              className="p-1 disabled:opacity-30 hover:bg-slate-100 rounded-lg">
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="text-xs font-bold text-[#768994]">{page + 1} / {totalPages}</span>
            <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page === totalPages - 1}
              className="p-1 disabled:opacity-30 hover:bg-slate-100 rounded-lg">
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {selectedIds.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 bg-[#1cc1a5]/[0.06] border border-[#1cc1a5]/30 rounded-2xl px-4 py-2.5">
          <span className="text-[11px] font-black text-[#1cc1a5]">{selectedIds.size} selected</span>
          <button onClick={clearSelection} className="text-[11px] font-bold text-[#768994] hover:text-rose-500">Clear</button>
          <span className="text-[11px] font-bold text-[#768994] ml-2">Set</span>
          <select value={bulkField} onChange={(e) => { setBulkField(e.target.value); setBulkValue(""); }}
            className="text-[12px] font-bold border border-[#dce4ec] rounded-lg px-2 py-1.5 bg-white outline-none focus:border-[#1cc1a5]">
            {BULK_FIELDS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
          <span className="text-[11px] font-bold text-[#768994]">to</span>
          {activeBulkField.type === "select" ? (
            <select value={bulkValue} onChange={(e) => setBulkValue(e.target.value)}
              className="text-[12px] font-bold border border-[#dce4ec] rounded-lg px-2 py-1.5 bg-white outline-none focus:border-[#1cc1a5] min-w-[120px]">
              <option value="">— (clear)</option>
              {activeBulkField.opts.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : activeBulkField.type === "bool" ? (
            <select value={bulkValue} onChange={(e) => setBulkValue(e.target.value)}
              className="text-[12px] font-bold border border-[#dce4ec] rounded-lg px-2 py-1.5 bg-white outline-none focus:border-[#1cc1a5]">
              <option value="">—</option>
              <option value="yes">Done</option>
              <option value="no">Not done</option>
            </select>
          ) : activeBulkField.type === "date" ? (
            <input type="date" value={bulkValue} onChange={(e) => setBulkValue(e.target.value)}
              className="text-[12px] font-bold border border-[#dce4ec] rounded-lg px-2 py-1.5 bg-white outline-none focus:border-[#1cc1a5]" />
          ) : (
            <>
              <input list={`bulk-${activeBulkField.key}`} value={bulkValue} onChange={(e) => setBulkValue(e.target.value)}
                placeholder="value (blank = clear)"
                className="text-[12px] font-medium border border-[#dce4ec] rounded-lg px-2.5 py-1.5 bg-white outline-none focus:border-[#1cc1a5] min-w-[180px]" />
              {activeBulkField.list && (
                <datalist id={`bulk-${activeBulkField.key}`}>
                  {activeBulkField.list.map(v => <option key={v} value={v} />)}
                </datalist>
              )}
            </>
          )}
          <button onClick={applyBulk} disabled={bulkBusy}
            className="ml-auto flex items-center gap-1.5 px-4 py-1.5 bg-[#1cc1a5] hover:bg-[#17a892] disabled:bg-slate-200 disabled:text-slate-400 text-white text-[12px] font-bold rounded-lg transition-[background-color] ease-[cubic-bezier(0.16,1,0.3,1)]">
            {bulkBusy ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Applying…</> : `Apply to ${selectedIds.size}`}
          </button>
          <button onClick={bulkDelete} disabled={bulkBusy} title="Delete selected rows"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-rose-200 hover:bg-rose-50 hover:border-rose-300 disabled:opacity-40 text-rose-600 text-[12px] font-bold rounded-lg transition-[background-color,border-color] ease-[cubic-bezier(0.16,1,0.3,1)]">
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16 gap-2 text-[#768994]">
          <RefreshCw className="w-4 h-4 animate-spin" /> Loading jobs…
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-[#dce4ec]">
          <table className="w-full text-xs [&_td]:overflow-hidden" style={{ tableLayout: "fixed", minWidth: `${JOBBOOK_COLS.reduce((s, c) => s + jbWidths[c.key], 0)}px` }}>
            <colgroup>
              {JOBBOOK_COLS.map(c => <col key={c.key} style={{ width: jbWidths[c.key] }} />)}
            </colgroup>
            <thead>
              <tr className="bg-[#0d1b22] border-b border-white/10">
                {JOBBOOK_COLS.map(c => (
                  <th key={c.key} className="relative px-3 py-2.5 text-left text-[9px] font-black uppercase tracking-widest text-white border-r border-white/5 last:border-r-0 whitespace-nowrap overflow-hidden">
                    {c.key === "job_number" ? (
                      <span className="flex items-center gap-2">
                        <input type="checkbox" checked={allFilteredSelected} onChange={toggleAllFiltered}
                          title="Select all filtered" className="accent-[#1cc1a5]" />
                        {c.label}
                      </span>
                    ) : c.label}
                    {jbHandle(c.key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paginated.length === 0 ? (
                <tr><td colSpan={JOBBOOK_COLS.length} className="text-center py-12 text-[#768994] italic">No jobs found</td></tr>
              ) : paginated.map(j => (
                <tr key={j.id} className={`border-b border-[#dce4ec] last:border-0 transition-colors ${selectedIds.has(j.id) ? "bg-[#1cc1a5]/5" : "hover:bg-slate-50/50"} ${j.job_done ? "opacity-50" : ""}`}>
                  <td className="px-3 py-2.5">
                    <span className="flex items-start gap-2">
                      <input type="checkbox" checked={selectedIds.has(j.id)} onChange={() => toggleRow(j.id)} className="accent-[#1cc1a5] mt-0.5 shrink-0" />
                      <span className="font-black text-[#1cc1a5] font-mono">{j.job_number}</span>
                    </span>
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-[#768994]">
                    {j.start_date ? new Date(j.start_date).toLocaleDateString("en-GB", { day:"2-digit", month:"short", year:"2-digit" }) : "—"}
                  </td>
                  <td className="px-3 py-2.5 max-w-[120px] truncate font-medium text-[#122027]">{j.client || "—"}</td>
                  <td className="px-3 py-2.5">
                    <span className="text-[9px] font-black bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">{j.office || "—"}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`text-[9px] font-black px-1.5 py-0.5 rounded ${j.print_digital === "Digital" ? "bg-cyan-100 text-cyan-700" : j.print_digital === "Print" ? "bg-orange-100 text-orange-700" : "bg-purple-100 text-purple-700"}`}>
                      {j.print_digital || "—"}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 max-w-[100px] truncate italic text-[#768994]">{j.film_title || "—"}</td>
                  <td className="px-3 py-2.5 max-w-[160px] truncate text-[#122027]">{j.project_description || "—"}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap font-bold text-[#122027]">{formatCost(j)}</td>
                  <td className="px-3 py-2.5 text-[#768994]">{j.ordered_by || "—"}</td>
                  <td className="px-3 py-2.5 text-[#768994]">{j.billed_to || "—"}</td>
                  <td className="px-3 py-2.5">
                    <button onClick={() => cycleStatus(j)} title="Click to change status"
                      className={`text-[9px] font-black px-2 py-1 rounded-full transition-colors ${STATUS_BADGE[j.status || "Inactive"]}`}>
                      {j.status || "Inactive"}
                    </button>
                  </td>
                  <td className="px-3 py-2.5">
                    <button onClick={() => toggleDone(j)} title="Toggle done">
                      <div className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-colors ${j.job_done ? "bg-[#1cc1a5] border-[#1cc1a5]" : "border-[#dce4ec] hover:border-[#1cc1a5]"}`}>
                        {j.job_done && <Check className="w-2.5 h-2.5 text-white" />}
                      </div>
                    </button>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1">
                      <button onClick={() => { setEditJob(j); setShowModal(true); }}
                        className="p-1 hover:bg-slate-200 rounded-lg text-slate-400 hover:text-[#122027] transition-colors">
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button onClick={() => deleteJob(j.id)}
                        className="p-1 hover:bg-rose-100 rounded-lg text-slate-400 hover:text-rose-600 transition-colors">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <JobModal
          job={editJob}
          clients={clients} films={films} workCategories={workCategories} descs={descs}
          onSave={handleSave} onClose={() => { setShowModal(false); setEditJob(null); }}
          saving={saving}
        />
      )}
    </div>
  );
}
