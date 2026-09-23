import React, { cloneElement, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// The dark hover card: the comment previews on the "What did I work on?"
// timeline, and the labels on icon-only buttons. One look for both.
//
// Pinned next to `rect` (a DOM rect), above it when there's room and below
// otherwise, kept inside the window. Portalled to <body> so no scroll area or
// overflow-hidden parent can clip it.
export default function FloatingCard({ rect, className = "", innerRef, children, ...rest }) {
  const localRef = useRef(null);
  const ref = innerRef || localRef;
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const gap = 10;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left + rect.width / 2 - w / 2));
    const above = rect.top - h - gap;
    const top = above >= 8 ? above : Math.min(window.innerHeight - h - 8, rect.bottom + gap);
    setPos({ left, top });
  }, [rect, ref]);

  return createPortal(
    <div
      ref={ref}
      {...rest}
      className={`fixed z-[100002] rounded-xl border border-white/10 bg-gradient-to-b from-[#1f2738] to-[#171e2c] shadow-2xl shadow-black/50 text-slate-300 ${className}`}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0, visibility: "hidden" }}
    >
      <div className="absolute inset-x-0 top-0 h-px rounded-t-xl bg-gradient-to-r from-transparent via-white/20 to-transparent" />
      {children}
    </div>,
    document.body
  );
}

// Names an icon-only control in the hover card, on hover and on keyboard
// focus. Wraps exactly one element; that element should still carry its own
// aria-label, since this is for sighted users.
export function HoverLabel({ label, children }) {
  const [rect, setRect] = useState(null);
  const show = (e) => setRect(e.currentTarget.getBoundingClientRect());
  const hide = () => setRect(null);
  const chain = (theirs, ours) => (e) => {
    theirs?.(e);
    ours(e);
  };
  return (
    <>
      {cloneElement(children, {
        onMouseEnter: chain(children.props.onMouseEnter, show),
        onMouseLeave: chain(children.props.onMouseLeave, hide),
        onFocus: chain(children.props.onFocus, show),
        onBlur: chain(children.props.onBlur, hide),
        onClick: chain(children.props.onClick, hide),
      })}
      {rect && (
        <FloatingCard rect={rect} className="px-3 py-1.5 pointer-events-none whitespace-nowrap">
          <span className="text-xs font-semibold text-slate-100">{label}</span>
        </FloatingCard>
      )}
    </>
  );
}
