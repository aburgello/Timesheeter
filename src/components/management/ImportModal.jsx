// Importing historical time into the jobs feed from a CSV, with a
// dry run to review before anything is written.
//
// Part of Administration. Split out of components/Management.jsx, which is
// still the entry point and re-exports what other screens import.
import { useState } from "react";
import { Check, AlertTriangle, CheckCircle2, Loader2, UploadCloud } from "lucide-react";
import { parseCsv, mapCsvRows } from "../../utils/csv";
import { WrikeApplyShell } from "./WrikeApplyShell";

// Header names the importer accepts, per field. The first alias in each list
// is what the feed's own export writes (COLS labels joined), so a file exported
// from this screen re-imports unchanged; the rest are the spellings a
// hand-built spreadsheet tends to use.
const IMPORT_HEADERS = {
  job_number:          ["Job #", "Job Number", "Job No"],
  date:                ["Date"],
  client:              ["Client"],
  office:              ["Off.", "Office"],
  print_digital:       ["P/D", "Print/Digital", "Print Digital"],
  film_title:          ["Film", "Film Title"],
  job_category:        ["Job Cat.", "Job Category", "Job Work Category"],
  project_description: ["Project Description"],
  category:            ["Item Category", "Category"],
  client_amends:       ["CA", "Client Amends"],
  is_3d:               ["3D"],
  costs:               ["Costs", "Fixed Cost"],
  ordered_by:          ["Ordered By"],
  billed_to:           ["Billed To"],
  worked_on:           ["Worked On By", "Worked On", "Staff"],
  time_spent:          ["Time", "Time Spent"],
  additional_time:     ["Extra", "Extra Time", "Additional Time"],
};
// Rate, OT and Total are exported but never imported — they're derived from
// positions and the row's own hours, so reading them back in would let a stale
// file overwrite a live calculation.
const IMPORT_IGNORED = ["Rate", "Hourly Rate", "OT", "Over Time", "Total"];
// CSV import for the feed. Pick a file → it's parsed in the browser and sent
// to the Worker for a dry run → the plan comes back and is shown in full →
// only then does confirming write anything. Nothing is inserted from the
// browser directly: `tasks` is per-user RLS'd, so a team-wide import has to go
// through the service-role endpoint.
export function ImportModal({ onClose, onImported }) {
  const [fileName, setFileName] = useState("");
  const [parseError, setParseError] = useState(null);
  const [unmatchedHeaders, setUnmatchedHeaders] = useState([]);
  const [rows, setRows] = useState(null);
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState(null);
  const [done, setDone] = useState(null);

  const post = async (payload) => {
    const res = await fetch("/api/jobs-feed/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        body.error === "not_connected" ? "Wrike session expired — reconnect in Profile → Settings."
        : body.error === "too_many_rows" ? `That file has more rows than the ${body.max}-row limit.`
        : body.detail || body.error || `Import failed (${res.status})`
      );
    }
    return body;
  };

  const handleFile = async (file) => {
    if (!file) return;
    setFileName(file.name);
    setParseError(null); setPlan(null); setRows(null); setApplyError(null);
    try {
      const grid = parseCsv(await file.text());
      const { rows: mapped, unmatched } = mapCsvRows(grid, IMPORT_HEADERS);
      if (!mapped.length) throw new Error("No data rows under the header.");
      // Rate/OT/Total are expected to be there and expected to be ignored —
      // listing them as unrecognised would read as a problem.
      const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      const ignored = new Set(IMPORT_IGNORED.map(norm));
      setUnmatchedHeaders(unmatched.filter((h) => !ignored.has(norm(h))));
      setRows(mapped);
      setBusy(true);
      setPlan((await post({ rows: mapped, dryRun: true })).plan);
    } catch (e) {
      setParseError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!rows || busy) return;
    setBusy(true); setApplyError(null);
    try {
      const res = await post({ rows, dryRun: false });
      setDone(res.plan);
      onImported?.();
    } catch (e) {
      setApplyError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const Stat = ({ n, label, tone = "" }) => (
    <div className="flex-1 min-w-[110px] px-3 py-2.5 rounded-xl border border-[#dce4ec] bg-white">
      <p className={`text-lg font-black leading-none ${tone || "text-[#122027]"}`}>{n}</p>
      <p className="text-[10px] font-bold uppercase tracking-wider text-[#768994] mt-1">{label}</p>
    </div>
  );

  return (
    <WrikeApplyShell title="Import into Project/Time"
      subtitle="A CSV shaped like this screen's own export" accent="#1cc1a5" onClose={onClose}>
      <div className="px-6 py-5 overflow-y-auto flex-1 space-y-4">
        {done ? (
          <div className="py-4 space-y-3 text-center">
            <CheckCircle2 className="w-10 h-10 text-[#1cc1a5] mx-auto" />
            <p className="text-sm font-bold text-[#122027]">
              Imported {done.inserted} row{done.inserted === 1 ? "" : "s"}.
            </p>
            <p className="text-xs text-[#768994]">
              {done.jobsToCreate.length ? `${done.jobsToCreate.length} job${done.jobsToCreate.length === 1 ? "" : "s"} created · ` : ""}
              {done.jobsToUpdate.length ? `${done.jobsToUpdate.length} updated · ` : ""}
              {done.duplicates ? `${done.duplicates} duplicate${done.duplicates === 1 ? "" : "s"} skipped · ` : ""}
              {done.errors.length ? `${done.errors.length} skipped` : "no errors"}.
            </p>
          </div>
        ) : (
          <>
            <div>
              <label className="flex items-center gap-3 px-4 py-3 border-2 border-dashed border-[#dce4ec] hover:border-[#1cc1a5] rounded-2xl cursor-pointer transition-colors">
                <UploadCloud className="w-4 h-4 text-[#768994] shrink-0" />
                <span className="text-sm font-bold text-[#122027]">
                  {fileName || "Choose a CSV file…"}
                </span>
                <input type="file" accept=".csv,text/csv" className="hidden"
                  onChange={(e) => handleFile(e.target.files?.[0])} />
              </label>
              <p className="text-[11px] text-[#768994] mt-2 leading-snug">
                Same columns as Export to Excel. Client Amends and 3D take <b>Y</b>/<b>N</b>.
                Rate, OT and Total are ignored — they're worked out from the position rates.
              </p>
            </div>

            {busy && !plan && (
              <p className="flex items-center gap-2 text-sm text-[#768994]">
                <Loader2 className="w-4 h-4 animate-spin" /> Checking the file…
              </p>
            )}

            {parseError && (
              <p className="flex items-start gap-2 text-sm text-rose-600">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {parseError}
              </p>
            )}

            {unmatchedHeaders.length > 0 && (
              <div className="px-3 py-2 bg-[#f4b740]/10 border border-[#f4b740]/30 rounded-xl">
                <p className="text-[11px] font-bold text-[#8a6d1a]">
                  Columns not recognised (ignored): {unmatchedHeaders.join(", ")}
                </p>
              </div>
            )}

            {plan && (
              <div className="space-y-3">
                <div className="flex gap-2 flex-wrap">
                  <Stat n={plan.toInsert} label="To import" tone="text-[#1cc1a5]" />
                  <Stat n={plan.duplicates} label="Duplicates skipped" />
                  <Stat n={plan.errors.length} label="Rows skipped" tone={plan.errors.length ? "text-rose-500" : ""} />
                  <Stat n={plan.jobsToCreate.length} label="Jobs created" />
                  <Stat n={plan.jobsToUpdate.length} label="Jobs updated" />
                </div>

                {plan.unknownStaff.length > 0 && (
                  <div className="px-3 py-2 bg-[#f4b740]/10 border border-[#f4b740]/30 rounded-xl">
                    <p className="text-[11px] font-bold text-[#8a6d1a] mb-1">
                      No profile matches these names — their rows import with nobody attached,
                      so they'll show "—" under Worked On By and bill at the default rate:
                    </p>
                    <p className="text-[11px] text-[#8a6d1a]">{plan.unknownStaff.join(", ")}</p>
                  </div>
                )}

                {plan.jobsToCreate.length > 0 && (
                  <div className="px-3 py-2 bg-[#12a0e1]/5 border border-[#12a0e1]/20 rounded-xl">
                    <p className="text-[11px] font-bold text-[#0d8bc4] mb-1">
                      New Job Book entries will be created for:
                    </p>
                    <p className="text-[11px] text-[#0d8bc4] font-mono break-words">
                      {plan.jobsToCreate.slice(0, 25).join(", ")}
                      {plan.jobsToCreate.length > 25 ? ` … +${plan.jobsToCreate.length - 25} more` : ""}
                    </p>
                  </div>
                )}

                {plan.jobsToUpdate.length > 0 && (
                  <div className="px-3 py-2 bg-[#f4b740]/10 border border-[#f4b740]/30 rounded-xl">
                    <p className="text-[11px] font-bold text-[#8a6d1a] mb-1">
                      These existing jobs will have Office / P-D / Job Cat. / Costs / Ordered By /
                      Billed To <b>overwritten</b> from the file:
                    </p>
                    <p className="text-[11px] text-[#8a6d1a] font-mono break-words">
                      {plan.jobsToUpdate.slice(0, 25).join(", ")}
                      {plan.jobsToUpdate.length > 25 ? ` … +${plan.jobsToUpdate.length - 25} more` : ""}
                    </p>
                  </div>
                )}

                {plan.errors.length > 0 && (
                  <div className="border border-[#dce4ec] rounded-xl overflow-hidden">
                    <p className="px-3 py-2 text-[11px] font-bold text-[#122027] bg-slate-50 border-b border-[#dce4ec]">
                      Skipped rows
                    </p>
                    <div className="max-h-40 overflow-y-auto divide-y divide-[#f0f4f8]">
                      {plan.errors.slice(0, 100).map((e) => (
                        <p key={e.line} className="px-3 py-1.5 text-[11px] text-[#768994]">
                          <span className="font-mono font-bold text-[#122027]">Line {e.line}</span> — {e.reason}
                        </p>
                      ))}
                    </div>
                  </div>
                )}

                {applyError && (
                  <p className="flex items-start gap-2 text-sm text-rose-600">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {applyError}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="px-6 py-4 border-t border-[#dce4ec] flex items-center justify-end gap-2 shrink-0">
        <button onClick={onClose}
          className="px-5 py-2.5 text-sm font-bold text-[#768994] hover:text-[#122027] bg-white border border-[#dce4ec] rounded-xl transition-[color] ease-[cubic-bezier(0.16,1,0.3,1)]">
          {done ? "Close" : "Cancel"}
        </button>
        {!done && (
          <button onClick={apply} disabled={busy || !plan || plan.toInsert === 0}
            className="flex items-center gap-2 px-6 py-2.5 bg-[#1cc1a5] hover:bg-[#17a98f] text-white text-sm font-bold rounded-xl transition-[background-color] ease-[cubic-bezier(0.16,1,0.3,1)] disabled:opacity-40">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            Import {plan?.toInsert || 0} row{plan?.toInsert === 1 ? "" : "s"}
          </button>
        )}
      </div>
    </WrikeApplyShell>
  );
}
