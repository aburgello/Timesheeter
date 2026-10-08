// Lists more than one Administration screen relies on: studios,
// job statuses.
//
// Part of Administration. Split out of components/Management.jsx, which is
// still the entry point and re-exports what other screens import.

// ── Studios a film can belong to ──────────────────────────────────────────────
// The canonical order the Job Setup picker groups by and the Films page's
// studio editor offers. Matches STUDIO_GROUPS, plus Lionsgate (wrikeCampaign
// scans it). The film-sync modal only offers Paramount/Universal today, but
// films already in the Job Book can carry any of these via the backfill.
export const STUDIO_LIST = [
  "Paramount", "Universal", "Sony", "Disney", "Warner",
  "Netflix", "Apple", "Amazon", "Lionsgate", "XYi",
];
// ── Job Setup film picker group order ─────────────────────────────────────────
// Films sort under their studio; within each group the film with the most
// recently touched job (MAX(jobs.updated_at)) sits on top, tiebroken by title.
// Films with no studio yet (typed in freeform, or awaiting a re-sync) land in
// Other.
export const FILM_GROUP_ORDER = [...STUDIO_LIST, "Other"];
export const JOB_STATUSES = ["Inactive", "Active", "Closed"];
export const STUDIO_OPTIONS = ["Paramount", "Universal"];
