import * as Sentry from "@sentry/react";

// ── Error reporting ──────────────────────────────────────────────────────────
// Opt-in: without VITE_SENTRY_DSN set this is a no-op, so local dev and any
// build without the env var behave exactly as before rather than failing or
// silently buffering events.
//
// Session Replay and performance tracing are deliberately OFF. Both are the
// reason Sentry has a reputation for being chatty — replay in particular
// streams DOM mutations continuously, which is precisely the kind of
// background traffic that put this project over its egress quota in the first
// place. Plain exception reports are a few kB each and only fire when
// something actually breaks; that's the whole point here.

const DSN = import.meta.env.VITE_SENTRY_DSN;

export function initMonitoring() {
  if (!DSN) return;
  Sentry.init({
    dsn: DSN,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    // The app talks to Wrike through its own Worker, so a 401 from a
    // not-yet-connected user is expected noise, not a defect.
    ignoreErrors: ["not_connected", "AbortError", "ResizeObserver loop"],
  });
}

// Report an error we've already handled (so it doesn't reach a boundary) but
// still want to know about. No-ops when Sentry isn't configured.
export function reportError(error, context) {
  if (!DSN) return;
  Sentry.captureException(error, context ? { extra: context } : undefined);
}
