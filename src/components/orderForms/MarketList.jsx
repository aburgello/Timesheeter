import React, { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight } from "lucide-react";
import { marketSummary, fileTotals, sortMarkets } from "../../lib/orderForms/status";
import MarketFlag from "./MarketFlag";
import { formatDay, pillClass, STATUS_CLASS, STATUS_LABEL, URGENCY_TEXT } from "./format";

// The overview: every market in the file as one row, so a PM can see who has
// confirmed and what's due without opening a tab per country.

const FILTERS = [
  { id: "confirmed", label: "Confirmed", test: (m) => m.status === "confirmed", on: "bg-[#1cc1a5] text-white border-[#1cc1a5]" },
  { id: "pending", label: "Pending", test: (m) => m.status === "pending", on: "bg-amber-500 text-white border-amber-500" },
  { id: "unconfirmed", label: "Unconfirmed", test: (m) => m.status === "unconfirmed", on: "bg-violet-600 text-white border-violet-600" },
  { id: "due", label: "Due or overdue", test: (m) => !!m.urgency, on: "bg-rose-600 text-white border-rose-600" },
  { id: "notStarted", label: "Not started", test: (m) => m.status === "notStarted", on: "bg-slate-600 text-white border-slate-600" },
];

const STATUS_ORDER = { pending: 0, unconfirmed: 1, confirmed: 2, notStarted: 3, unreadable: 4 };
const COMPARE = {
  name: (a, b) => a.name.localeCompare(b.name),
  status: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name),
  // Markets with no deadline go last whichever way the column is sorted.
  deadline: (a, b) => (a.nextDeadline || "9999").localeCompare(b.nextDeadline || "9999"),
};

const GRID = "grid grid-cols-[minmax(0,1.4fr)_120px_minmax(0,1fr)_120px_90px_20px] gap-4 items-center px-5";

function MarketName({ name }) {
  return (
    <span className="flex items-center gap-2.5 min-w-0">
      <MarketFlag name={name} />
      <span className="font-bold text-[#122027] truncate">{name}</span>
    </span>
  );
}

function SortHeader({ id, sort, onSort, children }) {
  const active = sort?.by === id;
  const Arrow = active && sort.desc ? ArrowDown : ArrowUp;
  return (
    <button onClick={() => onSort(id)} className={`flex items-center gap-1 text-left font-black uppercase tracking-widest hover:text-[#122027] ${active ? "text-[#122027]" : ""}`}>
      {children}
      {active && <Arrow className="w-3 h-3" />}
    </button>
  );
}

export default function MarketList({ file, today, onOpen }) {
  const [filter, setFilter] = useState(null);
  // null = the default order (what needs attention first).
  const [sort, setSort] = useState(null);

  const totals = useMemo(() => fileTotals(file, today), [file, today]);
  const summaries = useMemo(() => sortMarkets(file.markets.map((m) => marketSummary(m, today))), [file, today]);

  const rows = useMemo(() => {
    const test = FILTERS.find((f) => f.id === filter)?.test;
    const shown = test ? summaries.filter(test) : summaries;
    if (!sort) return shown;
    const sorted = [...shown].sort(COMPARE[sort.by]);
    return sort.desc ? sorted.reverse() : sorted;
  }, [summaries, filter, sort]);

  // Third click on a column returns to the default order.
  const onSort = (by) =>
    setSort((s) => (s?.by !== by ? { by, desc: false } : s.desc ? null : { by, desc: true }));

  const counts = { confirmed: totals.confirmed, pending: totals.pending, unconfirmed: totals.unconfirmed, due: totals.due, notStarted: totals.notStarted };

  return (
    <div className="bg-white border border-[#dce4ec] rounded-2xl shadow-sm overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-5 py-4 border-b border-[#dce4ec]">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(filter === f.id ? null : f.id)}
            aria-pressed={filter === f.id}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-sm font-bold transition-colors ${
              filter === f.id ? f.on : "bg-white border-[#dce4ec] text-[#122027] hover:border-[#9aabb5]"
            }`}
          >
            {f.label}
            <span className={filter === f.id ? "text-white/80" : "text-[#768994]"}>{counts[f.id]}</span>
          </button>
        ))}
        <p className="ml-auto text-sm text-[#768994]">
          {totals.markets} markets · {totals.orders} orders
        </p>
      </div>

      <div className={`${GRID} py-2.5 border-b border-[#dce4ec] bg-slate-50/60 text-[10px] font-black uppercase tracking-widest text-[#768994]`}>
        <SortHeader id="name" sort={sort} onSort={onSort}>Market</SortHeader>
        <SortHeader id="status" sort={sort} onSort={onSort}>Status</SortHeader>
        <span>Orders confirmed</span>
        <SortHeader id="deadline" sort={sort} onSort={onSort}>Next deadline</SortHeader>
        <span>Media ok</span>
        <span />
      </div>

      {rows.length === 0 && (
        <p className="px-5 py-10 text-center text-sm text-[#768994]">No markets match this filter.</p>
      )}

      {rows.map((m) => {
        if (m.status === "unreadable") {
          return (
            <div key={m.name} className={`${GRID} py-3 border-b border-slate-100 last:border-b-0 text-sm`}>
              <MarketName name={m.name} />
              <span><span className={`${pillClass} ${STATUS_CLASS.unreadable}`}>{STATUS_LABEL.unreadable}</span></span>
              <span className="col-span-4 text-[#768994] truncate">{m.unreadable}</span>
            </div>
          );
        }
        const pct = m.total ? Math.round((m.confirmed / m.total) * 100) : 0;
        return (
          <button
            key={m.name}
            onClick={() => onOpen(m.name)}
            className={`${GRID} w-full py-3 border-b border-slate-100 last:border-b-0 text-sm text-left hover:bg-slate-50 focus:outline-none focus-visible:bg-slate-50 transition-colors group`}
          >
            <MarketName name={m.name} />
            <span><span className={`${pillClass} ${STATUS_CLASS[m.status]}`}>{STATUS_LABEL[m.status]}</span></span>
            <span className="flex items-center gap-3 min-w-0">
              <span className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                <span className="block h-full rounded-full bg-[#1cc1a5]" style={{ width: `${pct}%` }} />
              </span>
              <span className="text-xs text-[#768994] tabular-nums shrink-0 w-14 text-right">{m.confirmed} of {m.total}</span>
            </span>
            <span className={`tabular-nums ${m.urgency ? `font-bold ${URGENCY_TEXT[m.urgency]}` : m.nextDeadline ? "text-[#122027]" : "text-[#b6c3cc]"}`}>
              {m.nextDeadline ? formatDay(m.nextDeadline, today) : "—"}
              {m.urgency === "overdue" && <span className="block text-[10px] font-black uppercase tracking-wider">Overdue</span>}
            </span>
            <span className={`tabular-nums ${m.total ? "text-[#122027]" : "text-[#b6c3cc]"}`}>
              {m.total ? `${m.mediaApproved} of ${m.total}` : "—"}
            </span>
            <ChevronRight className="w-4 h-4 text-[#b6c3cc] group-hover:text-[#122027] group-hover:translate-x-0.5 transition-[color,transform]" />
          </button>
        );
      })}
    </div>
  );
}
