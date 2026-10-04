// Translation countries, and the other spellings of each
// country name that imports and pulls should recognise.
//
// Part of Administration. Split out of components/Management.jsx, which is
// still the entry point and re-exports what other screens import.
import { useState, useEffect, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { Tag, X } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { builtInAliasesFor } from "../../utils/countryCodes";
import { loadCountryAliases } from "../../lib/countryAliases";
import { SimpleListSection } from "./SimpleListSection";

// ── Country alias editor ─────────────────────────────────────────────────────
// One row's worth of aliases, shown inline against its country in Translation
// Countries. Two kinds sit side by side:
//
//   built-in  — read from CODE_LOOKUP itself (builtInAliasesFor), so what's
//               shown is what actually resolves rather than a second list that
//               can drift from it. Not editable here; they live in constants.js
//               and include MAGI's own sheet, which stays a verbatim copy.
//   curated   — rows in country_aliases, added freely and removed freely. They
//               are consulted FIRST, so adding one that matches a built-in
//               re-points it, and adding a new one extends the set.
//
// Uniqueness is global and normalised (upper, punctuation stripped) because an
// alias is a lookup key: "BE-FL" and "befl" are the same key, and two rows
// claiming it would make resolution depend on row order. The DB enforces it;
// this checks first so the failure is a sentence rather than a constraint error.
const ALIAS_KEY = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
// The eight codes that are also ordinary English words. Adding one of these as
// an alias is allowed — production may have a good reason — but it's called out,
// because these are the codes that read countries out of prose when they land
// somewhere unanchored (see countryCodes.js and the Norway incident).
const RISKY_ALIAS_KEYS = new Set(["NO", "IN", "IT", "AT", "BE", "US", "IS", "MY"]);
// `open`/`onToggle`/`onClose` are owned by the list, not by each row, so only
// one panel can be open at a time — three of these stacked over each other was
// the first thing that went wrong on screen.
function CountryAliasEditor({ territory, aliases, onChanged, open, onToggle, onClose }) {
  const [adding, setAdding] = useState("");
  const [busy, setBusy]     = useState(false);
  const [err, setErr]       = useState("");

  // A centred modal rather than a popover anchored to its row. Anchoring was
  // tried twice — nested (clipped by the list) and portaled with computed
  // coordinates (landed rows above its own row under the html{zoom:1.1} the
  // app ran at then) — and it
  // was never buying much: the panel names the country in its heading, so it
  // doesn't need to touch the row to say what it belongs to. This drops the
  // whole coordinate problem, can't clip, and reuses the modal shell the rest
  // of this file already uses, which the dark-theme sheet covers.
  //
  // Escape closes it; click-away is handled by the modal backdrop below.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && onClose?.();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // A half-typed alias and its error shouldn't be waiting there next time.
  useEffect(() => {
    if (!open) { setAdding(""); setErr(""); }
  }, [open]);

  const builtIn = useMemo(() => builtInAliasesFor(territory), [territory]);
  const mine    = aliases || [];

  const add = async () => {
    const value = adding.trim();
    if (!value) return;
    const key = ALIAS_KEY(value);
    if (!key) { setErr("An alias needs at least one letter or number."); return; }

    const clash = mine.find((a) => ALIAS_KEY(a.alias) === key);
    if (clash) { setErr(`"${clash.alias}" is already on this country.`); return; }

    setBusy(true); setErr("");
    const { error } = await supabase
      .from("country_aliases")
      .insert({ alias: value, territory });
    setBusy(false);

    if (error) {
      // The unique index is on the normalised alias across every country, so
      // the usual cause is that another country already claims this code.
      setErr(
        error.code === "23505"
          ? `"${value}" is already used as an alias for another country.`
          : "Couldn't save that alias."
      );
      return;
    }
    setAdding("");
    onChanged?.();
  };

  const remove = async (id) => {
    setBusy(true);
    await supabase.from("country_aliases").delete().eq("id", id);
    setBusy(false);
    onChanged?.();
  };

  const riskyPending = RISKY_ALIAS_KEYS.has(ALIAS_KEY(adding));

  return (
    <div className="shrink-0 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      {mine.slice(0, open ? mine.length : 3).map((a) => (
        <span key={a.id}
          className="px-1.5 py-0.5 rounded-md bg-[#12a0e1]/10 text-[#0d8bc4] text-[10px] font-bold tracking-wide">
          {a.alias}
        </span>
      ))}
      {!open && mine.length > 3 && (
        <span className="text-[10px] font-bold text-[#768994]">+{mine.length - 3}</span>
      )}
      <button
        onClick={onToggle}
        title={`Aliases for ${territory}`}
        className="p-1 rounded-lg text-slate-400 hover:text-[#12a0e1] hover:bg-slate-100"
      >
        <Tag className="w-3 h-3" />
      </button>

      {open && createPortal(
        // Same shell as this file's other modals, so the dark-theme sheet —
        // which keys off Tailwind class names — covers it without any
        // per-element dark styling here. onMouseDown, like the others: closes
        // before blur rather than racing it.
        <div className="fixed inset-0 z-[9999] bg-[#122027]/60 backdrop-blur-sm flex items-center justify-center p-4"
          onMouseDown={() => onClose?.()}>
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md border border-[#dce4ec] overflow-hidden text-left"
            onMouseDown={(e) => e.stopPropagation()}>

            <div className="px-5 pt-4 pb-3 border-b border-[#dce4ec]">
              <p className="text-[9px] font-black uppercase tracking-widest text-[#12a0e1] mb-0.5">Aliases</p>
              <h2 className="text-lg font-black text-[#122027]">{territory}</h2>
            </div>

            <div className="p-5">
              <div className="flex gap-2 mb-3">
                <input
                  autoFocus
                  value={adding}
                  onChange={(e) => { setAdding(e.target.value); setErr(""); }}
                  onKeyDown={(e) => e.key === "Enter" && add()}
                  placeholder="Add alias…"
                  className="flex-1 min-w-0 text-sm border border-[#dce4ec] rounded-lg px-3 py-1.5 outline-none focus:border-[#12a0e1] focus:ring-2 focus:ring-[#12a0e1]/20 bg-white text-[#122027]"
                />
                <button onClick={add} disabled={busy || !adding.trim()}
                  className="shrink-0 px-3 py-1.5 rounded-lg bg-[#12a0e1] text-white text-xs font-bold hover:bg-[#0d8bc4] disabled:opacity-40">
                  Add
                </button>
              </div>

              {riskyPending && (
                <p className="text-[11px] text-yellow-700 bg-yellow-50 border border-yellow-200 rounded-lg px-2.5 py-2 mb-3">
                  “{adding.trim()}” is also an ordinary English word. It'll be
                  read as {territory} wherever someone writes it deliberately —
                  at the end of a task name, on a folder, in the Country field —
                  but it stays refused in unidentified custom fields, which is
                  what stopped a boolean “No” being read as Norway.
                </p>
              )}
              {err && <p className="text-[11px] text-rose-600 mb-3">{err}</p>}

              {mine.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-4">
                  {mine.map((a) => (
                    <span key={a.id}
                      className="group/alias inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-blue-50 text-blue-700 text-xs font-bold">
                      {a.alias}
                      <button onClick={() => remove(a.id)} disabled={busy}
                        className="text-slate-400 hover:text-rose-500">
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {builtIn.length > 0 && (
                <>
                  <p className="text-[9px] font-black uppercase tracking-widest text-[#768994] mb-1.5">
                    Built in
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {builtIn.map((b) => (
                      <span key={b} title="Defined in code — add the same alias above to re-point it"
                        className="px-2 py-1 rounded-lg bg-slate-200 text-slate-700 text-xs font-bold">
                        {b}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
// Translation Countries + their aliases. Wraps the generic list rather than
// extending it: the alias rows are a second table, fetched once for the whole
// list here instead of once per row, and re-read after every edit so the
// resolver's overlay and the UI never disagree about what's saved.
export function TranslationCountriesSection() {
  const [byTerritory, setByTerritory] = useState({});
  // Which row's alias panel is open — one at a time, owned here.
  const [openFor, setOpenFor] = useState(null);
  // Stable identity, so the editor's click-away listener isn't torn down and
  // rebuilt on every render of the list.
  const closePanel = useCallback(() => setOpenFor(null), []);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("country_aliases")
      .select("id,alias,territory")
      .order("alias");
    const grouped = {};
    for (const row of data || []) (grouped[row.territory] ||= []).push(row);
    setByTerritory(grouped);
    // Push the same rows into the resolver, so an alias added here is live for
    // the next Wrike pull without a reload.
    await loadCountryAliases({ force: true });
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <SimpleListSection
      table="translation_countries"
      labelField="name"
      label="Translation Countries"
      placeholder="e.g. France…"
      renderRowExtra={(item) => (
        <CountryAliasEditor
          territory={item.name}
          aliases={byTerritory[item.name]}
          onChanged={load}
          open={openFor === item.name}
          onToggle={() => setOpenFor((cur) => (cur === item.name ? null : item.name))}
          onClose={closePanel}
        />
      )}
    />
  );
}
