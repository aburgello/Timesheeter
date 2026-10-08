// How an item category bills when it isn't at the logger's own position: at a
// named rate card position (a designer proofreading bills as Proof Reader, an
// upload bills as Uploading), or not at all (waiting time). Shown under the
// Item Categories list.
//
// Part of Administration.
import { useState, useEffect, useCallback, useMemo } from "react";
import { Search } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { FeedSelect } from "./fields";
import { ROW_ENTER, rowEnterDelay } from "./rowEnter";

export function ItemCategoryOverrides() {
  const [roles, setRoles] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showAllCategories, setShowAllCategories] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [rr, cats] = await Promise.all([
      supabase.from("rate_roles").select("*").order("sort_order").order("name"),
      supabase.from("job_categories").select("*").order("name"),
    ]);
    setRoles(rr.data || []);
    setCategories(cats.data || []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const patchCategory = async (id, patch) => {
    setCategories(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c));
    await supabase.from("job_categories").update(patch).eq("id", id);
  };

  // Default to just the categories that actually override something — the rest
  // bill as the logger's own position and would be 60-odd rows of "same as
  // usual". Search or "Show all" reaches the whole list, since any of them can
  // be given an override.
  const visibleCategories = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q) return categories.filter(c => (c.name || "").toLowerCase().includes(q));
    if (showAllCategories) return categories;
    return categories.filter(c => c.rate_role_id || c.unbilled);
  }, [categories, search, showAllCategories]);

  const roleOptions = useMemo(
    () => roles.map(r => ({ value: String(r.id), label: r.name })),
    [roles]
  );

  if (loading) return <p className="text-sm font-bold text-[#768994] py-10 text-center">Loading…</p>;

  return (
    <div>
        <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
          <p className="text-[10px] font-black uppercase tracking-widest text-[#768994]">Item category overrides</p>
          <div className="flex items-center gap-2">
            <button type="button"
              onClick={() => { setShowAllCategories(s => !s); setSearch(""); }}
              className={`shrink-0 px-3.5 py-2.5 rounded-xl border text-xs font-bold transition-[background-color,border-color,color] ease-[cubic-bezier(0.16,1,0.3,1)] ${
                showAllCategories && !search.trim()
                  ? "bg-[#12a0e1]/10 border-[#12a0e1] text-[#12a0e1]"
                  : "bg-white border-[#dce4ec] text-[#768994] hover:border-slate-300"
              }`}>
              Show all {categories.length}
            </button>
            <div className="relative w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#b0bec5]" />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search item categories…"
                className="w-full pl-9 pr-3 py-2.5 border border-[#dce4ec] rounded-xl text-sm text-[#122027] placeholder-[#b0bec5] outline-none focus:border-[#1cc1a5] bg-white transition-colors" />
            </div>
          </div>
        </div>
        <p className="text-xs text-[#768994] mb-3">
          {search.trim() || showAllCategories
            ? "Every item category. Pick a rate card position to bill one at that rate, or mark it unbilled."
            : "Categories that don't bill at the logger's own position. Show all or search to add another."}
        </p>
        {visibleCategories.length === 0 ? (
          <p className="text-sm text-[#768994] bg-slate-50 border border-dashed border-[#dce4ec] rounded-2xl px-4 py-8 text-center">
            {search.trim() ? "No item category matches that." : "No overrides set."}
          </p>
        ) : (
          <div className="space-y-1.5">
            {visibleCategories.map((c, i) => (
              <div key={c.id} style={rowEnterDelay(i)}
                className={`${ROW_ENTER} flex items-center gap-3 p-3.5 bg-white border rounded-2xl
                            transition-[transform,box-shadow,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]
                            hover:-translate-y-px hover:shadow-[0_6px_18px_-8px_rgba(18,32,39,0.18)] ${
                  c.unbilled ? "border-[#f4b740]/40" : "border-[#dce4ec] hover:border-slate-300"
                }`}>
                <span className="flex-1 min-w-0 text-[15px] font-semibold text-[#122027] truncate">{c.name}</span>
                <FeedSelect
                  value={c.rate_role_id ? String(c.rate_role_id) : ""}
                  onChange={(v) => patchCategory(c.id, { rate_role_id: v ? Number(v) : null })}
                  allLabel="Logger's own position"
                  className={`w-[220px] shrink-0 transition-opacity duration-300 ${c.unbilled ? "opacity-40" : ""}`}
                  options={roleOptions}
                />
                {/* Unbilled wins over any rate override, so the select goes
                    muted rather than pretending it still applies. */}
                <button type="button"
                  onClick={() => patchCategory(c.id, { unbilled: !c.unbilled })}
                  className={`shrink-0 px-3 py-2.5 rounded-xl border text-xs font-bold transition-[background-color,border-color,color] ease-[cubic-bezier(0.16,1,0.3,1)] ${
                    c.unbilled
                      ? "bg-[#f4b740]/10 border-[#f4b740] text-[#8a6d1a]"
                      : "bg-white border-[#dce4ec] text-[#768994] hover:border-slate-300"
                  }`}>
                  Unbilled
                </button>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}
