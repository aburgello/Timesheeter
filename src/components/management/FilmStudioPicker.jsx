// The studio picker on each film in the Films list.
//
// Part of Administration. Split out of components/Management.jsx, which is
// still the entry point and re-exports what other screens import.
import { supabase } from "../../lib/supabaseClient";
import { notify } from "../../lib/toast";
import { STUDIO_LIST } from "./constants";

// Row control on the Films page: set/clear which studio a film belongs to, so
// the Job Setup film picker groups it correctly. A plain inline select that
// writes straight back on change. A film whose studio is somehow outside the
// canonical list (future studio, manual SQL) keeps its value as an option so it
// isn't silently dropped the moment the row is touched.
export function FilmStudioPicker({ item, patchItem }) {
  const studioOptions = item.studio && !STUDIO_LIST.includes(item.studio)
    ? [item.studio, ...STUDIO_LIST]
    : STUDIO_LIST;
  return (
    <div className="w-32 shrink-0">
      <select
        value={item.studio || ""}
        onChange={async (e) => {
          const v = e.target.value || null;
          patchItem(item.id, { studio: v });
          const { error } = await supabase.from("films").update({ studio: v }).eq("id", item.id);
          if (error) notify("Couldn't update studio: " + error.message, "error");
        }}
        className="w-full text-xs font-bold text-[#122027] bg-white border border-[#dce4ec] rounded-lg px-2 py-1.5 outline-none focus:border-[#12a0e1] focus:ring-2 focus:ring-[#12a0e1]/20"
        title="Studio — where this film sits in the Job Setup film picker">
        <option value="">— no studio —</option>
        {studioOptions.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    </div>
  );
}
