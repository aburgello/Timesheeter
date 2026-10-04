// The Studio Scan: read Wrike's folder tree and reconcile the Job
// Book with it. Writes only to the Job Book, never to Wrike.
//
// Part of Administration. Split out of components/Management.jsx, which is
// still the entry point and re-exports what other screens import.
import { useState, useEffect, useCallback, useMemo } from "react";
import { Plus, X, Search, RefreshCw, CheckCircle2 } from "lucide-react";
import { supabase, selectAll } from "../../lib/supabaseClient";
import { confirmAction } from "../../lib/confirm";
import { scanStudioJobNumbers, descriptionsAgree } from "../../lib/wrikeCampaign";

// ── Studio Job-Number Scanner ──────────────────────────────────────────────────
// Walks every visible Wrike folder for canonical "Film : CODE, Desc" job folders
// and backfills the Job Book with any codes it doesn't already have. Read-only
// against Wrike; the only write is the confirmed bulk insert into `jobs`, and it
// never touches an existing row (codes already in the book are shown but locked).
const scanCodeOf = (s) => {
  const m = (s || "").match(/XY\d{5,6}/i);
  return m ? m[0].toUpperCase() : (s || "").trim().toUpperCase();
};
// The "film" of a job label: the part before " : ". A bare year/number (e.g.
// "2026") or a letterless token isn't a real film — those are what the scan's
// year-folder fix now resolves to a real parent film.
const scanFilmOf = (s) => ((s || "").includes(" : ") ? (s || "").split(" : ")[0] : "").trim();
const scanIsPseudoFilm = (film) => !film || /^\d{2,4}$/.test(film.trim()) || !/[a-z]/i.test(film);
// A book row that is nothing but the bare code — the stub `ensureJob` writes
// the first time a job is seen in use, before anyone files it properly.
const scanIsBareCode = (s) => /^\s*XY\d{5,6}\s*$/i.test(s || "");
// The description a book row currently carries: everything after the first
// comma in its job number.
//
// Read off job_number rather than the project_description column on purpose.
// The rows this exists to catch were written by ensureJob, which only ever
// sets job_number/film_title/client — so their project_description is still
// null while the description itself sits inside the job number string.
const scanDescOf = (s) => {
  const i = (s || "").indexOf(",");
  return i === -1 ? "" : s.slice(i + 1).trim();
};
// How complete a book row is, used to pick which row wins when the same code
// appears more than once. `jobs.job_number` is unique, so "XY025091" and
// "The History of Sound : XY025091, NM Packshots FinalWindow" coexist happily
// as separate rows for one job — the constraint only stops two rows sharing
// the *same string*. Canonical "Film : CODE, Description" beats "Film : CODE"
// beats a bare stub.
const scanRowRank = (s) =>
  scanIsBareCode(s) ? 0 : (s || "").includes(" : ") ? ((s || "").includes(",") ? 2 : 1) : 0;
