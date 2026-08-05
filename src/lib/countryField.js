// Which custom field on a Wrike task is the one that names a market.
//
// This exists because of the 5 Aug 2026 Norway incident. resolveCountries'
// last rule reads the Country custom field, but a task's payload carries only
// { id, value } pairs — no titles — so the reader had to guess which field it
// was holding by whether the VALUE looked country-shaped. It doesn't work, and
// the cache says exactly how badly:
//
//   IEAFZXYZJUAFTINW   972 tasks   161 distinct values   AE, Albania, ARG, BEL-FL…
//   IEAFZXYZJUAE7555   696 tasks     1 distinct value    "No"
//
// The second is a boolean field that has never held anything but "No" — and
// "NO" is Norway's code, so 696 tasks carried a loaded gun for any row that
// reached the fallback. No amount of value-sniffing separates that from a real
// Country field reading "NO", because they are the same four bytes.
//
// The fix is to stop sniffing and ask. /customfields returns the workspace's
// field DEFINITIONS — id and title — which the per-task payload omits. Match
// the title once, keep the id, and from then on the reader looks at one field
// and is blind to every other. A field's identity doesn't change with its
// contents, so "which field is this" stops being a question about data.
//
// Same pattern as discoverJobNumberField / discoverItemPriceField in
// wrikeCampaign.js, and for the same reason: nothing is hardcoded, so it keeps
// working if the field is recreated or the workspace is cloned. Where it
// differs is the failure mode — those two throw the lookup away and leave a
// value empty, while this one falls back to the old shape-based reader (with
// its ambiguous-word guard), so a member who can't reach /customfields is no
// worse off than before discovery existed.

const LS_KEY = "xyi.countryFieldIds";

// Sync-readable, because the readers are sync: guessFieldsFromTask runs inside
// render, in two different components. Seeded from localStorage so the very
// first render after a reload is already pinned rather than spending a page
// load on the fallback reader.
let cached = null; // { ids: string[], titles: string[] } | null
let inflight = null;

try {
  const raw = localStorage.getItem(LS_KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.ids) && parsed.ids.length) cached = parsed;
  }
} catch {
  /* private mode / corrupt entry — discovery below refills it */
}

/**
 * The discovered field ids, most authoritative first. Empty until discovery
 * has run at least once on this device, which callers must read as "not
 * pinned" (use the fallback reader), never as "no country".
 */
export const countryFieldIds = () => cached?.ids || [];

/** The titles behind those ids — for logging and the admin diagnostics only. */
export const countryFieldTitles = () => cached?.titles || [];

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Pick the market-bearing fields out of a /customfields listing.
 *
 * Ordered, because both can be present and they don't carry the same weight:
 * "Country" is the field the localisation templates fill, "Market" is the
 * looser one people use when a row covers a region. The reader tries them in
 * this order and takes the first that yields anything.
 *
 * Matching is EXACT on title (after stripping case and punctuation), with one
 * loose pass for a plural/reworded "Countries". Deliberately not `includes`,
 * which is what the job-number discoverer can afford but this can't: the
 * account also has "Market Deadline", and a contains-match would pin the
 * reader to a date field that can never resolve to a country — silently
 * turning rule 4 off for everyone.
 */
export function pickCountryFields(fields) {
  const out = [];
  const take = (f) => {
    if (f && !out.some((o) => o.id === f.id)) out.push(f);
  };
  take(fields.find((f) => norm(f.title) === "country"));
  take(fields.find((f) => norm(f.title) === "countries"));
  take(fields.find((f) => norm(f.title) === "market"));
  if (!out.length) take(fields.find((f) => /^countr/.test(norm(f.title))));
  return out;
}

/**
 * Discover and cache the field ids. Memoised per session and persisted, so the
 * cost is one /customfields call per device per sync — call it freely.
 *
 * Never throws: the field list is permissioned in Wrike (see
 * discoverItemPriceField), and a member who can't read it must still get rows,
 * just resolved by the fallback reader.
 */
export async function warmCountryFields({ force = false } = {}) {
  if (cached && !force) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const res = await fetch("/api/wrike/customfields");
      if (!res.ok) return cached;
      const fields = (await res.json())?.data || [];
      const picked = pickCountryFields(fields);
      if (!picked.length) return cached;

      cached = {
        ids: picked.map((f) => f.id),
        titles: picked.map((f) => f.title),
      };
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(cached));
      } catch {
        /* storage full or blocked — the in-memory copy still serves */
      }
      return cached;
    } catch {
      return cached; // offline / proxy down → keep whatever we had
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}
