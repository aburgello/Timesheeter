// Film sync: preview, then add, films from Wrike's studio projects.
//
// Part of Administration. Split out of components/Management.jsx, which is
// still the entry point and re-exports what other screens import.
import { useState, useEffect } from "react";
import { Film, CheckCircle2, FolderOpen, Loader2, Download } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { notify } from "../../lib/toast";
import { planFilmSync } from "../../lib/wrikeCampaign";
import { STUDIO_OPTIONS } from "./constants";
import { WrikeApplyShell } from "./WrikeApplyShell";

// Req 6 — preview + apply the Film DB sync from Wrike's studio-folder projects.
// Read-only until "Add N films": additive only (never deletes local films).
export function FilmSyncModal({ studio: initialStudio = "Paramount", existingFilms, onClose, onApplied }) {
  const [studio, setStudio] = useState(initialStudio);
  const [plan, setPlan] = useState(null); // { error, studioFolder, projectCount, toAdd }
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setPlan(null);
    planFilmSync(studio, existingFilms)
      .then((p) => alive && setPlan(p))
      .catch((e) => alive && setPlan({ error: e.message, toAdd: [] }))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [studio, existingFilms]);

  const apply = async () => {
    if (!plan?.toAdd?.length) return;
    setApplying(true);
    const rows = plan.toAdd.map((title) => ({ title, studio }));
    const { error } = await supabase.from("films").insert(rows);
    setApplying(false);
    if (error) { notify("Film sync failed: " + error.message, "error"); return; }
    notify(`Added ${rows.length} film${rows.length === 1 ? "" : "s"} from Wrike.`, "success");
    onApplied?.();
    onClose();
  };

  return (
    <WrikeApplyShell title="Sync films from Wrike" accent="#1cc1a5"
      subtitle={`Projects inside the ${studio} folder → Films`} onClose={onClose}>
      <div className="px-6 py-5 overflow-y-auto flex-1">
        {/* Which studio folder to pull film projects from. */}
        <div className="flex items-center gap-2 mb-4">
          <span className="text-[10px] font-black uppercase tracking-widest text-[#768994] mr-1">Studio</span>
          {STUDIO_OPTIONS.map((s) => (
            <button key={s} onClick={() => setStudio(s)}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-[background-color,border-color,color] ease-[cubic-bezier(0.16,1,0.3,1)] ${
                studio === s
                  ? "bg-[#122027] text-white border-[#122027]"
                  : "bg-white text-[#122027] border-[#dce4ec] hover:border-[#1cc1a5]"
              }`}>
              {s}
            </button>
          ))}
        </div>
        {loading ? (
          <div className="flex items-center gap-2 text-[#768994] py-8 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Reading {studio} projects from Wrike…
          </div>
        ) : plan?.error ? (
          <div className="text-sm font-bold text-rose-500 py-6 text-center">{plan.error}</div>
        ) : (
          <>
            <div className="flex items-center gap-2 text-xs text-[#768994] mb-4">
              <FolderOpen className="w-4 h-4 text-[#f4b740]" />
              Found <span className="font-bold text-[#122027]">{plan.studioFolder?.title}</span> ·
              {" "}{plan.projectCount} project{plan.projectCount === 1 ? "" : "s"} in Wrike
            </div>
            {plan.toAdd.length === 0 ? (
              <div className="flex items-center gap-2 text-sm font-bold text-[#1cc1a5] py-6 justify-center">
                <CheckCircle2 className="w-4 h-4" /> Films are already in sync — nothing to add.
              </div>
            ) : (
              <>
                <p className="text-[10px] font-black uppercase tracking-widest text-[#768994] mb-2">
                  {plan.toAdd.length} new film{plan.toAdd.length === 1 ? "" : "s"} to add
                </p>
                <div className="border border-[#dce4ec] rounded-2xl divide-y divide-[#f0f4f8] max-h-[320px] overflow-y-auto">
                  {plan.toAdd.map((t) => (
                    <div key={t} className="flex items-center gap-2 px-4 py-2 text-sm text-[#122027]">
                      <Film className="w-3.5 h-3.5 text-[#12a0e1] shrink-0" /> {t}
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
      <div className="px-6 py-4 border-t border-[#dce4ec] flex items-center justify-end gap-2 shrink-0">
        <button onClick={onClose}
          className="px-5 py-2.5 text-sm font-bold text-[#768994] hover:text-[#122027] bg-white border border-[#dce4ec] rounded-xl transition-[color] ease-[cubic-bezier(0.16,1,0.3,1)]">
          Cancel
        </button>
        <button onClick={apply} disabled={applying || loading || !plan?.toAdd?.length}
          className="flex items-center gap-2 px-6 py-2.5 bg-[#1cc1a5] hover:bg-[#17a892] text-white text-sm font-bold rounded-xl transition-[background-color] ease-[cubic-bezier(0.16,1,0.3,1)] disabled:opacity-40">
          {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
          {plan?.toAdd?.length ? `Add ${plan.toAdd.length} film${plan.toAdd.length === 1 ? "" : "s"}` : "Nothing to add"}
        </button>
      </div>
    </WrikeApplyShell>
  );
}
