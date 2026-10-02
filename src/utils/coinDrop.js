// The grid's time steppers, made visible: a plus drops a coin from the cell
// into that column's day total, a minus lifts one back out. Pure decoration —
// the figures are right without it — so it runs on the DOM directly, outside
// React, and does nothing at all for anyone who has asked for less motion.
const centre = (rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

export function coinDrop(cell, total, direction) {
  if (!cell || !total || typeof cell.animate !== "function") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

  const up = direction < 0;
  const from = centre((up ? total : cell).getBoundingClientRect());
  const to = centre((up ? cell : total).getBoundingClientRect());

  const coin = document.createElement("span");
  coin.setAttribute("aria-hidden", "true");
  coin.style.cssText =
    "position:fixed;left:0;top:0;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:9999px;" +
    "background:radial-gradient(circle at 35% 30%,#fde68a,#f59e0b 65%,#d97706);" +
    "box-shadow:inset 0 0 0 1.5px #b45309,0 1px 3px rgba(18,32,39,.25);" +
    "pointer-events:none;z-index:999999;will-change:transform,opacity";
  document.body.appendChild(coin);

  const at = (p, extra = "") => `translate(${p.x}px, ${p.y}px) ${extra}`;
  // Falling accelerates, like something dropped; lifting out slows as it
  // arrives. The coin turns edge-on halfway so it reads as a coin, not a dot.
  const flight = coin.animate(
    [
      { transform: at(from, "scale(0.6) rotateY(0deg)"), opacity: 0 },
      { opacity: 1, offset: 0.15 },
      { transform: at(to, "scale(1) rotateY(360deg)"), opacity: 1, offset: 0.9 },
      { transform: at(to, "scale(0.4) rotateY(360deg)"), opacity: 0 },
    ],
    { duration: 480, easing: up ? "cubic-bezier(0.16, 1, 0.3, 1)" : "cubic-bezier(0.5, 0, 0.9, 0.6)" }
  );
  const done = () => coin.remove();
  flight.onfinish = () => {
    done();
    // The total takes the hit: a small squash when a coin lands in it.
    if (!up) {
      total.animate(
        [{ transform: "scale(1)" }, { transform: "scale(1.18, 0.9)" }, { transform: "scale(1)" }],
        { duration: 220, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" }
      );
    }
  };
  flight.oncancel = done;
}
