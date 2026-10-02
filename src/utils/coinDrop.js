// The grid's time steppers, made visible: a plus tosses a handful of coins out
// of the cell, and they tumble into that column's day total; a minus spills a
// few back out of the total and up to the cell. Pure decoration — the figures
// are right without it — so it runs on the DOM directly, outside React, and
// does nothing at all for anyone who has asked for less motion.

const COINS_PER_STEP = 5;
const MAX_IN_FLIGHT = 40; // hammering a stepper shouldn't fill the screen
const FRAMES = 18;
let inFlight = 0;

const centre = (rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
const between = (min, max) => min + Math.random() * (max - min);

const COIN_CSS =
  "position:fixed;left:0;top:0;border-radius:9999px;pointer-events:none;z-index:999999;" +
  "background:radial-gradient(circle at 34% 30%,#fff3bf 0 14%,#fcd34d 30%,#f59e0b 68%,#b45309);" +
  "box-shadow:inset 0 0 0 1.5px #b45309,inset 0 0 0 3px rgba(253,230,138,.55),0 2px 4px rgba(18,32,39,.28);" +
  "will-change:transform,opacity";

function make(css) {
  const el = document.createElement("span");
  el.setAttribute("aria-hidden", "true");
  el.style.cssText = css;
  document.body.appendChild(el);
  return el;
}

// One coin's path, sampled: thrown, then pulled down. A drop is tossed up and
// sideways out of the cell and accelerates into the total; a lift bursts out
// of the total and slows as it reaches the cell. Each coin flips on its own
// axis all the way (scaleX through zero is the edge-on moment).
function flightFrames(from, to, up) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const toss = between(26, 64); // how far it rises before gravity wins
  const drift = between(-46, 46); // sideways bulge, gone by the landing
  const flips = between(2, 3.5);
  const tilt = between(-50, 50);
  const frames = [];
  for (let i = 0; i <= FRAMES; i++) {
    const t = i / FRAMES;
    const x = from.x + dx * t + drift * Math.sin(Math.PI * t);
    const y = up
      ? from.y + dy * (1 - (1 - t) * (1 - t)) - toss * 0.4 * Math.sin(Math.PI * t)
      : from.y - toss * t + (dy + toss) * t * t;
    const flip = Math.cos(flips * 2 * Math.PI * t);
    const grow = 0.55 + 0.45 * Math.min(1, t * 5); // pops out of the button
    frames.push({
      transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${(tilt * t).toFixed(1)}deg) scale(${(grow * flip).toFixed(3)}, ${grow.toFixed(3)})`,
      opacity: t < 0.06 ? 0 : 1,
    });
  }
  return frames;
}

// Where a coin lands: a gold ring opens and fades, and the figure takes the hit.
function land(el, strong) {
  const { x, y } = centre(el.getBoundingClientRect());
  const ring = make(
    "position:fixed;left:0;top:0;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:9999px;" +
      "border:2px solid #f59e0b;pointer-events:none;z-index:999998"
  );
  ring.animate(
    [
      { transform: `translate(${x}px, ${y}px) scale(0.4)`, opacity: 0.9 },
      { transform: `translate(${x}px, ${y}px) scale(${strong ? 3.2 : 2.2})`, opacity: 0 },
    ],
    { duration: 380, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
  ).onfinish = () => ring.remove();
  el.animate(
    [
      { transform: "translateY(0) scale(1)", color: "#d97706" },
      { transform: "translateY(2px) scale(1.14, 0.88)", color: "#d97706" },
      { transform: "translateY(-1px) scale(0.97, 1.05)" },
      { transform: "translateY(0) scale(1)" },
    ],
    { duration: 260, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" }
  );
}

// "+0:15" lifting off the cell, so the step itself is legible, not just the coins.
function label(cell, text, up) {
  const { x, y } = centre(cell.getBoundingClientRect());
  const el = make(
    "position:fixed;left:0;top:0;pointer-events:none;z-index:999999;white-space:nowrap;" +
      "font:800 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;" +
      `color:${up ? "#768994" : "#b45309"};text-shadow:0 1px 0 #fff`
  );
  el.textContent = text;
  el.animate(
    [
      { transform: `translate(${x}px, ${y - 14}px) translate(-50%, -50%) scale(0.7)`, opacity: 0 },
      { transform: `translate(${x}px, ${y - 24}px) translate(-50%, -50%) scale(1)`, opacity: 1, offset: 0.25 },
      { transform: `translate(${x}px, ${y - 40}px) translate(-50%, -50%) scale(1)`, opacity: 0 },
    ],
    { duration: 700, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
  ).onfinish = () => el.remove();
}

export function coinDrop(cell, total, direction, stepLabel = "0:15") {
  if (!cell || !total || typeof cell.animate !== "function") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

  const up = direction < 0;
  const cellRect = cell.getBoundingClientRect();
  const cellAt = centre(cellRect);
  // Out of (and back into) the button that was pressed: plus on the right,
  // minus on the left.
  cellAt.x = up ? cellRect.left + 12 : cellRect.right - 12;
  const totalAt = centre(total.getBoundingClientRect());
  const from = up ? totalAt : cellAt;
  const to = up ? cellAt : totalAt;

  label(cell, `${up ? "−" : "+"}${stepLabel}`, up);
  if (up) land(total, false); // the total gives them up first

  for (let i = 0; i < COINS_PER_STEP && inFlight < MAX_IN_FLIGHT; i++) {
    const size = between(9, 13);
    const coin = make(`${COIN_CSS};width:${size}px;height:${size}px;margin:${-size / 2}px 0 0 ${-size / 2}px`);
    inFlight++;
    const last = i === COINS_PER_STEP - 1;
    const flight = coin.animate(flightFrames(from, to, up), {
      duration: between(520, 760),
      delay: i * between(35, 70),
      easing: "linear", // the curve is in the frames
      fill: "backwards",
    });
    const done = () => {
      coin.remove();
      inFlight--;
    };
    flight.onfinish = () => {
      done();
      if (!up) land(total, last);
    };
    flight.oncancel = done;
  }
}
