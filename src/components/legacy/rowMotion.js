// Movement for the timesheet's rows when the table rearranges itself: turning
// Consolidated on or off, merging rows, locking the day.
//
// Everything here is display only. It reads where rows are on screen and
// animates them, or pictures of them; it never reads a row's data, never calls
// anything that saves, and never delays or gates the code that does. Each
// entry point also swallows its own errors: an animation that fails must leave
// the table exactly as it would have been without it.

import { layoutRect } from "../../utils/zoom";

const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

const still = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// A row's handle: real rows carry data-row-id, group headings data-group-id.
// Prefixed so the two can't collide.
const handleOf = (tr) =>
  tr.dataset.rowId != null ? `row:${tr.dataset.rowId}` : tr.dataset.groupId != null ? `group:${tr.dataset.groupId}` : null;

const rowsIn = (container) => [...container.querySelectorAll("tr[data-row-id], tr[data-group-id]")];

// Where every row is right now: handle → top edge.
export function snapshotRows(container) {
  const tops = new Map();
  if (!container || still()) return tops;
  try {
    for (const tr of rowsIn(container)) tops.set(handleOf(tr), layoutRect(tr).top);
  } catch {
    tops.clear();
  }
  return tops;
}

// Call after the table has re-rendered, with a snapshot taken just before.
// Each row that moved glides from where it was to where it now is; a row that
// wasn't there before (a group heading appearing) fades in. Nothing is left on
// the rows afterwards.
export function glideRows(container, before, { duration = 380 } = {}) {
  if (!container || !before?.size || still()) return;
  try {
    for (const tr of rowsIn(container)) {
      const was = before.get(handleOf(tr));
      if (was == null) {
        tr.animate([{ opacity: 0 }, { opacity: 1 }], { duration: duration * 0.8, easing: EASE });
        continue;
      }
      const moved = was - layoutRect(tr).top;
      if (Math.abs(moved) < 1) continue;
      tr.animate([{ transform: `translateY(${moved}px)` }, { transform: "none" }], { duration, easing: EASE });
    }
  } catch {
    // Left as the plain, instant rearrangement.
  }
}

// Locking or unlocking: the rows dip one after another, top to bottom, like a
// shutter passing over them. Their locked look itself is the table's own
// styling; this only passes over it.
export function sweepRows(container) {
  if (!container || still()) return;
  try {
    [...container.querySelectorAll("tr[data-row-id]")].forEach((tr, i) => {
      tr.animate(
        [{ opacity: 1 }, { opacity: 0.4, offset: 0.4 }, { opacity: 1 }],
        // Past sixteen rows they go together: a sweep that long is a wait.
        { duration: 380, delay: Math.min(i, 16) * 26, easing: "cubic-bezier(0.33, 0, 0.67, 1)" }
      );
    });
  } catch {
    // No sweep.
  }
}

// The padlock giving a small turn as it is pressed.
export function nudge(el) {
  if (!el || still()) return;
  try {
    el.animate(
      [{ transform: "none" }, { transform: "scale(1.3) rotate(-14deg)", offset: 0.35 }, { transform: "none" }],
      { duration: 340, easing: EASE }
    );
  } catch {
    // No nudge.
  }
}

// Pictures of rows that are about to be removed, to be drawn back over the
// place they were once they are gone.
//
// Call it while the rows are still on screen. It only looks: it copies each
// row's markup into a detached table (with the real table's column widths, so
// the copy lays out the same) and notes where it was. The copies are not put
// on the page yet, are inert, and are never read back from.
//
// The returned object has two methods, both for after the rows are gone:
//   convergeOn(rowId)  draw the pictures where the rows were and slide them
//                      into the row with that id as they fade (a merge). If
//                      that row can't be found they fade where they are.
//   leave()            draw them where the rows were, sliding a little to the
//                      left as they fade (a delete).
// Either way the pictures remove themselves.
export function picturesOf(container, rowIds) {
  const nothing = { convergeOn() {}, leave() {} };
  if (!container || still()) return nothing;
  let pictures;
  try {
    const table = container.querySelector("table");
    const colgroup = table?.querySelector("colgroup");
    pictures = rowIds
      .map((id) => container.querySelector(`tr[data-row-id="${CSS.escape(String(id))}"]`))
      .filter(Boolean)
      .map((tr) => {
        const rect = layoutRect(tr);
        const copy = document.createElement("table");
        copy.className = table.className;
        copy.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;min-width:0;margin:0;table-layout:fixed;pointer-events:none;z-index:30;`;
        copy.setAttribute("aria-hidden", "true");
        copy.inert = true;
        if (colgroup) copy.appendChild(colgroup.cloneNode(true));
        const body = document.createElement("tbody");
        const row = tr.cloneNode(true);
        // The copy must not be found by anything that looks rows up by id.
        row.removeAttribute("data-row-id");
        body.appendChild(row);
        copy.appendChild(body);
        return { copy, top: rect.top };
      });
  } catch {
    return nothing;
  }
  if (!pictures.length) return nothing;

  // Put a picture on the page, run one animation on it, and take it off again
  // whatever becomes of that animation.
  const play = (copy, frames, duration) => {
    document.body.appendChild(copy);
    const done = () => copy.remove();
    const anim = copy.animate(frames, { duration, easing: EASE });
    anim.onfinish = done;
    anim.oncancel = done;
    setTimeout(done, duration + 300);
  };

  return {
    leave() {
      try {
        for (const { copy } of pictures) {
          play(copy, [{ transform: "none", opacity: 0.9 }, { transform: "translateX(-10px)", opacity: 0 }], 200);
        }
      } catch {
        for (const { copy } of pictures) copy.remove();
      }
    },
    convergeOn(rowId) {
      try {
        const target = container.querySelector(`tr[data-row-id="${CSS.escape(String(rowId))}"]`);
        const targetTop = target ? layoutRect(target).top : null;
        for (const { copy, top } of pictures) {
          const travel = targetTop == null ? 0 : targetTop - top;
          play(copy, [{ transform: "none", opacity: 0.9 }, { transform: `translateY(${travel}px)`, opacity: 0 }], 320);
        }
      } catch {
        for (const { copy } of pictures) copy.remove();
      }
    },
  };
}
