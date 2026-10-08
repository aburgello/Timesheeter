import React, { useRef } from "react";

// Small motion pieces shared across pages. Their keyframes and the one easing
// curve they all use are in tailwind.css under "Micro-interactions". Every one
// of them is switched off there for prefers-reduced-motion.

export const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// A figure that rolls to its new value: up when `amount` rose, down when it
// fell, so the direction of the change is visible and not only the result.
// `amount` is the number behind the text; `children` is how it is written.
// Nothing moves on first render, only on a change.
export function Rolling({ amount, children, className = "" }) {
  const last = useRef({ amount, dir: 0, turn: 0 });
  if (last.current.amount !== amount) {
    last.current = { amount, dir: amount > last.current.amount ? 1 : -1, turn: last.current.turn + 1 };
  }
  const { dir, turn } = last.current;
  return (
    <span className={`inline-flex overflow-hidden align-bottom ${className}`}>
      {/* Keyed by the turn so each change is a fresh element and replays. */}
      <span key={turn} className={dir > 0 ? "roll-up" : dir < 0 ? "roll-down" : ""}>
        {children}
      </span>
    </span>
  );
}

// A tick. With `draw` it strokes itself in, short arm first, the way one is
// written; without, it is simply there. Pass `draw` only for a tick the person
// just made, or every ticked box on the page draws itself on load.
export function Tick({ draw = false, className = "w-3 h-3" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`${draw ? "tick-draw" : ""} ${className}`}
    >
      <path d="M4 12l5 5L20 6" />
    </svg>
  );
}
