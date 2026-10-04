// A film's jobs, opened from the Films list: Jobs setup locked to
// that one film.
//
// Part of Administration. Split out of components/Management.jsx, which is
// still the entry point and re-exports what other screens import.
import { useState, useEffect } from "react";
import { Film, X, Loader2 } from "lucide-react";
import { fetchAllFolders, findFilmLocation } from "../../lib/wrikeCampaign";
import { JobsSetupSection } from "./JobsSetupSection";

// A film's bulk campaign, opened straight from the Films list instead of going
// to Bulk Campaign and re-picking studio + film.
//
// It renders the real JobsSetupSection with its pickers locked, rather than a
// read-only imitation: activate, push, re-tag and the session review all work
// exactly as they do on the Bulk Campaign page, because they ARE that page. A
// separate view would have been a second implementation to keep in step, and
// would have drifted the first time either side changed. (Defined here rather
// than in its own file purely because importing JobsSetupSection from outside
// Management would form an import cycle.)
//
// The only thing this adds is resolving the film's studio, which the films
// table doesn't store — a film project's parent folder in Wrike IS its studio.
export function FilmCampaignModal({ filmTitle, onClose }) {
  const [studio, setStudio] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        if (!localStorage.getItem("wrike_user_id")) {
          throw new Error("Wrike isn't connected — connect it in Profile → Settings first.");
        }
        const byId = await fetchAllFolders();
        const loc = findFilmLocation(byId, filmTitle);
        if (!loc) throw new Error(`No “${filmTitle}” project found in Wrike. It may not have been created there yet.`);
        if (!loc.studio) throw new Error(`Found “${filmTitle}” in Wrike, but it isn't inside a studio folder — can't tell which template applies.`);
        if (!alive) return;
        setStudio(loc.studio);
      } catch (e) {
        if (alive) setError(e.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [filmTitle]);

  return (
    <div
      className="fixed inset-0 z-[9999] bg-[#122027]/60 backdrop-blur-sm flex items-start justify-center p-4 sm:p-8 overflow-y-auto"
      onMouseDown={onClose}
    >
      <div
        className="bg-white rounded-3xl shadow-2xl w-full max-w-6xl my-4 flex flex-col overflow-hidden border border-[#dce4ec]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-5 pb-4 border-b border-[#dce4ec] flex items-start justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <p className="text-[9px] font-black uppercase tracking-widest text-[#12a0e1] mb-0.5">
              Bulk campaign · live from Wrike
            </p>
            <h2 className="text-xl font-black text-[#122027] truncate flex items-center gap-2">
              <Film className="w-4 h-4 text-[#768994] shrink-0" />
              {filmTitle}
            </h2>
            {studio && <p className="text-xs text-[#768994] mt-0.5">{studio}</p>}
          </div>
          <button onClick={onClose}
            className="p-2 hover:bg-slate-100 rounded-xl text-slate-400 hover:text-slate-600 transition-colors shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-5">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[#768994]">
              <Loader2 className="w-4 h-4 animate-spin" /> Finding “{filmTitle}” in Wrike…
            </div>
          ) : error ? (
            <div className="py-12 text-center">
              <p className="text-sm font-bold text-red-500">{error}</p>
            </div>
          ) : (
            <JobsSetupSection initialStudio={studio} initialFilm={filmTitle} lockPickers />
          )}
        </div>
      </div>
    </div>
  );
}
