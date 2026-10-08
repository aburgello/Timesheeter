// ── Appearance ───────────────────────────────────────────────────────────────
// One place that owns the theme classes, so every caller agrees on what "dark"
// means. The choice is made in Profile › Settings.
//
// Three themes: light, dark, and oled. OLED is the dark theme with a true-black
// page, so it sets `dark-theme` as well as `oled-theme`: everything written for
// dark mode applies, and Timesheeter.css only swaps the surface colours.
//
// The classes belong on <html>, not <body>: Timesheeter.css's base rule is
// `html.dark-theme, html.dark-theme body { … }`, which sets the page's own
// background and foreground.

const KEY = "xyi_theme";
// Before OLED there was one on/off setting. Still read, so nobody's saved dark
// mode is lost.
const OLD_KEY = "xyi_dark_mode";

export const THEMES = ["light", "dark", "oled"];

export function getTheme() {
  const classes = document.documentElement.classList;
  if (classes.contains("oled-theme")) return "oled";
  return classes.contains("dark-theme") ? "dark" : "light";
}

// Dark or OLED. What charts and anything else that only has a light and a dark
// look should ask.
export function isDarkMode() {
  return document.documentElement.classList.contains("dark-theme");
}

function apply(theme) {
  const classes = document.documentElement.classList;
  classes.toggle("dark-theme", theme !== "light");
  classes.toggle("oled-theme", theme === "oled");
}

export function setTheme(theme) {
  const next = THEMES.includes(theme) ? theme : "light";
  apply(next);
  localStorage.setItem(KEY, next);
  // Kept in step for a copy of the app that only knows the old setting, such
  // as a tab that hasn't reloaded since this was deployed.
  localStorage.setItem(OLD_KEY, next === "light" ? "0" : "1");
  return next;
}

function savedTheme() {
  const saved = localStorage.getItem(KEY);
  if (THEMES.includes(saved)) return saved;
  return localStorage.getItem(OLD_KEY) === "1" ? "dark" : "light";
}

// Called from the entry point before first render, so a saved preference is
// already on <html> by the time anything paints (no light-then-dark flash).
export function initDarkMode() {
  apply(savedTheme());
}
