// The film-code dictionary, opened from Campaign Canvas's "Codes" button.
// Discovered codes can be renamed, removed or added by hand; hardcoded ones
// live in constants.js (FILM_MAPPINGS) and win over anything here.
import { useMemo, useState } from "react";
import { Film, X, Pencil, Trash2, Check, Plus, Search } from "lucide-react";
import { FILM_MAPPINGS } from "../../constants.js";
import { confirmAction } from "../../lib/confirm";
import { isFilmCode, normalizeFilmCode } from "../../lib/filmCodes";

const badge = "text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-full border";
const input = "px-2 py-1 text-sm rounded-lg border border-[#dce4ec] outline-none focus:border-[#c2410d] bg-white text-[#122027]";

const hardcoded = FILM_MAPPINGS || {};

export default function FilmCodesPanel({ discovered = {}, onEdit, onClose }) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState("");
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const allCodes = useMemo(
    () => [...new Set([...Object.keys(hardcoded), ...Object.keys(discovered)])].sort(),
    [discovered]
  );
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allCodes;
    return allCodes.filter((c) =>
      c.toLowerCase().includes(q) || String(hardcoded[c] || discovered[c] || "").toLowerCase().includes(q));
  }, [allCodes, query, discovered]);

  const save = async (code, name) => {
    setBusy(true);
    setError("");
    try {
      await onEdit(code, name);
      return true;
    } catch (e) {
      setError(`Couldn't save: ${e.message}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveRename = async (code) => {
    const name = draft.trim();
    if (!name) return;
    if (await save(code, name)) setEditing(null);
  };

  const remove = async (code) => {
    const ok = await confirmAction({
      title: `Remove ${code}?`,
      message: `${code} will stop being read as "${discovered[code]}", and Map Films won't add it back. You can add it again by hand.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (ok) await save(code, null);
  };

  const code = normalizeFilmCode(newCode);
  const canAdd = isFilmCode(code) && newName.trim() && !hardcoded[code];
  const add = async () => {
    if (!canAdd) return;
    if (await save(code, newName.trim())) { setNewCode(""); setNewName(""); }
  };

  return (
    <div
      className="fixed inset-0 z-[300] flex items-start justify-center pt-[10vh] p-4 bg-[#122027]/60 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-3xl w-full max-w-2xl shadow-2xl flex flex-col border border-[#dce4ec] overflow-hidden max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-[#dce4ec] flex items-center justify-between bg-slate-50/50 shrink-0">
          <div className="flex items-center gap-3">
            <div className="bg-gradient-to-br from-[#c2410d] to-[#1cc1a5] p-2.5 rounded-xl text-white shadow">
              <Film className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-black text-[#122027] tracking-tight">Film Code Mappings</h3>
              <p className="text-[11px] text-[#768994] font-medium mt-0.5">
                {Object.keys(hardcoded).length} hardcoded · {Object.keys(discovered).length} discovered · {allCodes.length} total
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-[#768994] hover:text-[#122027] p-1.5 rounded-xl hover:bg-slate-100 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-3 border-b border-[#dce4ec] flex flex-wrap items-center gap-2 shrink-0">
          <div className="relative flex-1 min-w-[10rem]">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[#768994]" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search codes or films"
              className={`${input} w-full pl-7`} />
          </div>
          <input value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder="CODE"
            className={`${input} w-24 font-mono uppercase`} onKeyDown={(e) => e.key === "Enter" && add()} />
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Film name"
            className={`${input} w-40`} onKeyDown={(e) => e.key === "Enter" && add()} />
          <button onClick={add} disabled={!canAdd || busy}
            title={hardcoded[code] ? `${code} is hardcoded` : "Add a film code"}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#c2410d] text-white text-xs font-bold disabled:opacity-40">
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        </div>
        {error && <p className="px-5 py-2 text-xs text-rose-600 bg-rose-50 border-b border-rose-100">{error}</p>}

        <div className="overflow-y-auto custom-scrollbar">
          <table className="w-full text-sm table-fixed">
            <colgroup><col className="w-32" /><col /><col className="w-36" /></colgroup>
            <thead className="sticky top-0 bg-white border-b border-[#dce4ec]">
              <tr>
                <th className="text-left px-5 py-3 text-[10px] font-black tracking-widest text-[#768994] uppercase">Code</th>
                <th className="text-left px-5 py-3 text-[10px] font-black tracking-widest text-[#768994] uppercase">Film Name</th>
                <th className="text-right px-5 py-3 text-[10px] font-black tracking-widest text-[#768994] uppercase">Source</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => {
                const isHardcoded = !!hardcoded[c];
                const name = hardcoded[c] || discovered[c];
                return (
                  <tr key={c} className="group border-b border-[#dce4ec]">
                    <td className="px-5 py-3">
                      <span className="font-mono text-xs font-black text-[#122027] bg-slate-100 px-2 py-1 rounded-lg border border-slate-200">{c}</span>
                    </td>
                    <td className="px-5 py-3 font-semibold text-[#122027] truncate">
                      {editing === c ? (
                        <div className="flex items-center gap-1.5">
                          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") saveRename(c); if (e.key === "Escape") setEditing(null); }}
                            className={`${input} flex-1 min-w-0`} />
                          <button onClick={() => saveRename(c)} disabled={busy} title="Save"
                            className="p-1.5 rounded-lg bg-[#c2410d] text-white disabled:opacity-50"><Check className="w-3 h-3" /></button>
                          <button onClick={() => setEditing(null)} title="Cancel"
                            className="p-1 text-slate-400 hover:text-slate-600"><X className="w-3 h-3" /></button>
                        </div>
                      ) : name}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {isHardcoded ? (
                        <span title="Set in constants.js" className={`${badge} text-blue-600 bg-blue-50 border-blue-100`}>Hardcoded</span>
                      ) : editing !== c && (
                        <span className="inline-flex items-center gap-1">
                          <button onClick={() => { setEditing(c); setDraft(name); }} title="Rename"
                            className="p-1 rounded-lg text-slate-300 group-hover:text-[#768994] hover:!text-[#122027] hover:bg-slate-100"><Pencil className="w-3 h-3" /></button>
                          <button onClick={() => remove(c)} disabled={busy} title="Remove"
                            className="p-1 rounded-lg text-slate-300 group-hover:text-[#768994] hover:!text-red-600 hover:bg-red-50"><Trash2 className="w-3 h-3" /></button>
                          <span className={`${badge} text-emerald-600 bg-emerald-50 border-emerald-100`}>Discovered</span>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {allCodes.length === 0 && (
            <div className="p-12 text-center text-[#768994] text-sm font-medium">
              No mappings yet — run <strong>Map Films</strong> to discover them.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
