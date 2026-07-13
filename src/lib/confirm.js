// Global confirm dialog API — a styled, promise-based replacement for the
// browser's window.confirm(), which freezes the tab and renders OS-chrome
// that clashes with the app. Usage:
//
//   const ok = await confirmAction({
//     title: "Delete this job?",
//     message: "This can't be undone.",
//     confirmLabel: "Delete",
//     danger: true,
//   });
//   if (!ok) return;
//
// <ConfirmHost/> (mounted once in App) renders the dialog. If it isn't
// mounted for any reason, fall back to native confirm so callers never hang.
let listener = null;

export function confirmAction({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false } = {}) {
  return new Promise((resolve) => {
    if (!listener) {
      resolve(window.confirm(message || title));
      return;
    }
    listener({ title, message, confirmLabel, cancelLabel, danger, resolve });
  });
}

export function subscribeConfirm(fn) {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}
