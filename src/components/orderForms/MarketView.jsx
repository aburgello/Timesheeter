import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { motion } from "framer-motion";
import { marketSummary, orderUrgency } from "../../lib/orderForms/status";
import { findTask } from "../../lib/orderForms/wrikeMatch";
import OrderPanel from "./OrderPanel";
import MarketFlag from "./MarketFlag";
import { pillClass, undatedNote, STATUS_CLASS, STATUS_LABEL } from "./format";

// One market: its orders down the left, the selected order's details on the
// right. Up and down step through the list, the way a PM checks a market.
export default function MarketView({ market, kind, today, wrikeIndex, wrikeParents, onBack }) {
  const orders = market.orders;
  const [selected, setSelected] = useState(0);
  const listRef = useRef(null);
  const summary = marketSummary(market, today);
  const tasks = orders.map((o) => findTask(wrikeIndex, o));
  const inWrike = tasks.filter(Boolean).length;

  useEffect(() => setSelected(0), [market.name]);

  const onKeyDown = (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const next = Math.min(orders.length - 1, Math.max(0, selected + (e.key === "ArrowDown" ? 1 : -1)));
    setSelected(next);
    listRef.current?.querySelector(`[data-order="${next}"]`)?.focus();
  };

  const order = orders[selected];

  return (
    <div className="bg-white border border-[#dce4ec] rounded-2xl shadow-sm overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-5 py-4 border-b border-[#dce4ec]">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 pl-2 pr-3 py-1.5 -ml-2 rounded-lg text-sm font-bold text-[#768994] hover:text-[#122027] hover:bg-slate-100 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          All markets
        </button>
        <h2 className="flex items-center gap-2.5 font-display text-xl font-bold tracking-tight text-[#122027]">
          <MarketFlag name={market.name} className="w-7 h-5" />
          {market.name}
        </h2>
        <span className={`${pillClass} ${STATUS_CLASS[summary.status]}`}>{STATUS_LABEL[summary.status]}</span>
        <p className="ml-auto text-sm text-[#768994]">
          {summary.total} {summary.total === 1 ? "order" : "orders"} · {summary.confirmed} confirmed
          {inWrike > 0 && ` · ${inWrike} in Wrike`}
          {summary.undated > 0 && ` · ${undatedNote(summary.undated)}`}
        </p>
        {market.sheetUrl && (
          <a
            href={market.sheetUrl}
            target="_blank"
            rel="noreferrer"
            title={market.sheetName}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#dce4ec] hover:border-[#12a0e1] text-sm font-bold text-[#122027] transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Open sheet
          </a>
        )}
      </div>

      {orders.length === 0 ? (
        <p className="px-5 py-16 text-center text-sm text-[#768994]">
          No orders with a delivery deadline yet.
          {summary.undated > 0 && ` ${undatedNote(summary.undated)}.`}
        </p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(360px,440px)]">
          <div ref={listRef} role="listbox" aria-label={`${market.name} orders`} onKeyDown={onKeyDown} className="lg:border-r border-[#dce4ec]">
            {orders.map((o, i) => {
              const active = i === selected;
              const urgency = orderUrgency(o, today);
              return (
                <button
                  key={i}
                  data-order={i}
                  role="option"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  onClick={() => setSelected(i)}
                  className={`relative isolate w-full flex items-center gap-3 px-5 py-3 border-b border-slate-100 text-left text-sm focus:outline-none transition-colors ${
                    active ? "" : "hover:bg-slate-50 focus-visible:bg-slate-50"
                  }`}
                >
                  {/* One highlight shared by the list (layoutId), so it slides
                      to the next order instead of blinking off one and on
                      another. Behind the row's content: the row is its own
                      stacking context (isolate) and this sits at its back. */}
                  {active && (
                    <motion.span
                      layoutId="order-highlight"
                      aria-hidden="true"
                      className="absolute inset-0 -z-10 bg-[#12a0e1]/10"
                      transition={{ type: "tween", duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                    />
                  )}
                  <span className={`${pillClass} bg-slate-100 text-slate-600 w-16 justify-center shrink-0`}>{o.placement || "—"}</span>
                  <span className={`flex-1 min-w-0 truncate ${active ? "font-bold text-sky-600" : "text-[#122027]"}`}>
                    {o.siteName || <span className="text-[#9aabb5]">No site name</span>}
                  </span>
                  <span className="text-[#768994] tabular-nums shrink-0 hidden sm:block">
                    {o.width && o.height ? `${o.width} × ${o.height}` : ""}
                  </span>
                  <span className="text-[#768994] tabular-nums shrink-0 w-20 text-right hidden md:block truncate">
                    {kind === "print" ? o.type : o.duration && `${o.duration}s`}
                  </span>
                  {urgency && <span className={`w-2 h-2 rounded-full shrink-0 ${urgency === "overdue" ? "bg-rose-500" : "bg-amber-500"}`} title={urgency === "overdue" ? "Overdue" : "Due this week"} />}
                  {tasks[i] && <span className={`${pillClass} bg-sky-100 text-sky-600 shrink-0`}>In Wrike</span>}
                  <span className={`${pillClass} ${STATUS_CLASS[o.status]} shrink-0`}>{STATUS_LABEL[o.status]}</span>
                </button>
              );
            })}
          </div>
          <div className="bg-white">
            {/* Stays in view while a long order list scrolls beside it. */}
            <div className="lg:sticky lg:top-4">{order && <OrderPanel order={order} task={tasks[selected]} parent={wrikeParents?.get(tasks[selected]?.id)} today={today} />}</div>
          </div>
        </div>
      )}
    </div>
  );
}
