// The form for adding or editing a job, its modal, and how the
// next job code is worked out.
//
// Part of Administration. Split out of components/Management.jsx, which is
// still the entry point and re-exports what other screens import.
import { useState, useEffect, useMemo } from "react";
import { Check, RefreshCw, ChevronRight, X } from "lucide-react";
import { selectAll } from "../../lib/supabaseClient";
import DateField from "../shared/DateField";
import { JOB_STATUSES } from "./constants";
import { ComboField, FieldLabel, MODAL_INPUT, PillField } from "./fields";

const OFFICES = ["LDN", "LA"];
const PRINT_DIGITAL = ["Digital", "Print", "Both"];
// ── Combobox grouping helpers ─────────────────────────────────────────────────
// Filtering used to live in loud gradient chips above each field, which clashed
// with the form. Instead we fold it into the dropdown: options group under
// sticky headers (same idiom as Tracker/Legacy's SearchableSelect), so scanning
// by territory/studio/type is a property of the list, not extra chrome.
// Project descriptions lead with a territory token but separate it with a SPACE
// as often as a dash ("UK Titles", "AUS - DOOH", "XYi Internal"), so split on the
// leading token itself rather than a fixed " - " delimiter.
const DESC_PREFIXES = ["AUS", "UK", "DOM", "INT", "IRE", "XYi"];
const descGroup = (s) => {
  for (const p of DESC_PREFIXES) if (new RegExp(`^${p}[\\s\\-]`, "i").test(s)) return p;
  return "Other";
};
const descLabel = (s) => {
  for (const p of DESC_PREFIXES) {
    const m = s.match(new RegExp(`^${p}[\\s\\-]+`, "i"));
    if (m) return s.slice(m[0].length);
  }
  return s;
};
const STUDIO_KEYS = ["Universal", "Paramount", "Sony", "Disney", "Warner"];
const studioGroup = (s) => {
  const u = s.toLowerCase();
  for (const k of STUDIO_KEYS) if (u.includes(k.toLowerCase())) return k;
  return u.includes("xyi") ? "XYi" : "Other";
};
// Group orders double as the dropdown's quick-filter chips — most-used buckets
// first so the common picks (Universal/Paramount, Digital/Print) are one tap in.
const CLIENT_GROUP_ORDER = ["Universal", "Paramount", "Sony", "Disney", "Warner", "XYi"];
// Exactly the two busiest desks per studio — "<Studio> Pictures International"
// then "…UK" — floated to the top of their group. Anchored to the end so
// "NBCUniversal International Ltd" and "Universal Pictures BAFTA - UK" don't match.
const CLIENT_PIN_RANK = (name) => {
  if (/ Pictures International$/i.test(name)) return 0;
  if (/ Pictures UK$/i.test(name) || /^Paramount UK$/i.test(name)) return 1;
  return 999;
};
const DESC_GROUP_ORDER = ["AUS", "UK", "DOM", "INT", "IRE", "XYi"];
const PD_COLOR_MAP = { Digital: "bg-cyan-600 border-cyan-600", Print: "bg-orange-500 border-orange-500", Both: "bg-violet-600 border-violet-600" };
const STATUS_COLOR_MAP = { Inactive: "bg-slate-400 border-slate-400", Active: "bg-[#12a0e1] border-[#12a0e1]", Closed: "bg-[#1cc1a5] border-[#1cc1a5]" };
// Allocate the next sequential XY code. selectAll is essential here, not just
// tidier: this scans for the HIGHEST code in use, and a truncated read returns a
// max that's thousands too low — every allocation then collides with an existing
// job number. Reads jobs AND tasks, since either can carry the newest code.
export async function nextJobCode() {
  const [jobRows, taskRows] = await Promise.all([
    selectAll("jobs", "job_number"),
    selectAll("tasks", "job_number"),
  ]);
  let maxNum = 0;
  [...jobRows, ...taskRows].forEach(r => {
    const m = (r.job_number || "").match(/XY(\d+)/);
    if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
  });
  return `XY${String(maxNum + 1).padStart(6, "0")}`;
}
// ── Job Form ───────────────────────────────────────────────────────────────────
// Fields + footer for creating/editing a Job Book row. Shared by JobModal (edit,
// from Job Book) and the Custom Job tab in Jobs Setup (create) — same form,
// different chrome around it (layout="modal" adds the fixed-footer/scroll
// behaviour a popup needs; layout="inline" just flows in the page).
export function JobForm({ job, clients, films, workCategories, descs, onSave, onCancel, saving, submitLabel, layout = "modal", presetCode = null }) {
  const isEdit = !!job?.id;
  const [orderedByOpts, setOrderedByOpts] = useState([]);
  const [billedToOpts, setBilledToOpts]   = useState([]);
  // e.g. "XY025999" — allocated once when creating a new job. The Bulk Campaign
  // flow allocates it up front (so the folder preview can show the code the job
  // will get) and passes it in; standalone creation allocates its own below.
  const [nextCode, setNextCode] = useState(presetCode);

  useEffect(() => {
    // Whole table: a truncated read silently drops whole clients from these
    // pickers, which reads as "that option doesn't exist".
    selectAll("jobs", "ordered_by, billed_to", (q) =>
      q.not("ordered_by", "is", null).neq("ordered_by", "")
    ).then((data) => {
      setOrderedByOpts([...new Set(data.map(r => r.ordered_by).filter(Boolean))].sort());
      setBilledToOpts([...new Set(data.map(r => r.billed_to).filter(Boolean))].sort());
    });
  }, []);

  // New jobs get the next sequential XY code auto-allocated, same source of truth
  // (max across jobs + tasks) as the Bulk Campaign flow — never manually typed.
  useEffect(() => {
    if (isEdit || presetCode) return;
    nextJobCode().then(setNextCode);
  }, [isEdit, presetCode]);

  const [form, setForm] = useState({
    job_number: job?.job_number || "",
    start_date: job?.start_date ? job.start_date.slice(0, 10) : new Date().toISOString().slice(0, 10),
    client: job?.client || "",
    film_title: job?.film_title || "",
    office: job?.office || "LDN",
    print_digital: job?.print_digital || "Digital",
    project_description: job?.project_description || "",
    job_work_category: job?.job_work_category || "",
    ordered_by: job?.ordered_by || "",
    billed_to: job?.billed_to || "",
    fixed_cost: job?.fixed_cost ?? "",
    third_party_cost: job?.third_party_cost ?? "",
    estimated_cost: job?.estimated_cost ?? "",
    completed_date: job?.completed_date ? job.completed_date.slice(0, 10) : "",
    job_done: job?.job_done || false,
    status: job?.status || (isEdit ? "Inactive" : "Active"),
    notes: job?.notes || "",
  });

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  // Open from the start, creating or editing: the billing fields are filled in
  // at creation often enough that hiding them behind a disclosure just adds a
  // click. Still collapsible.
  const [showAdmin, setShowAdmin] = useState(true);
  const bodyClass = layout === "modal" ? "overflow-y-auto flex-1 px-6 py-5 space-y-6" : "space-y-6";
  const footerClass = layout === "modal"
    ? "px-6 py-4 border-t border-[#dce4ec] flex items-center justify-end gap-2 shrink-0"
    : "mt-3 pt-6 border-t border-[#dce4ec] flex items-center justify-end gap-2";

  // Live preview: "Film Title : XY025999, Project Description" — updates as you type
  const livePreview = useMemo(() => {
    if (!nextCode) return "";
    const film = form.film_title.trim();
    const desc = form.project_description.trim();
    let s = film ? `${film} : ${nextCode}` : nextCode;
    if (desc) s += `, ${desc}`;
    return s;
  }, [nextCode, form.film_title, form.project_description]);

  const canSave = isEdit
    ? form.job_number.trim() && form.client && form.start_date
    : nextCode && form.client && form.start_date;

  const handleSave = () => onSave(isEdit ? form : { ...form, job_number: livePreview });

  return (
    <>
      <div className={bodyClass}>
        {/* Hero — the assembling job label is the one thing this form exists to
            produce, so it leads instead of sitting muted at the top. */}
        <div>
          <FieldLabel text="Job Number" required />
          {isEdit ? (
            <input value={form.job_number} onChange={e => set("job_number", e.target.value)}
              placeholder="e.g. The Odyssey : XY025999, Finishing"
              className={`${MODAL_INPUT} font-mono`} />
          ) : (
            <>
              <div className="bg-[#f4faf8] border border-[#d5ebe4] rounded-2xl px-4 py-3.5 min-h-[54px] flex items-center flex-wrap gap-x-1.5 gap-y-1 leading-snug">
                <span className={`text-base font-bold ${form.film_title.trim() ? "text-[#122027]" : "text-[#b0bec5]"}`}>
                  {form.film_title.trim() || "Film title"}
                </span>
                <span className="text-[#b0bec5] font-bold">:</span>
                <span className="font-mono text-sm font-bold text-[#0f766e] bg-[#dcf3ec] px-2 py-0.5 rounded-md">
                  {nextCode || "XY…"}
                </span>
                <span className="text-[#b0bec5] font-bold">,</span>
                <span className={`text-sm font-medium ${form.project_description.trim() ? "text-[#33454f]" : "text-[#b0bec5]"}`}>
                  {form.project_description.trim() || "project description"}
                </span>
              </div>
              <p className="text-[10px] text-[#768994] mt-1.5">
                Auto-allocated — the label builds itself from the film and project description below.
              </p>
            </>
          )}
        </div>

        {/* Essentials — film, client, description, category, start date compose
            the label above and are the minimum to file the job. */}
        <div className="grid grid-cols-2 gap-5">
          <ComboField label="Film Title" value={form.film_title} onChange={v => set("film_title", v)}
            options={films} placeholder="Search films, or type something else (e.g. Studio Management)…" />
          <ComboField label="Client" required value={form.client} onChange={v => set("client", v)}
            options={clients} placeholder="Search clients…"
            groupBy={studioGroup} groupOrder={CLIENT_GROUP_ORDER} pinRankFn={CLIENT_PIN_RANK} />
        </div>

        <ComboField label="Project Description" value={form.project_description}
          onChange={v => set("project_description", v)}
          options={descs} placeholder="Search descriptions or type a new one…"
          groupBy={descGroup} formatOption={descLabel} groupOrder={DESC_GROUP_ORDER} />

        <div className="grid grid-cols-2 gap-5">
          {/* Job Work Category — the job-level taxonomy (AUS - Publicity, …).
              NOT the Item Categories list (Digital - Retouching, …), which is
              picked per timesheet line; this field was wrongly pointed at that
              one. Territory-prefixed like project descriptions, so it groups
              the same way. */}
          <ComboField label="Job Work Category" value={form.job_work_category}
            onChange={v => set("job_work_category", v)}
            options={workCategories} placeholder="Search job work categories…"
            groupBy={descGroup} formatOption={descLabel} groupOrder={DESC_GROUP_ORDER} />
          <div>
            <FieldLabel text="Start Date" required />
            <DateField value={form.start_date} onChange={v => set("start_date", v)} allowClear={false} placeholder="Pick a start date…" />
          </div>
        </div>

        {/* Billing & admin — everything optional at creation, one disclosure. */}
        <div className="border border-[#dce4ec] rounded-2xl overflow-hidden">
          <button type="button" onClick={() => setShowAdmin(s => !s)}
            className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-[#fbfdff] hover:bg-slate-50 transition-colors">
            <span className="flex items-center gap-2.5 min-w-0">
              <ChevronRight className={`w-4 h-4 text-[#768994] shrink-0 transition-transform ${showAdmin ? "rotate-90" : ""}`} />
              <span className="text-xs font-bold text-[#33454f]">Billing &amp; admin</span>
              {!showAdmin && (
                <span className="hidden sm:inline text-[10px] font-bold text-[#768994] bg-slate-100 px-2 py-0.5 rounded-full truncate">
                  Office · Print/Digital · Ordered by · Costs · Notes
                </span>
              )}
            </span>
            <span className="text-[11px] font-bold text-[#0d9488] shrink-0">Optional</span>
          </button>
          {showAdmin && (
            <div className="px-4 py-5 space-y-6 border-t border-[#dce4ec]">
              <div className="grid grid-cols-2 gap-5">
                <PillField label="Office" value={form.office} onChange={v => set("office", v)} options={OFFICES} />
                <PillField label="Print / Digital" value={form.print_digital} onChange={v => set("print_digital", v)}
                  options={PRINT_DIGITAL} colorMap={PD_COLOR_MAP} />
              </div>

              <div className="grid grid-cols-2 gap-5">
                <ComboField label="Ordered By" value={form.ordered_by} onChange={v => set("ordered_by", v)}
                  options={orderedByOpts} placeholder="Name or type new…" />
                <ComboField label="Billed To" value={form.billed_to} onChange={v => set("billed_to", v)}
                  options={billedToOpts} placeholder="Company or name…" />
              </div>

              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-[#768994] mb-3">Costs</p>
                <div className="grid grid-cols-3 gap-4">
                  {[["Fixed", "fixed_cost"], ["3rd Party", "third_party_cost"], ["Estimated", "estimated_cost"]].map(([lbl, field]) => (
                    <div key={field}>
                      <FieldLabel text={lbl} />
                      <div className="relative">
                        <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#768994] text-sm font-bold select-none">£</span>
                        <input type="number" step="0.01" min="0" value={form[field]}
                          onChange={e => set(field, e.target.value)} placeholder="0.00"
                          className={`${MODAL_INPUT} pl-8`} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <FieldLabel text="Notes" />
                <textarea value={form.notes} onChange={e => set("notes", e.target.value)}
                  rows={3} placeholder="Any additional notes…"
                  className={`${MODAL_INPUT} resize-none`} />
              </div>
            </div>
          )}
        </div>

        {/* Lifecycle — edit only. A job you're creating now is never "done", and
            its create-time Inactive/Active choice lives in the footer instead. */}
        {isEdit && (
          <div className="space-y-6">
            <PillField label="Status" value={form.status} onChange={v => set("status", v)}
              options={JOB_STATUSES} colorMap={STATUS_COLOR_MAP} />

            <div className="grid grid-cols-2 gap-5">
              <div>
                <FieldLabel text="Completed Date" />
                <DateField value={form.completed_date} onChange={v => set("completed_date", v)} placeholder="Not completed yet…" />
              </div>
              <div className="flex items-end">
                <button type="button" onClick={() => set("job_done", !form.job_done)}
                  className={`flex items-center gap-2.5 w-full px-4 py-2.5 rounded-xl border font-bold text-sm transition-[background-color,border-color,color] ease-[cubic-bezier(0.16,1,0.3,1)] ${
                    form.job_done
                      ? "bg-[#1cc1a5]/10 border-[#1cc1a5] text-[#1cc1a5]"
                      : "bg-white border-[#dce4ec] text-[#768994] hover:border-[#1cc1a5]/50"
                  }`}>
                  <div className={`w-5 h-5 rounded-lg border-2 flex items-center justify-center shrink-0 transition-colors ${
                    form.job_done ? "bg-[#1cc1a5] border-[#1cc1a5]" : "border-[#dce4ec]"
                  }`}>
                    {form.job_done && <Check className="w-3 h-3 text-white" />}
                  </div>
                  Job Done
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className={footerClass}>
        {/* Create-time status lives here, opposite the actions — present without
            re-cluttering the field stack. Closed only makes sense once editing. */}
        {!isEdit && (
          <div className="mr-auto">
            <p className="text-[9px] font-black uppercase tracking-widest text-[#768994] mb-1.5">Status</p>
            <div className="inline-flex border border-[#dce4ec] rounded-xl overflow-hidden">
              {["Inactive", "Active"].map(s => (
                <button key={s} type="button" onClick={() => set("status", s)}
                  className={`px-4 py-1.5 text-xs font-bold transition-colors ${
                    form.status === s ? "bg-[#10b981] text-white" : "bg-white text-[#768994] hover:text-[#122027]"
                  }`}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {onCancel && (
          <button onClick={onCancel}
            className="px-5 py-2.5 text-sm font-bold text-[#768994] hover:text-[#122027] bg-white border border-[#dce4ec] rounded-xl transition-[color] ease-[cubic-bezier(0.16,1,0.3,1)]">
            Cancel
          </button>
        )}
        <button onClick={handleSave} disabled={saving || !canSave}
          className={`flex items-center gap-2 px-6 py-2.5 text-white text-sm font-bold rounded-xl transition-[background-color] ease-[cubic-bezier(0.16,1,0.3,1)] disabled:opacity-50 shadow-sm ${
            isEdit ? "bg-[#12a0e1] hover:bg-[#0d8bc4]" : "bg-[#10b981] hover:bg-[#0d9488]"
          }`}>
          {saving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          {submitLabel || (isEdit ? "Save Changes" : "Create Job")}
        </button>
      </div>
    </>
  );
}
// ── Job Form Modal (edit only — creation now lives in Jobs Setup > Custom Job) ─
export function JobModal({ job, clients, films, workCategories, descs, onSave, onClose, saving }) {
  return (
    // onMouseDown instead of onClick: fires before blur, so the close is instant
    // and never races with a combobox dropdown's state updates.
    <div className="fixed inset-0 z-[9999] bg-[#122027]/60 backdrop-blur-sm flex items-center justify-center p-4"
      onMouseDown={onClose}>
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden border border-[#dce4ec]"
        onMouseDown={e => e.stopPropagation()}>

        <div className="px-6 pt-5 pb-4 border-b border-[#dce4ec] flex items-center justify-between shrink-0">
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest text-[#12a0e1] mb-0.5">Job Book</p>
            <h2 className="text-xl font-black text-[#122027]">Edit {job?.job_number}</h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-xl text-slate-400 hover:text-slate-600 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <JobForm job={job} clients={clients} films={films} workCategories={workCategories} descs={descs}
          onSave={onSave} onCancel={onClose} saving={saving} layout="modal" />
      </div>
    </div>
  );
}