export function StudioJobScanModal({ onClose, onApplied }) {
  const [phase, setPhase] = useState("scanning"); // scanning | review | saving | done
  const [error, setError] = useState("");
  const [candidates, setCandidates] = useState([]);
  const [totalFolders, setTotalFolders] = useState(0);
  const [existingCodes, setExistingCodes] = useState(new Set());
  const [existingByCode, setExistingByCode] = useState({}); // code -> best book row
  const [existingExtras, setExistingExtras] = useState({}); // code -> that code's other book rows
  const [fixedCount, setFixedCount] = useState(0);
  const [selected, setSelected] = useState({});   // code -> bool
  const [savedCount, setSavedCount] = useState(0);
  const [search, setSearch] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);
  const [showCorrections, setShowCorrections] = useState(false);
  const [keptCodes, setKeptCodes] = useState(new Set()); // codes "kept" in Review → job_sync_kept

  const loadScan = useCallback(async () => {
    setPhase("scanning");
    try {
      // Whole table — a truncated read would make jobs already in the book look
      // new and invite duplicate inserts.
      const [found, existing, kept] = await Promise.all([
        scanStudioJobNumbers(),
        selectAll("jobs", "id, job_number, film_title, client"),
        // Ordered by `code` — this table is keyed on it and has no `id`, and
        // selectAll's default ORDER BY id made every read of it 400 silently.
        selectAll("job_sync_kept", "code", undefined, "code"),
      ]);
      // One code can own several book rows (a bare stub plus the properly filed
      // row, or two spellings of the same description). Keep the most complete
      // row as the one a correction is measured against and applied to, and
      // hang on to the rest — blindly overwriting the map, as this used to,
      // could leave a stub as the "current" row and then try to rewrite it to a
      // string its own sibling already holds, which is what tripped
      // jobs_job_number_key.
      const byCode = {};
      const extrasByCode = {};
      existing.forEach((j) => {
        const code = scanCodeOf(j.job_number);
        const prev = byCode[code];
        if (!prev) { byCode[code] = j; return; }
        const keep = scanRowRank(j.job_number) > scanRowRank(prev.job_number) ? j : prev;
        byCode[code] = keep;
        (extrasByCode[code] = extrasByCode[code] || []).push(keep === j ? prev : j);
      });
      const have = new Set(Object.keys(byCode));
      const sel = {};
      found.forEach((c) => { if (!have.has(c.code)) sel[c.code] = true; });
      setExistingCodes(have);
      setExistingByCode(byCode);
      setExistingExtras(extrasByCode);
      setCandidates(found);
      setTotalFolders(found.totalFolders || 0);
      setSelected(sel);
      setKeptCodes(new Set(kept.map((k) => k.code)));
      setPhase("review");
    } catch (e) {
      setError(e.message || String(e));
      setPhase("review");
    }
  }, []);

  useEffect(() => { let alive = true; if (alive) loadScan(); return () => { alive = false; }; }, [loadScan]);

  // Existing book rows that disagree with Wrike. Three kinds:
  //   • a pseudo-film ("2026") the re-derived scan now resolves to a real film;
  //   • a row filed under the WRONG film, or carrying a malformed code
  //     ("XY026089_SKY_VIP" instead of "XY026089");
  //   • a row whose DESCRIPTION describes something else entirely.
  // The second kind is why "0 new" can coexist with jobs you can't find: the
  // code IS in the book, so the scan skips it as a duplicate, but it's filed
  // under someone else's film and no film search will ever surface it. Wrike's
  // folder tree is the source of truth. Nothing is written without a confirm.
  //
  // "Active only" governs this list too. It used to filter the NEW rows and
  // nothing else, so ticking it hid 2,532 archived codes from the table while
  // leaving every archived row's correction sitting in the banner above it —
  // 59 of them, almost all from _Old, i.e. finished campaigns nobody is going
  // to refile. The tick means "show me work that's live", and a correction is
  // work.
  const allCorrections = candidates.filter((c) => {
    const cur = existingByCode[c.code];
    if (!cur) return false;
    if (!c.filmTitle || scanIsPseudoFilm(c.filmTitle)) return false; // scan has nothing better
    const curFilm = scanFilmOf(cur.job_number) || cur.film_title || "";
    const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const filmWrong = norm(curFilm) !== norm(c.filmTitle);
    // Canonical code position is the bare code — a suffix means the folder name
    // leaked into it.
    const codeMalformed = !new RegExp(`(^|\\s:\\s)${c.code}\\s*,`, "i").test(cur.job_number || "");
    // A description that isn't this job's at all. The signature case is a row
    // built from a TASK name back when the pull paths did that — the book says
    // "ODY_Print_Teaser1SHT_Birds_CMYK_KR" where the folder says "French Canada
    // Assets". Such a row has the right film and a well-formed code, so both
    // tests above pass it and nothing ever offered to repair it.
    //
    // descriptionsAgree is loose on purpose (wording, punctuation, and the
    // region prefix the scan adds are all treated as agreement) so this only
    // fires when the two are describing different work. An empty description on
    // either side counts as agreement, so a row nobody has a better answer for
    // is left alone rather than churned.
    const descWrong = !descriptionsAgree(scanDescOf(cur.job_number), c.projectDescription);
    // Another row for this code already IS what the scan would write, and this
    // one isn't — typically the region twin, where the book holds both
    // "…, Titles" and "…, INT - Titles" and the canonical one is the sibling.
    // Routed through corrections rather than deleted here so that fixMisfilmed's
    // existing twin handling does the work: it drops this row and lets the
    // canonical sibling stand, which is precisely the wanted outcome.
    const supersededByTwin =
      (cur.job_number || "") !== c.jobNumber &&
      (existingExtras[c.code] || []).some((r) => (r.job_number || "") === c.jobNumber);
    return filmWrong || codeMalformed || descWrong || supersededByTwin;
  });

  const corrections = allCorrections.filter((c) => !activeOnly || !c.archived);
  const correctionsHidden = activeOnly
    ? allCorrections.length - corrections.length
    : 0;

  const allNew  = candidates.filter((c) => !existingCodes.has(c.code));
  const newOnes = allNew.filter((c) => !activeOnly || !c.archived);
  const archivedHidden = activeOnly ? allNew.filter((c) => c.archived).length : 0;
  const dupes   = candidates.filter((c) => existingCodes.has(c.code));
  const shown = newOnes.filter((c) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      c.code.toLowerCase().includes(q) ||
      (c.filmTitle || "").toLowerCase().includes(q) ||
      (c.client || "").toLowerCase().includes(q) ||
      // Region too, so a backfill can be done one territory at a time ("uk").
      (c.region || "").toLowerCase().includes(q)
    );
  });
  const selectedCount = newOnes.filter((c) => selected[c.code]).length;
  const allShownSelected = shown.length > 0 && shown.every((c) => selected[c.code]);

  const toggle = (code) => setSelected((p) => ({ ...p, [code]: !p[code] }));
  const toggleAllShown = () =>
    setSelected((p) => {
      const next = { ...p };
      shown.forEach((c) => { next[c.code] = !allShownSelected; });
      return next;
    });

  const apply = async () => {
    const rows = newOnes
      .filter((c) => selected[c.code])
      .map((c) => ({
        job_number: c.jobNumber,
        film_title: c.filmTitle || null,
        client: c.client || null,
        project_description: c.projectDescription || null,
        start_date: c.createdDate || null, // Wrike folder creation date
      }));
    if (!rows.length) return;
    setPhase("saving");
    // Chunked insert so a large backfill doesn't hit request limits.
    let saved = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { error: err } = await supabase.from("jobs").insert(chunk);
      if (err) { setError(err.message); setPhase("review"); return; }
      saved += chunk.length;
    }
    setSavedCount(saved);
    setPhase("done");
  };

  // The scan's own candidate for a code, so the rules below can defer to what
  // it would write rather than encoding a house style of their own.
  const candByCode = useMemo(() => {
    const m = {};
    candidates.forEach((c) => { m[c.code] = c; });
    return m;
  }, [candidates]);

  // Extra rows for a code that carry nothing the kept row doesn't. Two shapes:
  //
  //   • a bare "XY025091" stub sitting beside a properly filed row — what
  //     ensureJob writes the first time a job is seen in use;
  //   • a REGION TWIN: the same film and the same description, differing only
  //     in the region prefix the scan writes ("Shrek 5 : XY023362, Titles"
  //     beside "Shrek 5 : XY023362, INT - Titles"). jobs.job_number is unique
  //     on the whole string, so both rows are legal and both show up in every
  //     job picker, with useJobLookup silently preferring whichever has the
  //     lower id.
  //
  // Only ever removes the extra when the KEPT row is the one the scan itself
  // would write. When it's the other way round — the kept row is the scruffy
  // one and an extra is canonical — nothing is deleted here; `supersededByTwin`
  // routes that through corrections instead, where the existing twin handling
  // drops the kept row and lets the canonical sibling stand.
  //
  // The film must match too. "Universal House Job : XY018540, Digital
  // Housekeeping" and "XYi Internal Use : XY018540, Digital Housekeeping" have
  // identical descriptions and are NOT duplicates — they are the same code
  // filed under two different owners, which is a judgement call for a human and
  // is already surfaced by filmWrong.
  const redundantRows = Object.entries(existingExtras).flatMap(([code, rows]) => {
    const kept = existingByCode[code];
    if (!kept || scanIsBareCode(kept.job_number)) return [];
    const cand = candByCode[code];
    const keptIsCanonical = !!cand && kept.job_number === cand.jobNumber;
    const keptFilm = scanFilmOf(kept.job_number).toLowerCase();
    return rows.filter((r) => {
      if (scanIsBareCode(r.job_number)) return true;
      if (!keptIsCanonical) return false;
      if ((r.job_number || "") === kept.job_number) return false;
      return (
        scanFilmOf(r.job_number).toLowerCase() === keptFilm &&
        descriptionsAgree(scanDescOf(r.job_number), scanDescOf(kept.job_number))
      );
    });
  });

  // Codes the user has told the scan to stop asking about — "Keep" in Review.
  // Kept rows stay visible (greyed, undoable) but are excluded from the fix run
  // and from the Fix button's count.
  const keptCorrections = corrections.filter((c) => keptCodes.has(c.code));
  const fixableCorrections = corrections.filter((c) => !keptCodes.has(c.code));
  const keptRedundant = redundantRows.filter((r) => keptCodes.has(scanCodeOf(r.job_number)));
  const fixableRedundant = redundantRows.filter((r) => !keptCodes.has(scanCodeOf(r.job_number)));
  const keptTotal = keptCorrections.length + keptRedundant.length;

  // Record (or retract) a "keep" in job_sync_kept, mirroring it into local state
  // so the open Review reflects it immediately. Write failures surface in the
  // header banner and leave the row untouched.
  const keepCode = async (code) => {
    const { error } = await supabase.from("job_sync_kept").upsert({ code }, { onConflict: "code" });
    if (error) { setError(`Couldn't keep ${code}: ${error.message}`); return; }
    setKeptCodes((prev) => new Set(prev).add(code));
  };
  const unkeepCode = async (code) => {
    const { error } = await supabase.from("job_sync_kept").delete().eq("code", code);
    if (error) { setError(`Couldn't undo keep for ${code}: ${error.message}`); return; }
    setKeptCodes((prev) => { const next = new Set(prev); next.delete(code); return next; });
  };

  // Correct existing book rows whose film was a pseudo-film ("2026") to the
  // real film the re-derived scan found — updates film, client, job number and
  // description in place. Only touches the `fixableCorrections` set; rows the
  // user kept in Review are left alone.
  const fixMisfilmed = async () => {
    if (!fixableCorrections.length && !fixableRedundant.length) return;
    const total = fixableCorrections.length + fixableRedundant.length;
    const ok = await confirmAction({
      title: `Fix ${total} book ${total === 1 ? "entry" : "entries"}?`,
      message:
        (fixableCorrections.length
          ? `${fixableCorrections.length} ${fixableCorrections.length === 1 ? "entry disagrees" : "entries disagree"} with Wrike's folder tree — wrong film, a year/placeholder film, or the folder name left inside the job number. This rewrites their film, client, description and job number to match Wrike. `
          : "") +
        (fixableRedundant.length
          ? `${fixableRedundant.length} duplicate ${fixableRedundant.length === 1 ? "entry says" : "entries say"} nothing the properly filed row for the same job doesn't — a bare code, or the same description without its region prefix — and will be deleted. `
          : "") +
        (keptTotal > 0
          ? `${keptTotal} ${keptTotal === 1 ? "entry is" : "entries are"} kept as-is and left alone. `
          : "") +
        "Use Review first to see every before → after.",
      confirmLabel: `Fix ${total}`,
    });
    if (!ok) return;
    setPhase("saving");
    let fixed = 0;
    let merged = 0;
    const failures = [];
    for (const c of fixableCorrections) {
      const cur = existingByCode[c.code];
      // Another row for this code already *is* what Wrike says this one should
      // become. Rewriting would violate jobs_job_number_key, and the right
      // outcome isn't two identical rows anyway — drop this one and let the
      // already-correct sibling stand.
      const twin = (existingExtras[c.code] || []).find(
        (r) => (r.job_number || "") === c.jobNumber
      );
      if (twin) {
        const { error: delErr } = await supabase.from("jobs").delete().eq("id", cur.id);
        if (delErr) failures.push(`${c.code}: ${delErr.message}`);
        else merged += 1;
        continue;
      }
      const { error: err } = await supabase.from("jobs").update({
        job_number: c.jobNumber,
        film_title: c.filmTitle || null,
        client: c.client || null,
        project_description: c.projectDescription || null,
      }).eq("id", cur.id);
      // One bad row used to abort the whole run, leaving every later correction
      // unapplied and no record of which one failed. Keep going and report.
      if (err) failures.push(`${c.code}: ${err.message}`);
      else fixed += 1;
    }

    if (fixableRedundant.length) {
      const ids = fixableRedundant.map((r) => r.id);
      for (let i = 0; i < ids.length; i += 200) {
        const { error: delErr } = await supabase
          .from("jobs").delete().in("id", ids.slice(i, i + 200));
        if (delErr) failures.push(`duplicate cleanup: ${delErr.message}`);
        else merged += Math.min(200, ids.length - i);
      }
    }

    setFixedCount(fixed + merged);
    setError(
      failures.length
        ? `${failures.length} of ${fixableCorrections.length} couldn't be fixed — ${failures.slice(0, 3).join("; ")}${failures.length > 3 ? "…" : ""}`
        : ""
    );
    await loadScan(); // re-derive so corrected rows drop out of the list
  };

  return (
    <div className="fixed inset-0 z-[9999] bg-black/40 flex items-center justify-center p-4" onMouseDown={onClose}>
      <div
        className="bg-white rounded-3xl w-full max-w-6xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <h2 className="text-lg font-black text-[#122027]">Scan Wrike for job numbers</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X className="w-5 h-5" /></button>
        </div>

        {phase === "scanning" && (
          <div className="flex-1 flex flex-col items-center justify-center py-20 gap-3 text-[#768994]">
            <RefreshCw className="w-6 h-6 animate-spin text-[#1cc1a5]" />
            <p className="font-bold text-sm">Reading the Wrike folder tree…</p>
          </div>
        )}

        {phase === "done" && (
          <div className="flex-1 flex flex-col items-center justify-center py-20 gap-3">
            <CheckCircle2 className="w-10 h-10 text-emerald-500" />
            <p className="font-black text-[#122027]">Added {savedCount} {savedCount === 1 ? "job" : "jobs"} to the Job Book.</p>
            <button onClick={onApplied} className="mt-2 px-5 py-2 bg-[#1cc1a5] hover:bg-[#17a892] text-white text-sm font-bold rounded-xl">
              Done
            </button>
          </div>
        )}

        {(phase === "review" || phase === "saving") && (
          <>
            <div className="px-6 py-3 border-b border-slate-100 flex flex-wrap items-center gap-3 text-[11px] font-bold">
              <span className="text-emerald-600">{newOnes.length} new</span>
              <span className="text-[#768994]">{dupes.length} already in book</span>
              {/* Both hidden counts sit on this line, next to the tick that
                  controls them — the corrections one as well, so a review that
                  has gone quiet because everything in it was archived still
                  says so rather than just showing nothing. */}
              {archivedHidden + correctionsHidden > 0 && (
                <span className="text-slate-400">
                  {archivedHidden + correctionsHidden} archived hidden
                  {correctionsHidden > 0 && archivedHidden > 0 && ` (${correctionsHidden} of them corrections)`}
                </span>
              )}
              <span className="text-[#122027]">{candidates.length} job codes / {totalFolders} folders</span>
              <label className="ml-auto flex items-center gap-1.5 text-[#122027] cursor-pointer">
                <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} className="accent-[#1cc1a5]" />
                Active only
              </label>
              {/* The fix result was previously computed and never shown, so a
                  partial run looked identical to a clean one. */}
              {fixedCount > 0 && !error && (
                <span className="text-emerald-600">✓ Fixed {fixedCount}</span>
              )}
              {error && <span className="text-rose-500">⚠ {error}</span>}
            </div>

            {(corrections.length > 0 || redundantRows.length > 0) && (
              <div className="border-b border-amber-100 bg-amber-50/60">
                <div className="px-6 py-2.5 flex items-center gap-3">
                  <span className="text-[11px] font-bold text-amber-700">
                    {corrections.length > 0 && (
                      <>
                        {corrections.length} existing {corrections.length === 1 ? "entry disagrees" : "entries disagree"} with Wrike — filed under the wrong film, describing different work, or with the folder name stuck in the job number. These are in the book already, which is why they don’t show as new.
                      </>
                    )}
                    {redundantRows.length > 0 && (
                      <>
                        {corrections.length > 0 ? " " : ""}
                        {redundantRows.length} duplicate {redundantRows.length === 1 ? "entry says" : "entries say"} nothing the properly filed row doesn’t — a bare code, or the same description minus its region prefix — so fixing removes {redundantRows.length === 1 ? "it" : "them"}.
                      </>
                    )}
                    {keptTotal > 0 && (
                      <> · {keptTotal} {keptTotal === 1 ? "entry is" : "entries are"} kept — undo in Review</>
                    )}
                    {/* Never silently: hiding a correction is a decision, so
                        say how many and what turns them back on. */}
                    {correctionsHidden > 0 && (
                      <> · {correctionsHidden} more {correctionsHidden === 1 ? "is" : "are"} archived or in _Old — untick Active only to see {correctionsHidden === 1 ? "it" : "them"}</>
                    )}
                  </span>
                  <button onClick={() => setShowCorrections(v => !v)}
                    className="ml-auto shrink-0 px-3 py-1.5 bg-white border border-amber-300 hover:border-amber-400 text-amber-700 text-[11px] font-bold rounded-lg transition-colors">
                    {showCorrections ? "Hide" : "Review"}
                  </button>
                  {/* Fix is gated behind Review so nobody can accidentally fix
                      everything at once — you have to see the rows (and can Keep
                      some) before it unlocks. */}
                  <button onClick={fixMisfilmed} disabled={phase === "saving" || !showCorrections || fixableCorrections.length + fixableRedundant.length === 0}
                    className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white text-[11px] font-bold rounded-lg transition-colors">
                    Fix {fixableCorrections.length + fixableRedundant.length}
                  </button>
                </div>
                {showCorrections && (
                  <div className="max-h-[50vh] overflow-y-auto border-t border-amber-100 px-6 py-2">
                    <table className="w-full text-[11px]">
                      <tbody>
                        {corrections.map((c) => {
                          const kept = keptCodes.has(c.code);
                          return (
                            <tr key={c.code} className={`align-top ${kept ? "opacity-50" : ""}`}>
                              <td className="py-1 pr-3 font-mono font-black text-amber-700 whitespace-nowrap">{c.code}</td>
                              <td className="py-1 pr-2 text-slate-400 line-through truncate max-w-[420px]"
                                  title={existingByCode[c.code]?.job_number}>
                                {existingByCode[c.code]?.job_number || "—"}
                              </td>
                              <td className="py-1 max-w-[420px]">
                                <div className="text-[#122027] truncate" title={c.jobNumber}>→ {c.jobNumber}</div>
                                {c.folderPath && (
                                  <div className="text-[10px] text-slate-400 truncate" title={c.folderPath}>
                                    Wrike: {c.folderPath}
                                  </div>
                                )}
                              </td>
                              <td className="py-1 pl-2 text-right whitespace-nowrap">
                                {kept ? (
                                  <>
                                    <span className="mr-1.5 text-[9px] font-black uppercase tracking-wider text-emerald-600 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">Kept</span>
                                    <button onClick={() => unkeepCode(c.code)}
                                      className="px-2 py-0.5 text-[10px] font-black rounded-md bg-slate-100 text-slate-500 hover:bg-slate-200 transition-colors">
                                      Undo
                                    </button>
                                  </>
                                ) : (
                                  <button onClick={() => keepCode(c.code)}
                                    className="px-2 py-0.5 text-[10px] font-black rounded-md border border-slate-300 text-slate-500 hover:border-amber-400 hover:text-amber-700 transition-colors">
                                    Keep
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                        {/* Duplicate stubs aren't rewritten, they're removed —
                            show them here too so Review really is every change. */}
                        {redundantRows.map((r) => {
                          const rCode = scanCodeOf(r.job_number);
                          const kept = keptCodes.has(rCode);
                          return (
                            <tr key={`stub-${r.id}`} className={`align-top ${kept ? "opacity-50" : ""}`}>
                              <td className="py-1 pr-3 font-mono font-black text-amber-700 whitespace-nowrap">
                                {rCode}
                              </td>
                              <td className="py-1 pr-2 text-slate-400 line-through truncate max-w-[420px]"
                                  title={r.job_number}>
                                {r.job_number}
                              </td>
                              <td className="py-1 max-w-[420px]">
                                <div className="text-slate-500 italic truncate" title={existingByCode[rCode]?.job_number}>
                                  → duplicate, removed (kept: {existingByCode[rCode]?.job_number})
                                </div>
                                {candByCode[rCode]?.folderPath && (
                                  <div className="text-[10px] text-slate-400 truncate" title={candByCode[rCode].folderPath}>
                                    Wrike: {candByCode[rCode].folderPath}
                                  </div>
                                )}
                              </td>
                              <td className="py-1 pl-2 text-right whitespace-nowrap">
                                {kept ? (
                                  <>
                                    <span className="mr-1.5 text-[9px] font-black uppercase tracking-wider text-emerald-600 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">Kept</span>
                                    <button onClick={() => unkeepCode(rCode)}
                                      className="px-2 py-0.5 text-[10px] font-black rounded-md bg-slate-100 text-slate-500 hover:bg-slate-200 transition-colors">
                                      Undo
                                    </button>
                                  </>
                                ) : (
                                  <button onClick={() => keepCode(rCode)}
                                    className="px-2 py-0.5 text-[10px] font-black rounded-md border border-slate-300 text-slate-500 hover:border-amber-400 hover:text-amber-700 transition-colors">
                                    Keep
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {newOnes.length === 0 ? (
              <div className="flex-1 flex items-center justify-center py-16 text-center text-[#768994] italic text-sm px-8">
                {error
                  ? "Scan failed — see above."
                  : totalFolders === 0
                  ? "Wrike returned no folders — the connection isn’t authorised in this environment."
                  : candidates.length === 0
                  ? `Walked ${totalFolders} folders but found no XY job codes.`
                  : "No new job numbers found. The Job Book is already up to date."}
              </div>
            ) : (
              <>
                <div className="px-6 py-2.5 flex items-center gap-3 border-b border-slate-100">
                  <label className="flex items-center gap-2 text-[11px] font-black text-[#768994] cursor-pointer shrink-0">
                    <input type="checkbox" checked={allShownSelected} onChange={toggleAllShown} className="accent-[#1cc1a5]" />
                    Select shown
                  </label>
                  <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#768994]" />
                    <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter…"
                      className="w-full pl-8 pr-3 py-1.5 text-[12px] border border-slate-200 rounded-lg outline-none focus:border-[#1cc1a5]" />
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto">
                  <table className="w-full text-[12px]">
                    <thead className="sticky top-0 bg-slate-50 z-10">
                      <tr className="text-left text-[9px] font-black uppercase tracking-widest text-[#768994]">
                        <th className="px-4 py-2 w-8"></th>
                        <th className="px-2 py-2">Code</th>
                        <th className="px-2 py-2">Film</th>
                        <th className="px-2 py-2">Region</th>
                        <th className="px-2 py-2">Client</th>
                        <th className="px-2 py-2">Description</th>
                        <th className="px-2 py-2">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((c) => (
                        <tr key={c.code} className="border-b border-slate-50 hover:bg-slate-50/60 cursor-pointer" onClick={() => toggle(c.code)}>
                          <td className="px-4 py-2 align-top"><input type="checkbox" checked={!!selected[c.code]} onChange={() => toggle(c.code)} className="accent-[#1cc1a5]" onClick={(e) => e.stopPropagation()} /></td>
                          {/* Where in Wrike this came from. The scan has always
                              computed folderPath — the corrections list shows it
                              under each row — but a NEW row showed only what was
                              derived, so a code with no film, region or client
                              was three dashes and no way to tell whether that
                              meant "house job", "filed outside any studio" or
                              "the walk gave up". The breadcrumb answers all
                              three at a glance. */}
                          <td className="px-2 py-2 font-black font-mono text-[#1cc1a5] align-top">
                            {c.code}
                            {c.folderPath && (
                              <div className="font-sans font-medium text-[10px] text-slate-400 truncate max-w-[280px]" title={c.folderPath}>
                                {c.folderPath}
                              </div>
                            )}
                          </td>
                          <td className="px-2 py-2 font-bold text-[#122027] truncate max-w-[260px] align-top" title={c.jobNumber}>
                            {c.filmTitle || (
                              // A truncated walk yields no film for a reason
                              // that isn't "there isn't one", and the two used
                              // to look identical.
                              <span className="text-slate-300">
                                {c.ancestryTruncated ? "couldn't establish" : "—"}
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-2 align-top">
                            {c.region
                              ? <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-[#12a0e1]/10 text-[#12a0e1]">{c.region}</span>
                              : <span className="text-slate-300">—</span>}
                          </td>
                          <td className="px-2 py-2 text-slate-600 align-top">{c.client || <span className="text-slate-300">—</span>}</td>
                          <td className="px-2 py-2 text-slate-500 truncate max-w-[320px] align-top" title={c.projectDescription}>{c.projectDescription || "—"}</td>
                          <td className="px-2 py-2 text-slate-400 whitespace-nowrap tabular-nums align-top">{c.createdDate || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="px-6 py-3 border-t border-slate-100 flex items-center justify-between">
                  <p className="text-[11px] text-[#768994] font-medium">Taken from the folder title, prefixed with the region its studio folder sits under — existing rows are never touched.</p>
                  <button onClick={apply} disabled={selectedCount === 0 || phase === "saving"}
                    className="flex items-center gap-1.5 px-5 py-2 bg-[#1cc1a5] hover:bg-[#17a892] disabled:bg-slate-200 disabled:text-slate-400 text-white text-sm font-bold rounded-xl transition-[background-color] ease-[cubic-bezier(0.16,1,0.3,1)]">
                    {phase === "saving" ? <><RefreshCw className="w-4 h-4 animate-spin" /> Saving…</> : <><Plus className="w-4 h-4" /> Add {selectedCount} to Job Book</>}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
