// ── Dark mode ────────────────────────────────────────────────────────────────
// One place that owns the dark-theme class, so every entry point (Settings,
// the App command palette, the Canvas palette) agrees on what "dark" means.
//
// The class belongs on <html>, not <body>: Timesheeter.css's base rule is
// `html.dark-theme, html.dark-theme body { … }`, which sets the page's own
// background/foreground. The old floating ThemeToggle put the class on
// <body>, so that base rule never matched and only the descendant overrides
// (`.dark-theme .bg-white`, …) took effect — a half-applied dark mode that
// disagreed with the palette's own toggle. Both now route through here.

const KEY = "xyi_dark_mode";

export function isDarkMode() {
  return document.documentElement.classList.contains("dark-theme");
}

export function setDarkMode(on) {
  document.documentElement.classList.toggle("dark-theme", on);
  localStorage.setItem(KEY, on ? "1" : "0");
  return on;
}

export function toggleDarkMode() {
  return setDarkMode(!isDarkMode());
}

// Called from the entry point before first render, so a saved preference is
// already on <html> by the time anything paints (no light-then-dark flash).
export function initDarkMode() {
  if (localStorage.getItem(KEY) === "1") {
    document.documentElement.classList.add("dark-theme");
  }
}
