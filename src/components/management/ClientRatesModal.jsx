// One client's rate card: an hourly rate for each rate card position, in the
// client's currency. A position left blank isn't on this client's card, and
// time that bills as it shows unpriced in Project/Time.
//
// The Hours column is a scratch pad for a quick quote. Only rates are saved.
//
// Part of Administration.
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { motion, animate } from "framer-motion";
import { X, Check, Loader2 } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { confirmAction } from "../../lib/confirm";
import { CURRENCIES, currencySymbol, formatMoney, quoteTotals } from "../../lib/rateCards";
import { FeedSelect } from "./fields";

const CELL_INPUT =
  "w-full py-2 rounded-xl border border-[#dce4ec] bg-white outline-none text-sm font-bold tabular-nums text-[#122027] placeholder-[#b0bec5] transition-colors focus:border-[#12a0e1]";

const asText = (n) => (n == null ? "" : String(Number(n)));

// The quote total rolls to its new value instead of jumping.
function RollingMoney({ value, currency }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const controls = animate(from.current, value, {
      duration: 0.35,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => { from.current = v; setShown(v); },
    });
    return () => controls.stop();
  }, [value]);
  return formatMoney(shown, currency);
}

export function ClientRatesModal({ client, onClose, onChanged }) {
  const [roles, setRoles] = useState([]);
  const [rates, setRates] = useState({});
  const [hours, setHours] = useState({});
  const [currency, setCurrency] = useState(client.currency || "USD");
  const [others, setOthers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // The rate that was just saved, for a moment, so its field can say so.
  const [justSaved, setJustSaved] = useState(null);
  const savedTimer = useRef(null);
  useEffect(() => () => clearTimeout(savedTimer.current), []);
  const lastSaved = useRef({});

  const load = useCallback(async () => {
    setLoading(true);
    const [rr, all, clients] = await Promise.all([
      supabase.from("rate_roles").select("*").order("sort_order").order("name"),
      supabase.from("client_rates").select("client_id, rate_role_id, hourly_rate"),
      supabase.from("clients").select("id, name, currency").order("name"),
    ]);
    if (rr.error || all.error || clients.error) setError("Couldn't load the rate card.");
    const rows = all.data || [];
    setRoles(rr.data || []);
    const mine = Object.fromEntries(rows.filter((r) => r.client_id === client.id).map((r) => [r.rate_role_id, asText(r.hourly_rate)]));
    lastSaved.current = mine;
    setRates(mine);
    const withRates = new Set(rows.map((r) => r.client_id));
    setOthers((clients.data || []).filter((c) => c.id !== client.id && withRates.has(c.id)));
    setLoading(false);
  }, [client.id]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fail = (err) => { if (err) setError("That change wasn't saved. Check your connection and try again."); return !!err; };

  // Blank takes the position off this client's card.
  const saveRate = async (roleId) => {
    const n = parseFloat(rates[roleId]);
    const next = isNaN(n) || n < 0 ? "" : String(n);
    if (next === "") setRates((prev) => ({ ...prev, [roleId]: "" }));
    if (next === (lastSaved.current[roleId] ?? "")) return;
    setError("");
    const { error: err } = next === ""
      ? await supabase.from("client_rates").delete().eq("client_id", client.id).eq("rate_role_id", roleId)
      : await supabase.from("client_rates")
          .upsert({ client_id: client.id, rate_role_id: roleId, hourly_rate: n }, { onConflict: "client_id,rate_role_id" });
    if (fail(err)) return;
    lastSaved.current = { ...lastSaved.current, [roleId]: next };
    setJustSaved(roleId);
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setJustSaved(null), 1400);
    onChanged?.();
  };

  const saveCurrency = async (code) => {
    setError("");
    setCurrency(code);
    const { error: err } = await supabase.from("clients").update({ currency: code }).eq("id", client.id);
    if (!fail(err)) onChanged?.({ currency: code });
  };

  const copyFrom = async (sourceId) => {
    const source = others.find((c) => String(c.id) === sourceId);
    if (!source) return;
    if (Object.values(rates).some((v) => v !== "")) {
      const ok = await confirmAction({
        title: `Replace this rate card with ${source.name}'s?`,
        message: `Every rate on ${client.name}'s card is replaced, and its currency becomes ${source.currency}.`,
        confirmLabel: "Replace",
        danger: true,
      });
      if (!ok) return;
    }
    setError("");
    const { data, error: readErr } = await supabase.from("client_rates").select("rate_role_id, hourly_rate").eq("client_id", source.id);
    if (fail(readErr)) return;
    const { error: delErr } = await supabase.from("client_rates").delete().eq("client_id", client.id);
    if (fail(delErr)) return;
    const { error: insErr } = await supabase.from("client_rates")
      .insert((data || []).map((r) => ({ client_id: client.id, rate_role_id: r.rate_role_id, hourly_rate: r.hourly_rate })));
    if (fail(insErr)) { load(); return; }
    await saveCurrency(source.currency);
    load();
  };

  const symbol = currencySymbol(currency);
  const totals = useMemo(
    () => quoteTotals(roles.map((r) => ({ rate: rates[r.id] ?? "", hours: hours[r.id] ?? "" }))),
    [roles, rates, hours]
  );
  const otherOptions = useMemo(() => others.map((c) => ({ value: String(c.id), label: c.name })), [others]);

  return (
    <div
      className="fixed inset-0 z-[9999] bg-[#122027]/60 backdrop-blur-sm flex items-start justify-center p-4 sm:p-8 overflow-y-auto animate-in fade-in duration-200"
      onMouseDown={onClose}
    >
      <div
        role="dialog" aria-modal="true" aria-label={`${client.name} rate card`}
        className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl my-4 flex flex-col border border-[#dce4ec] animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-5 pb-4 border-b border-[#dce4ec] flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[9px] font-black uppercase tracking-widest text-[#12a0e1] mb-0.5">Rate card</p>
            <h2 className="text-xl font-black text-[#122027] truncate">{client.name}</h2>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="p-2 hover:bg-slate-100 rounded-xl text-slate-400 hover:text-slate-600 transition-colors shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-[#768994] text-sm font-bold">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="px-6 py-5">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-xl">
                {CURRENCIES.map((c) => (
                  <button key={c.code} type="button" onClick={() => saveCurrency(c.code)}
                    className={`relative px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                      currency === c.code ? "text-[#122027]" : "text-[#768994] hover:text-[#122027]"
                    }`}>
                    {currency === c.code && (
                      <motion.span layoutId="rate-card-currency" className="absolute inset-0 rounded-lg bg-white shadow-sm"
                        transition={{ type: "spring", stiffness: 500, damping: 38 }} />
                    )}
                    <span className="relative">{c.code}</span>
                  </button>
                ))}
              </div>
              {otherOptions.length > 0 && (
                <FeedSelect value="" onChange={copyFrom} options={otherOptions} allLabel="Copy from another client" className="w-[240px]" />
              )}
            </div>

            {error && <p className="mb-3 text-xs font-bold text-rose-500">{error}</p>}

            {roles.length === 0 ? (
              <p className="text-sm text-[#768994] bg-slate-50 border border-dashed border-[#dce4ec] rounded-2xl px-4 py-8 text-center">
                No rate card positions yet. Add them under Client Accounts → Rate Card Positions.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] font-black uppercase tracking-widest text-[#768994]">
                    <th className="text-left font-black pb-2">Position</th>
                    <th className="text-left font-black pb-2 w-32">Hourly rate</th>
                    <th className="text-left font-black pb-2 w-24 pl-2">Hours</th>
                    <th className="text-right font-black pb-2 w-28">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {roles.map((r, i) => {
                    const rate = rates[r.id] ?? "";
                    const hrs = hours[r.id] ?? "";
                    const line = rate !== "" && Number(hrs) > 0 ? Number(rate) * Number(hrs) : null;
                    return (
                      <motion.tr key={r.id}
                        initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.3, delay: 0.04 + i * 0.025, ease: [0.16, 1, 0.3, 1] }}
                        className="border-t border-slate-100 [&:last-child>td]:pb-3.5">
                        <td className={`py-1.5 pr-3 font-semibold transition-colors duration-300 ${rate === "" ? "text-[#9aa8b4]" : "text-[#122027]"}`}>{r.name}</td>
                        <td className="py-1.5">
                          <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-bold text-[#b0bec5] select-none pointer-events-none">{symbol}</span>
                            <input
                              type="number" min="0" step="0.01" inputMode="decimal"
                              aria-label={`${r.name} hourly rate`}
                              value={rate}
                              placeholder="Not on card"
                              onChange={(e) => setRates((prev) => ({ ...prev, [r.id]: e.target.value }))}
                              onBlur={() => saveRate(r.id)}
                              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                              className={`${CELL_INPUT} pr-2 placeholder:font-medium placeholder:text-xs ${justSaved === r.id ? "!border-[#1cc1a5]" : ""}`}
                              style={{ paddingLeft: `${0.9 + symbol.length * 0.55}rem` }}
                            />
                            {justSaved === r.id && (
                              <motion.span
                                initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }}
                                transition={{ type: "spring", stiffness: 600, damping: 22 }}
                                className="absolute -right-1.5 -top-1.5 w-4 h-4 rounded-full bg-[#1cc1a5] text-white flex items-center justify-center shadow-sm pointer-events-none">
                                <Check className="w-2.5 h-2.5" strokeWidth={4} />
                              </motion.span>
                            )}
                          </div>
                        </td>
                        <td className="py-1.5 pl-2">
                          <input
                            type="number" min="0" step="0.25" inputMode="decimal"
                            aria-label={`${r.name} hours`}
                            value={hrs}
                            onChange={(e) => setHours((prev) => ({ ...prev, [r.id]: e.target.value }))}
                            className={`${CELL_INPUT} px-3`}
                          />
                        </td>
                        <td className="py-1.5 text-right font-bold tabular-nums text-[#122027]">
                          {line == null ? <span className="text-[#cbd5e1]">—</span> : (
                            <motion.span key={line} className="inline-block"
                              initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
                              {formatMoney(line, currency)}
                            </motion.span>
                          )}
                        </td>
                      </motion.tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-[#dce4ec]">
                    <td className="pt-5 text-[10px] font-black uppercase tracking-widest text-[#768994]" colSpan={2}>Quote total</td>
                    <td className="pt-5 pl-2 font-bold tabular-nums text-[#122027]">{totals.hours || 0}</td>
                    <td className="pt-5 text-right font-display text-lg font-black tabular-nums text-[#122027]"><RollingMoney value={totals.total} currency={currency} /></td>
                  </tr>
                </tfoot>
              </table>
            )}

            <p className="mt-4 text-xs text-[#768994]">
              Rates save as you leave each field. Hours are for a quick quote and aren't saved.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
