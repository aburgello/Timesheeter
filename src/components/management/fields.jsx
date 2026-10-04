// Form controls shared across Administration: field labels, the
// grouped combo box, the strict select, pill pickers and the feed filters.
//
// Part of Administration. Split out of components/Management.jsx, which is
// still the entry point and re-exports what other screens import.
import { useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { Search, ChevronRight } from "lucide-react";
import { layoutRect, layoutViewport } from "../../utils/zoom";

// ── Modal field sub-components — defined at module level so React never
//    remounts them mid-keystroke (defining inside a component = new type each render).
export const MODAL_INPUT = "w-full border border-[#dce4ec] rounded-2xl px-4 py-2.5 text-sm text-[#122027] outline-none focus:border-[#12a0e1] focus:ring-2 focus:ring-[#12a0e1]/15 bg-white placeholder-[#b0bec5] transition-[border-color,box-shadow] ease-[cubic-bezier(0.16,1,0.3,1)]";
export function FieldLabel({ text, required }) {
  return (
    <p className="text-[10px] font-black uppercase tracking-widest text-[#768994] mb-1.5">
      {text}{required && <span className="text-rose-400 ml-0.5">*</span>}
    </p>
  );
}
// Searchable combobox. Free text is allowed (type a new value); selection uses
// onMouseDown so it commits before the input's onBlur closes the list.
//   groupBy      — bucket the dropdown under sticky headers
//   formatOption — shorten each row's label (e.g. drop the prefix it sits under)
//   groupOrder   — priority order for groups (Digital/Print before the rest);
//                  also drives the quick-filter chip bar at the top of the list,
//                  so the common buckets are one tap away without loud chips
//                  cluttering the form body.
export function ComboField({ label, value, onChange, options, placeholder, required, groupBy = null, formatOption = null, groupOrder = null, pinRankFn = null }) {
  const [q, setQ] = useState(value);
  const [open, setOpen] = useState(false);
  const [activeGroup, setActiveGroup] = useState(null);

  // Sync display value when parent sets it externally (e.g. opening edit modal)
  useEffect(() => { setQ(value ?? ""); }, [value]);

  const hits = useMemo(() => {
    let list = options;
    if (q) list = list.filter(o => o.toLowerCase().includes(q.toLowerCase()));
    // Filter to the picked group BEFORE capping — otherwise a group that sorts
    // late in the alphabet (UK, XYi) can be entirely cut by the slice and the
    // chip would show nothing even though matches exist.
    if (activeGroup && groupBy) list = list.filter(o => (groupBy(o) || "Other") === activeGroup);
    return list.slice(0, 200);
  }, [options, q, activeGroup, groupBy]);

  const groups = useMemo(() => {
    if (!groupBy) return null;
    const m = new Map();
    for (const o of hits) {
      const g = groupBy(o) || "Other";
      if (!m.has(g)) m.set(g, []);
      m.get(g).push(o);
    }
    let entries = [...m.entries()];
    // Float pinned entries to the top of their group; the rest keep their order.
    if (pinRankFn) entries.forEach(([, items]) => items.sort((a, b) => pinRankFn(a) - pinRankFn(b)));
    if (groupOrder) {
      const rank = (g) => { const i = groupOrder.indexOf(g); return i === -1 ? groupOrder.length + 1 : i; };
      entries.sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
    }
    return entries;
  }, [hits, groupBy, groupOrder, pinRankFn]);

  const disp = (o) => (formatOption ? formatOption(o) : o);
  const isPinned = (o) => !!pinRankFn && pinRankFn(o) < 999;
  const pick = (o) => { onChange(o); setQ(o); setOpen(false); setActiveGroup(null); };
  const rowCls = (o) => {
    const sel = o === value;
    const pinned = isPinned(o);
    return `flex items-center text-left px-3 py-2 text-xs rounded-lg transition-colors ${
      sel ? "bg-[#10b981]/15 text-[#0f766e] font-bold"
        : pinned ? "bg-[#f0fbf7] text-[#0f766e] font-semibold hover:bg-[#e4f7ef]"
          : "text-[#33454f] hover:bg-slate-50"
    }`;
  };

  return (
    <div>
      <FieldLabel text={label} required={required} />
      <div className="relative">
        <input value={q}
          onChange={e => { setQ(e.target.value); onChange(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          placeholder={placeholder || "Search or type…"}
          className={MODAL_INPUT} />
        {open && hits.length > 0 && (
          <div className="absolute z-[100] left-0 right-0 mt-1.5 bg-white border border-[#dce4ec] rounded-2xl shadow-2xl max-h-72 overflow-y-auto">
            {groupOrder && (
              <div className="flex flex-wrap gap-1.5 p-2 border-b border-[#eef2f6] sticky top-0 bg-white z-20">
                {groupOrder.map(g => {
                  const on = activeGroup === g;
                  return (
                    <button key={g} type="button"
                      onMouseDown={e => { e.preventDefault(); setActiveGroup(on ? null : g); }}
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition-colors ${
                        on ? "bg-[#10b981] border-[#10b981] text-white"
                          : "bg-white border-[#dce4ec] text-[#768994] hover:border-[#10b981] hover:text-[#0d9488]"
                      }`}>{g}</button>
                  );
                })}
                {activeGroup && (
                  <button type="button" onMouseDown={e => { e.preventDefault(); setActiveGroup(null); }}
                    className="px-1.5 py-1 text-[10px] font-bold text-slate-400 hover:text-rose-500 transition-colors">Clear</button>
                )}
              </div>
            )}
            <div className="p-1.5">
              {groups ? groups.map(([g, items]) => (
                <div key={g} className="mb-1.5 last:mb-0">
                  <div className="px-2.5 py-1 text-[10px] font-black uppercase tracking-widest text-[#0d9488] bg-[#f4faf8] rounded-lg">{g}</div>
                  <div className="grid grid-cols-2 gap-1 mt-1">
                    {items.map(o => (
                      <button key={o} type="button" onMouseDown={e => { e.preventDefault(); pick(o); }}
                        className={rowCls(o)} title={o}>
                        {isPinned(o) && <span className="w-1.5 h-1.5 rounded-full bg-[#10b981] shrink-0 mr-2" />}
                        <span className="truncate">{disp(o)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )) : (
                <div className="grid grid-cols-2 gap-1">
                  {hits.map(o => (
                    <button key={o} type="button" onMouseDown={e => { e.preventDefault(); pick(o); }}
                      className={rowCls(o)} title={o}>
                      {isPinned(o) && <span className="w-1.5 h-1.5 rounded-full bg-[#10b981] shrink-0 mr-2" />}
                      <span className="truncate">{disp(o)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
// Searchable, selection-only dropdown — same visual language as ComboField's
// popup, but you can't commit free text, only pick an existing option. Use
// for pickers whose values must reference an existing row (e.g. Film Setup's
// film picker), as opposed to ComboField which lets you introduce new values.
// `limit` caps how many rows render at once. The default keeps the original
// behaviour for the pickers that have always used it; callers with genuinely
// long lists (a year and a half of weeks, 65 item categories) raise it so the
// tail isn't reachable only by typing.
// `groupBy` + `groupOrder` are optional and bucketed under uppercase headers
// when present (e.g. the Job Setup film picker groups by studio); without them
// the list stays flat.
export function StrictSelect({ value, onChange, options, placeholder, loading, className = "", limit = 60, groupBy = null, groupOrder = null }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const btnRef = useRef(null);

  // Grouped pickers get a much bigger cap — the 60-row cap that's plenty for a
  // flat picker (search box sits right above) would slice off every film in a
  // late-sorted group like XYi. Grouped lists are themselves organised, so 200
  // stays manageable.
  const cap = groupBy ? 200 : limit;
  const hits = useMemo(() => {
    if (!q) return options.slice(0, cap);
    return options.filter(o => o.toLowerCase().includes(q.toLowerCase())).slice(0, cap);
  }, [options, q, cap]);

  // Optional grouping: bucket hits under uppercase headers (e.g. studio),
  // ordered by groupOrder with any group not listed sorting after in alpha
  // order. The renderer draws each group as a card (see the render block
  // below). When groupBy is absent the picker stays a flat list.
  const groups = useMemo(() => {
    if (!groupBy) return null;
    const m = new Map();
    for (const o of hits) {
      const g = groupBy(o) || "Other";
      if (!m.has(g)) m.set(g, []);
      m.get(g).push(o);
    }
    const entries = [...m.entries()];
    if (groupOrder) {
      const rank = (g) => { const i = groupOrder.indexOf(g); return i === -1 ? groupOrder.length + 1 : i; };
      entries.sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
    }
    return entries;
  }, [hits, groupBy, groupOrder]);

  // layoutRect, not getBoundingClientRect: the panel below is position:fixed
  // and styled from this rect, so under a non-1 html{zoom} a raw (visual) rect
  // would be zoomed a second time on paint and land offset from the button.
  // The app's own zoom: 1.1 has since been removed, so this is currently a
  // pass-through, kept correct in case a zoom returns.
  // The viewport height rides along so the panel can decide which way to open.
  const measure = () => {
    const r = layoutRect(btnRef.current);
    if (!r) return null;
    const { vh } = layoutViewport();
    return { top: r.top, bottom: r.bottom, left: r.left, width: r.width, vh };
  };

  const toggle = () => {
    if (!open) setRect(measure());
    setOpen(o => !o);
  };

  // The panel is portaled to <body> and positioned from the button's own
  // rect, rather than CSS-nested `absolute` inside whatever card/accordion
  // it happens to sit in — nesting meant it inherited that ancestor's
  // clipping and paint order, so once a card was tall enough (or another
  // card sat right below it) the open panel could render clipped or
  // behind the next sibling instead of on top of everything, regardless
  // of its own z-index. Keep the rect in sync while open so scrolling the
  // page doesn't leave it stranded over the wrong spot.
  useEffect(() => {
    if (!open) return;
    const reposition = () => setRect(measure());
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Open upwards when there isn't room below — the film picker sits low in the
  // Bulk Campaign panel, where a downward list ran off the bottom of the page
  // and its options couldn't be reached at all. Anchored by `bottom` when
  // flipped, so it needs no height measurement to sit right above the button.
  // Either way the list is capped to the space actually available, so it can
  // never overflow the viewport, and gets as tall as that space allows rather
  // than a fixed ~5 rows.
  const GAP = 6, EDGE = 12, CHROME = 56; // CHROME ≈ the search box above the list
  const spaceBelow = rect ? rect.vh - rect.bottom - GAP - EDGE : 0;
  const spaceAbove = rect ? rect.top - GAP - EDGE : 0;
  const dropUp = !!rect && spaceBelow < 220 && spaceAbove > spaceBelow;
  const listMax = Math.max(140, Math.round((dropUp ? spaceAbove : spaceBelow) - CHROME));

  const renderRow = (o) => (
    <button key={o} type="button"
      onClick={() => { onChange(o); setQ(""); setOpen(false); }}
      className={`w-full text-left px-4 py-2.5 text-sm border-b border-[#dce4ec]/60 last:border-0 transition-colors ${
        o === value ? "bg-[#12a0e1]/10 text-[#12a0e1] font-bold" : "text-[#122027] hover:bg-slate-50"
      }`}>
      {o}
    </button>
  );

  // Compact, borderless row for inside a studio card — the card is the visual
  // unit here, so rows lose their dividers and just sit on hover like a chip.
  const renderCardRow = (o) => (
    <button key={o} type="button"
      onClick={() => { onChange(o); setQ(""); setOpen(false); }}
      className={`w-full text-left px-2.5 py-1.5 text-[13px] leading-snug rounded-lg transition-colors ${
        o === value ? "bg-[#12a0e1]/10 text-[#12a0e1] font-bold" : "text-[#122027] hover:bg-slate-50"
      }`}>
      {o}
    </button>
  );

  return (
    <div className={className}>
      <button ref={btnRef} type="button" disabled={loading}
        onClick={toggle}
        className="w-full flex items-center justify-between gap-2 border border-[#dce4ec] rounded-xl px-3 py-2.5 text-sm font-bold text-[#122027] outline-none focus:border-[#12a0e1] bg-white disabled:opacity-50 transition-colors hover:border-[#12a0e1]">
        <span className={`min-w-0 truncate ${value ? "" : "text-[#b0bec5] font-medium"}`}>
          {loading ? "Loading…" : (value || placeholder || "Select…")}
        </span>
        <ChevronRight className={`w-3.5 h-3.5 text-[#768994] shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && rect && createPortal(
        <>
          <div className="fixed inset-0 z-[9998]" onClick={() => setOpen(false)} />
          <div
            className="fixed z-[9999] bg-white border border-[#dce4ec] rounded-2xl shadow-2xl overflow-hidden"
            style={dropUp
              ? { bottom: rect.vh - rect.top + GAP, left: rect.left, width: rect.width }
              : { top: rect.bottom + GAP, left: rect.left, width: rect.width }}
          >
            <div className="p-2 border-b border-[#dce4ec]/60">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#b0bec5]" />
                <input autoFocus value={q} onChange={e => setQ(e.target.value)}
                  placeholder="Search…"
                  className="w-full pl-8 pr-2 py-1.5 text-sm text-[#122027] outline-none bg-slate-50 rounded-xl" />
              </div>
            </div>
            <div className="overflow-y-auto" style={{ maxHeight: listMax }}>
              {hits.length === 0 && <p className="px-4 py-3 text-sm text-[#768994]">No matches</p>}
              {groups ? (
                // Studio groups render as a 2-column grid of cards — each card
                // carries its studio's name in blue over the list of films, the
                // same card idiom as the Studio Analytics tiles. Two groups sit
                // side by side (Universal next to Paramount), and within a card
                // films keep the picker's activity sort (newest on top).
                <div className="grid grid-cols-2 gap-2 p-2">
                  {groups.map(([g, items]) => (
                    <div key={g} className="bg-white border border-[#dce4ec] rounded-2xl shadow-sm overflow-hidden">
                      <div className="px-3 py-2 text-[10px] font-black uppercase tracking-widest text-[#12a0e1] border-b border-[#eef2f6] bg-slate-50/60">{g}</div>
                      <div className="py-1">
                        {items.map(renderCardRow)}
                      </div>
                    </div>
                  ))}
                </div>
              ) : hits.map(renderRow)}
            </div>
          </div>
        </>,
        document.body
      )}
    </div>
  );
}
export function PillField({ label, value, onChange, options, colorMap }) {
  return (
    <div>
      <FieldLabel text={label} />
      <div className="flex flex-wrap gap-1.5">
        {options.map(o => {
          const active = value === o;
          const activeColor = colorMap?.[o] || "bg-[#122027] border-[#122027]";
          return (
            <button key={o} type="button" onClick={() => onChange(o)}
              className={`px-3.5 py-2 rounded-xl text-xs font-bold border transition-[background-color,border-color,color,box-shadow] ease-[cubic-bezier(0.16,1,0.3,1)] ${
                active
                  ? `${activeColor} text-white shadow-sm`
                  : "bg-white text-[#768994] border-[#dce4ec] hover:border-slate-300 hover:text-[#122027]"
              }`}>
              {o}
            </button>
          );
        })}
      </div>
    </div>
  );
}
// Filter-bar dropdown. Wraps StrictSelect — the app's one dropdown — so these
// read and behave like every other picker (searchable, portaled so it opens
// over the table rather than being clipped by it, correct under the app-wide
// zoom). StrictSelect speaks plain strings, so this adapts the {value,label}
// pairs the filters hold: the label round-trips back to its value on pick.
// `allLabel` is the clear-to-everything row; pass null where there's no "all"
// state (Fixed Cost, the unbilled toggle).
export function FeedSelect({ value, onChange, options, allLabel = "All", className = "w-[170px]" }) {
  const labels = useMemo(
    () => (allLabel !== null ? [allLabel, ...options.map(o => o.label)] : options.map(o => o.label)),
    [options, allLabel]
  );
  // Empty value = the "all" row. An unknown value (a filter whose option list
  // hasn't loaded yet) shows the placeholder rather than a stale label.
  const current = !value
    ? (allLabel ?? "")
    : (options.find(o => o.value === value)?.label ?? "");

  return (
    <StrictSelect
      className={className}
      value={current}
      options={labels}
      placeholder={allLabel ?? "Select…"}
      limit={200}
      onChange={(label) => {
        if (allLabel !== null && label === allLabel) return onChange("");
        onChange(options.find(o => o.label === label)?.value ?? "");
      }}
    />
  );
}
