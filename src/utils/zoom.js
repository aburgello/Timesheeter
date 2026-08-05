// The app runs at `html { zoom: 1.1 }` everywhere except Home (see
// src/tailwind.css, and the `home-page` opt-out in App.jsx). CSS `zoom` quietly
// splits the page into two coordinate spaces:
//
//   • getBoundingClientRect() / clientX / clientY report VISUAL pixels —
//     already multiplied by the zoom factor.
//   • Any inline style length (top/left/width) is a LAYOUT pixel — the browser
//     multiplies it by the zoom on paint.
//   • window.innerWidth/Height are VISUAL pixels, like a rect. This line used
//     to claim they were layout pixels, and every dropdown that clamped itself
//     against them inherited the error: a panel positioned at
//     `left: innerWidth - w` with `width: w` paints 10% too far right and 10%
//     too wide, so it hangs off the right edge by roughly the zoom factor.
//     Measured on a 1200px viewport: right edge at 1320px, over by 120px.
//     Use layoutViewport() below whenever the number will be written to a style.
//
// A dropdown that reads a trigger's rect (visual) and writes it to a
// position:fixed element's style (layout, then re-zoomed) therefore double-
// zooms: it lands offset from its trigger, and the offset grows the further
// from the top-left origin you are. That's the whole class of "dropdown mounts
// in the wrong place" bug under this zoom.
//
// The fix is to divide rect coordinates back into layout space before using
// them alongside window.innerWidth/Height and before assigning to style.
// RichNoteEditor's floating menus solve the same thing by hand; these helpers
// are the shared version so every dropdown agrees.

export function zoomFactor() {
  return parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
}

// The viewport in LAYOUT pixels — the space inline style lengths are written
// in. Pair it with layoutRect() so a clamp compares like with like; comparing a
// layout-space left/width against window.innerWidth overstates the room
// available by the zoom factor.
export function layoutViewport() {
  const z = zoomFactor();
  return { vw: window.innerWidth / z, vh: window.innerHeight / z };
}

// getBoundingClientRect() for `el`, converted from visual to layout pixels —
// the space window.innerWidth/Height live in and the space a fixed element's
// style expects. Drop-in for `el.getBoundingClientRect()` in positioning code.
export function layoutRect(el) {
  const r = el.getBoundingClientRect();
  const z = zoomFactor();
  return {
    left: r.left / z,
    right: r.right / z,
    top: r.top / z,
    bottom: r.bottom / z,
    width: r.width / z,
    height: r.height / z,
  };
}
