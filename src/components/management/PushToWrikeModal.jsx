// Push to Wrike and Re-tag: copy a studio's template into a film's
// Wrike project and set the Job Number on its folders and tasks.
//
// Part of Administration. Split out of components/Management.jsx, which is
// still the entry point and re-exports what other screens import.
import { useState, useEffect, useMemo, useRef } from "react";
import { AlertTriangle, CheckCircle2, Loader2, UploadCloud } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { notify } from "../../lib/toast";
import { discoverJobNumberField, fetchAllFolders, findStudioFolder, findMasterTemplateFolder, fetchFolderProjects, collectSubtreeIds, planPropagate, applyPropagate, copyTemplateDeep, mapSlotFoldersUnder, pickSlotFolder, slotSuffix, renameFolder, setFolderJobNumber, triggerFieldCascade } from "../../lib/wrikeCampaign";
import { StrictSelect } from "./fields";
import { CheckRow, WrikeApplyShell } from "./WrikeApplyShell";

// Reqs 5 + 1 — duplicate the studio template into the film's Wrike project, then
// set the Job Number custom field on every task/subtask beneath each activated
// slot's folder. The preview validates every precondition against LIVE Wrike
// data on open (template found? film project found? field found?) and refuses to
// write unless they all hold — the safety net for shipping without local Wrike
// auth to test against.
// mode "push"  — duplicate template into the film project, then tag (reqs 5+1).
// mode "retag" — skip the copy; re-tag the film project's existing job folders,
//                topping up items added/renamed since (reqs 2 + 4).
export function PushToWrikeModal({ studio, filmTitle, jobs, mode = "push", onClose }) {
  const isRetag = mode === "retag";
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState(null); // { step, done, total }
  const [result, setResult] = useState(null);      // { propagated, failed, skipped }
  const [targetId, setTargetId] = useState("");    // chosen Wrike project id (film picker)

  // Activated jobs, with the code we'll write as the field value. Identified by
  // job id, not slot label: the same slot can hold several jobs (two launches off
  // one template folder), and keying by label would merge them into one row.
  const slots = useMemo(() => jobs.map((j) => ({
    id: j.id,
    label: j.template_slot,
    jobNumber: j.job_number,
    code: (j.job_number?.match(/XY\d+/) || [])[0] || j.job_number,
  })), [jobs]);

  // Which activated jobs to actually tag — all by default; unchecking one in the
  // preview drops it from this push (its Job Book row is untouched).
  const [excluded, setExcluded] = useState(() => new Set());
  const selectedSlots = useMemo(() => slots.filter((s) => !excluded.has(s.id)), [slots, excluded]);
  const toggleSlot = (id) => setExcluded((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [field, byId] = await Promise.all([discoverJobNumberField(), fetchAllFolders()]);
        const template = findMasterTemplateFolder(byId, studio);
        const studioFolder = findStudioFolder(byId, studio);
        const projects = studioFolder ? await fetchFolderProjects(studioFolder.childIds) : [];
        // Auto-pick the best match so the common case is one glance. Compare
        // underscore/space-insensitively, since the DB film title is spaced but
        // the Wrike project name is underscored (Angry_Birds_3_Movie).
        const norm = (s) => (s || "").toLowerCase().replace(/[_\s]+/g, " ").trim();
        const wanted = norm(filmTitle);
        const exact = projects.find((p) => norm(p.title) === wanted);
        const close = exact || projects.find((p) => {
          const t = norm(p.title);
          return wanted && (t.includes(wanted) || wanted.includes(t));
        });
        // Guard set: every folder id inside the master template. We refuse to
        // copy into it or write a field on anything within it.
        const templateIds = template ? collectSubtreeIds(byId, template.id) : new Set();
        if (alive) {
          setPlan({ field, template, studioFolder, projects, templateIds, byId });
          setTargetId(close?.id || "");
        }
      } catch (e) {
        if (alive) setError(e.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [studio, filmTitle]);

  // The chosen target project (picker selection resolved against the plan).
  const filmProject = useMemo(
    () => plan?.projects?.find((p) => p.id === targetId) || null,
    [plan, targetId]
  );
  const canApply = plan && plan.field && filmProject && (isRetag || plan.template) && !applying;

  // Slots already done — a live Wrike folder is already named with THIS job's
  // code (read straight from plan.byId, so it's accurate even for old pushes).
  // These are pre-unchecked so re-pushing only touches genuinely new slots.
  //
  // Collects every folder sharing a suffix, not just one. When two jobs sit on
  // the same slot, keeping a single title per suffix meant one job's folder
  // decided both jobs' status: whichever title survived, the other job either
  // read as done when nothing had been written for it, or read as pending while
  // its folder existed. A job is done only if a folder carries its own code.
  const doneSlots = useMemo(() => {
    const done = new Set();
    if (!plan?.byId || !filmProject) return done;
    const bySuffix = {};
    const walk = (id) => {
      const n = plan.byId[id];
      if (!n) return;
      if (/^(JOBNUMBER|XY\d+)_/i.test(n.title || "")) {
        (bySuffix[slotSuffix(n.title)] ||= []).push(n.title);
      }
      (n.childIds || []).forEach(walk);
    };
    walk(filmProject.id);
    slots.forEach((s) => {
      const live = bySuffix[slotSuffix(s.label)] || [];
      if (live.some((t) => new RegExp(`^${s.code}_`, "i").test(t))) done.add(s.id);
    });
    return done;
  }, [plan, filmProject, slots]);

  // Once the plan resolves, default the already-done slots to unchecked so the
  // common re-push does nothing redundant. Runs once; the user can re-check any.
  const inited = useRef(false);
  useEffect(() => {
    if (inited.current || !plan || !filmProject) return;
    inited.current = true;
    if (doneSlots.size) setExcluded(new Set(doneSlots));
  }, [plan, filmProject, doneSlots]);

  const apply = async () => {
    if (!canApply) return;
    setApplying(true);
    setError(null);

    // ── Template-write guard ──────────────────────────────────────────────
    // Hard stop: the master template must never be a write target. Any folder
    // id inside its subtree is off-limits both as a copy destination and as a
    // tagging target. This is defence-in-depth on top of the fact that copy is
    // read-only on its source — it makes writing to the template physically
    // impossible even if a lookup ever returned the wrong folder.
    const templateIds = plan.templateIds || new Set();
    const inTemplate = (id) => templateIds.has(id);
    const TEMPLATE_GUARD = "Aborted to protect the master template — a target folder resolved inside it. Nothing was written.";

    try {
      if (inTemplate(filmProject.id) || filmProject.id === plan.template?.id) {
        throw new Error(TEMPLATE_GUARD);
      }

      let droppedTaskFolders = [];
      // Rename-resilient map of the project's slot folders (JOBNUMBER_… or
      // already XY#####_…), keyed by stable suffix.
      setProgress({ step: "Checking the film's folders in Wrike…", done: 0, total: 1 });
      let slotFolders = await mapSlotFoldersUnder(filmProject.id);

      // Only duplicate the template when the project is genuinely empty of slot
      // folders. If it already has the structure, we rename/tag in place.
      if (Object.keys(slotFolders).length === 0) {
        if (isRetag) throw new Error("This project has no template folders yet — run Push first.");
        if (!plan.template) throw new Error(`No ${studio} master template found to copy.`);
        // Copy the template's CHILDREN straight into the film project — never the
        // template root as one film-named folder — so the film project doesn't end
        // up with a redundant wrapper folder named after itself. The template's top
        // level already IS the campaign structure (Launch/Print/…).
        const tpl = plan.byId[plan.template.id];
        const children = (tpl?.childIds || []).map((id) => plan.byId[id]).filter(Boolean);
        if (!children.length) throw new Error(`The ${studio} master template has no folders to copy.`);
        const report = { rootId: null, copies: 0, droppedTaskFolders: [] };
        for (const child of children) {
          await copyTemplateDeep({
            byId: plan.byId,
            sourceId: child.id,
            parentId: filmProject.id,
            title: child.title,
            onProgress: (step) => setProgress({ step, done: 0, total: 1 }),
            report,
          });
        }
        if (!report.copies) throw new Error("Wrike copy created nothing.");
        droppedTaskFolders = report.droppedTaskFolders || [];
        setProgress({ step: "Re-reading the copied folders…", done: 0, total: 1 });
        slotFolders = await mapSlotFoldersUnder(filmProject.id);
      }

      // Rename each activated slot's folder to its code, set the Job Number field
      // on the folder, then let Wrike cascade that value down to every subitem.
      //
      // A folder is claimed by IDENTITY, not by slot name. A slot can hold
      // several jobs on purpose, so each needs its own folder; pickSlotFolder
      // hands out the one already bearing this job's code (making a re-push a
      // no-op), else a free "JOBNUMBER_…" one, and NEVER one already carrying a
      // different job's code. A job with no folder available is reported so
      // somebody can make one — the previous version claimed by slot name and
      // could hand a job its neighbour's folder, renaming that neighbour's
      // allocation onto this code.
      const claimedIds = new Set();
      let renamed = 0, cascaded = 0, propagated = 0, failed = 0, skipped = 0, contended = 0;
      for (let i = 0; i < selectedSlots.length; i++) {
        const s = selectedSlots[i];
        const suffix = slotSuffix(s.label);
        const available = slotFolders[suffix] || [];
        const folder = pickSlotFolder(available, s.code, claimedIds);
        if (!folder) {
          // Tell "this slot has no folder at all" apart from "every folder it
          // has is already spoken for" — the first needs a template push, the
          // second needs one more folder in Wrike.
          if (available.length) contended += 1;
          else skipped += 1;
          continue;
        }
        claimedIds.add(folder.id);
        if (inTemplate(folder.id)) throw new Error(TEMPLATE_GUARD); // never write into the template

        const newTitle = `${s.code}_${suffix}`;
        setProgress({ step: `Assigning ${s.code}…`, done: i, total: slots.length });
        if (folder.title !== newTitle) { await renameFolder(folder.id, newTitle); renamed += 1; }

        // Remember which Wrike folder this job now owns, and under what name — so
        // the app can later tell "reverted/renamed in Wrike" from "never pushed"
        // (a job with no folder id was never pushed) and offer to reconcile.
        if (s.id) {
          await supabase.from("jobs")
            .update({ wrike_folder_id: folder.id, wrike_folder_title: newTitle })
            .eq("id", s.id);
        }

        // Fill the slot folder's own Job Number field, then turn on Wrike-native
        // cascading so the value flows down to every current AND future subitem
        // (nested market folders + tasks) — no per-item walk needed.
        //
        // THE FIELD CARRIES THE WHOLE FOLDER NAME, NOT THE BARE CODE.
        //
        // It used to send s.code, so a folder named
        // "XY026179_ITM_Print_Custom_Lobby_Display" cascaded a Job Number of
        // just "XY026179" — the code without the thing it identifies. Several
        // folders under one film share a code prefix and differ only in the
        // suffix, so the bare value can't say which job an item belongs to, and
        // anyone reading the field in Wrike had to go and look at the folder
        // title to find out.
        //
        // newTitle is the name the folder was just renamed to, so the two are
        // the same string by construction rather than by two rules that agree
        // today. Nothing downstream has to change: resolveJobNumber already
        // pulls the bare XY code back out of a suffixed value and returns the
        // Job Book's registered option where there is one, which is why
        // wrikeHelpers has read "XY025953_LUG_D6" shaped values all along.
        try {
          await setFolderJobNumber(folder.id, plan.field.id, newTitle);
          await triggerFieldCascade(folder.id, plan.field.id);
          cascaded += 1;
        } catch {
          failed += 1; // keep going with the remaining slots; count surfaces in the summary
        }

        // Belt-and-braces: also tag existing tasks directly. Redundant once cascade
        // is confirmed live, but harmless (same value) and safe if a field's config
        // limits cascade — remove once the cascade path is verified on the account.
        //
        // planPropagate skips a task whose value already equals what we're
        // sending, so on the first run after this change every task still
        // holding the bare code is re-stamped with the full name. That is the
        // migration, and it only happens once.
        const p = await planPropagate(folder.id, plan.field.id, newTitle);
        const r = await applyPropagate(p.willSet, plan.field.id, newTitle,
          (d, t) => setProgress({ step: `Tagging ${s.code} tasks…`, done: d, total: t }));
        propagated += r.ok.length;
        failed += r.failed.length;
      }
      setResult({ renamed, cascaded, propagated, failed, skipped, contended, droppedTaskFolders });
      notify(`Wrike updated — ${renamed} folder${renamed === 1 ? "" : "s"} named${cascaded ? `, ${cascaded} cascaded` : ""}${propagated ? `, ${propagated} task${propagated === 1 ? "" : "s"} tagged` : ""}${failed ? `, ${failed} failed` : ""}.`,
        failed ? "error" : "success");
    } catch (e) {
      setError(e.message);
    } finally {
      setApplying(false);
      setProgress(null);
    }
  };

  return (
    <WrikeApplyShell title={isRetag ? "Re-tag new items in Wrike" : "Push to Wrike"}
      subtitle={isRetag
        ? `Top up the Job Number field on new items in “${filmTitle}”`
        : `Name the activated job folders in “${filmTitle}” and tag their tasks`} onClose={onClose}>
      <div className="px-6 py-5 overflow-y-auto flex-1">
        {loading ? (
          <div className="flex items-center gap-2 text-[#768994] py-8 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Checking Wrike…
          </div>
        ) : result ? (
          <div className="py-4 space-y-3 text-center">
            <CheckCircle2 className="w-10 h-10 text-[#1cc1a5] mx-auto" />
            <p className="text-sm font-bold text-[#122027]">
              {isRetag ? `“${filmTitle}” re-tagged in Wrike.` : `“${filmTitle}” updated in Wrike.`}
            </p>
            <p className="text-xs text-[#768994]">
              {result.renamed ? `${result.renamed} folder${result.renamed === 1 ? "" : "s"} named · ` : ""}
              {result.cascaded ? `${result.cascaded} cascaded · ` : ""}
              {result.propagated} task{result.propagated === 1 ? "" : "s"} tagged
              {result.failed ? ` · ${result.failed} failed` : ""}
              {result.skipped ? ` · ${result.skipped} slot${result.skipped === 1 ? "" : "s"} had no matching folder` : ""}
              {result.contended ? ` · ${result.contended} job${result.contended === 1 ? "" : "s"} share a slot whose folder was already claimed` : ""}.
            </p>
            {result.droppedTaskFolders?.length > 0 && (
              <div className="text-left mt-2 px-3 py-2 bg-[#f4b740]/10 border border-[#f4b740]/30 rounded-xl">
                <p className="flex items-center gap-1.5 text-[11px] font-bold text-[#8a6d1a] mb-1">
                  <AlertTriangle className="w-3.5 h-3.5" /> Some container folders were too big to copy whole
                </p>
                <p className="text-[11px] text-[#8a6d1a] leading-snug">
                  Their subfolders (and all tasks inside those) came across fine, but tasks pinned directly to
                  these folders were not copied — add them by hand if needed:
                </p>
                <ul className="mt-1 text-[11px] text-[#8a6d1a] list-disc pl-4">
                  {result.droppedTaskFolders.map((d) => (
                    <li key={d.title}>{d.title} — {d.count} direct task{d.count === 1 ? "" : "s"}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <>
            <p className="text-[10px] font-black uppercase tracking-widest text-[#768994] mb-1">Preconditions</p>
            <div className="border border-[#dce4ec] rounded-2xl px-4 py-2 mb-4">
              <CheckRow ok={!!plan?.field} label="Job Number custom field"
                value={plan?.field ? `“${plan.field.title}”` : "Not found in Wrike — can't tag tasks"} />
              {!isRetag && (
                <CheckRow ok={!!plan?.template} label="Studio master template"
                  value={plan?.template ? `${plan.template.title} · ${plan.template.jobCount} job folders` : `No “${studio}” master template found`} />
              )}
              <CheckRow ok={!!filmProject} label="Target film project in Wrike"
                warn={!filmProject && (plan?.projects?.length > 0)}
                value={filmProject
                  ? `${filmProject.title} (in ${plan.studioFolder?.title || studio})`
                  : plan?.projects?.length
                    ? "Pick the matching project below"
                    : `No projects under ${studio} — sync films first`} />
            </div>

            {/* Film picker — auto-selects the closest match, but you can override
                it (handy when the Wrike project name differs slightly from the
                local film title). This is the folder the template copies into. */}
            {!!plan?.projects?.length && (
              <div className="mb-4">
                <label className="block text-[10px] font-black uppercase tracking-widest text-[#768994] mb-1.5">
                  Target project · {studio}
                </label>
                <StrictSelect
                  value={filmProject?.title || ""}
                  onChange={(title) => {
                    const p = plan.projects.find((x) => x.title === title);
                    setTargetId(p?.id || "");
                  }}
                  options={plan.projects.map((p) => p.title)}
                  placeholder={`Search ${studio} projects…`} />
                <p className="text-[10px] text-[#768994] mt-1">
                  Closest match to “{filmTitle}” is pre-selected — change it if the Wrike name differs.
                </p>
              </div>
            )}

            <p className="text-[10px] font-black uppercase tracking-widest text-[#768994] mb-2">
              {selectedSlots.length} of {slots.length} activated job{slots.length === 1 ? "" : "s"} to tag
              {doneSlots.size > 0 && <span className="text-[#1cc1a5] normal-case font-bold"> · {doneSlots.size} already tagged</span>}
            </p>
            {slots.length === 0 ? (
              <p className="text-xs text-[#768994] italic mb-2">
                No slots activated yet — the template will still be duplicated, but no tasks will be tagged.
                Activate slots first to tag their tasks with a Job Number.
              </p>
            ) : (
              <div className="border border-[#dce4ec] rounded-2xl divide-y divide-[#f0f4f8] max-h-[200px] overflow-y-auto mb-2">
                {slots.map((s) => {
                  const on = !excluded.has(s.id);
                  const done = doneSlots.has(s.id);
                  return (
                    <label key={s.id}
                      className={`flex items-center justify-between gap-2 px-4 py-2 text-[11px] cursor-pointer transition-opacity ${on ? "" : "opacity-45"}`}>
                      <span className="flex items-center gap-2 min-w-0">
                        <input type="checkbox" checked={on} onChange={() => toggleSlot(s.id)}
                          className="accent-[#12a0e1] w-3.5 h-3.5 shrink-0" />
                        <span className="text-[#122027] truncate">{s.label.replace(/^JOBNUMBER_?/i, "").replace(/_/g, " ")}</span>
                        {done && <span className="text-[9px] font-black uppercase tracking-wider text-[#1cc1a5] bg-[#1cc1a5]/10 px-1.5 py-0.5 rounded-full shrink-0">Tagged</span>}
                      </span>
                      <span className={`font-mono font-bold shrink-0 ${on ? "text-[#12a0e1]" : "text-[#768994] line-through"}`}>{s.code}</span>
                    </label>
                  );
                })}
              </div>
            )}

            {progress && (
              <div className="mt-3">
                <p className="text-xs font-bold text-[#12a0e1] mb-1.5">{progress.step}</p>
                <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full w-full bg-[#12a0e1] origin-left transition-[transform] ease-[cubic-bezier(0.16,1,0.3,1)]"
                    style={{ transform: `scaleX(${progress.total ? progress.done / progress.total : 1})` }} />
                </div>
              </div>
            )}
            {error && <p className="text-xs font-bold text-rose-500 mt-3">{error}</p>}
          </>
        )}
      </div>
      <div className="px-6 py-4 border-t border-[#dce4ec] flex items-center justify-end gap-2 shrink-0">
        <button onClick={onClose}
          className="px-5 py-2.5 text-sm font-bold text-[#768994] hover:text-[#122027] bg-white border border-[#dce4ec] rounded-xl transition-[color] ease-[cubic-bezier(0.16,1,0.3,1)]">
          {result ? "Close" : "Cancel"}
        </button>
        {!result && (
          <button onClick={apply} disabled={!canApply}
            title={!canApply && !applying ? "All preconditions above must pass first" : ""}
            className="flex items-center gap-2 px-6 py-2.5 bg-[#12a0e1] hover:bg-[#0d8bc4] text-white text-sm font-bold rounded-xl transition-[background-color] ease-[cubic-bezier(0.16,1,0.3,1)] disabled:opacity-40">
            {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UploadCloud className="w-3.5 h-3.5" />}
            Apply to Wrike
          </button>
        )}
      </div>
    </WrikeApplyShell>
  );
}
