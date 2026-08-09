import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://oozopadfrupwujsagagn.supabase.co";
const supabaseAnonKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9vem9wYWRmcnVwd3Vqc2FnYWduIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyNDg1NjQsImV4cCI6MjA5NzgyNDU2NH0.w0Jny1rCazR4i89zqcarTp9R1VQNkfyyr5gvD5l-6s0";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Ensure an anonymous session exists on load.
// This is a no-op if a session already lives in localStorage.
//
// Exported as a promise: on a first-ever visit there is no session in
// localStorage, so this sign-in is still in flight while the rest of the app
// boots. Anything that needs an authenticated session (i.e. anything touching
// Supabase) must await it, or it will run as `anon` and be rejected by RLS.
export const sessionReady = (async () => {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (session) return session;
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) {
    console.error("Anonymous sign-in failed:", error.message);
    return null;
  }
  return data.session;
})();

// Resolves once the Wrike user ID is present in the *access token* (not just
// the local user object) — see setWrikeUserId below. Reads and writes to
// RLS-protected tables must await this on a first login.
let identityReady = sessionReady;

/** Await before any Supabase read/write that RLS scopes by wrike_user_id. */
export function whenIdentityReady() {
  return identityReady;
}

/**
 * Read EVERY row of a table, not just the first page.
 *
 * Supabase caps a response at 1000 rows and reports no error when it truncates —
 * a plain `.select()` on a table past that size silently returns a slice, and
 * with no ORDER BY it isn't even a predictable slice. That's how newly created
 * jobs went missing from the timesheet's job dropdown while sitting in Job Book
 * the whole time, and how the next-job-number allocator computed a max that was
 * thousands of codes too low.
 *
 * `.order("id")` is load-bearing, not tidiness: `.range()` pagination without an
 * ORDER BY is non-deterministic in Postgres, so pages overlap and skip (see the
 * same fix in useWrikeCache).
 *
 * `tweak` receives the query so callers can add filters:
 *   selectAll("jobs", "*", (q) => q.eq("film_title", film))
 */
export async function selectAll(table, columns = "*", tweak, orderBy = "id") {
  const PAGE = 1000;
  let out = [];
  for (let page = 0; ; page++) {
    let q = supabase
      .from(table)
      .select(columns)
      // `orderBy` because not every table has an `id`. job_sync_kept is keyed
      // on `code`, so the hardcoded .order("id") made every read of it 400 —
      // caught below, logged to a console nobody was watching, and returned as
      // an empty array indistinguishable from "nothing kept". The Keep feature
      // was write-only across reloads for as long as it has existed.
      .order(orderBy)
      .range(page * PAGE, (page + 1) * PAGE - 1);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) {
      // Loud about the cause that actually bites: an ORDER BY on a column the
      // table hasn't got looks exactly like an empty table to every caller.
      console.warn(
        `selectAll(${table}) failed on page ${page}: ${error.message}` +
        (/column .* does not exist/i.test(error.message || "")
          ? ` — pass the right orderBy for ${table}; it has no "${orderBy}" column.`
          : "")
      );
      break;
    }
    if (!data?.length) break;
    out = out.concat(data);
    if (data.length < PAGE) break;
  }
  return out;
}

/**
 * Returns a Set of wrike_timelog_ids already stored for this user.
 * Pass source="legacy" to only check legacy rows (so Legacy pull isn't
 * blocked by timelogs already pulled by Tracker, and vice versa).
 */
export async function fetchExistingTimelogIds(wrikeUserId, source = null) {
  await identityReady;
  // selectAll, not a plain .select(): this asks for every row the user has EVER
  // pulled that carries a timelog id — no date scoping — so it grows for the
  // life of the account. A plain read stops at PostgREST's 1000-row cap and
  // reports no error, and since the query carries no ORDER BY, the 1000 it
  // returned were an arbitrary subset that could differ between calls.
  //
  // This Set is the only thing preventing a duplicate: tasks has no unique
  // index on wrike_timelog_id, so a timelog missing from it is re-inserted
  // silently. At ~20 rows/week for an active member the cap was under a year
  // away.
  const data = await selectAll("tasks", "wrike_timelog_id", (q) => {
    q = q.not("wrike_timelog_id", "is", null);
    if (wrikeUserId) q = q.eq("wrike_user_id", wrikeUserId);
    if (source) q = q.eq("source", source);
    return q;
  });
  return new Set(
    (data ?? []).flatMap((r) =>
      // Legacy aggregates a task's same-day logs into one row as "id1,id2,id3",
      // so a row can carry several ids — the cap was on rows, not ids.
      r.wrike_timelog_id ? r.wrike_timelog_id.split(",") : []
    )
  );
}

/**
 * Call this once the Wrike user ID is known.
 * Stores it in localStorage (fast path for next load), stamps it
 * onto the anonymous session metadata so RLS policies can read it,
 * and upserts the user's profile into the profiles table.
 */
export async function setWrikeUserId(id, profile = {}) {
  if (!id) return;
  localStorage.setItem("wrike_user_id", id);
  identityReady = stampIdentity(id, profile);
  return identityReady;
}

/** Reads the user_metadata claim out of an access token without verifying it. */
function claimFromToken(accessToken) {
  try {
    const payload = accessToken.split(".")[1];
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json)?.user_metadata?.wrike_user_id ?? null;
  } catch (_) {
    return null;
  }
}

async function stampIdentity(id, profile) {
  // The anonymous sign-in may still be in flight on a first-ever visit;
  // updateUser() against a missing session is a silent no-op that leaves the
  // JWT without wrike_user_id, so every later write 403s under RLS.
  await sessionReady;

  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    // The check MUST be against the access token, not getUser(): getUser()
    // returns the server-side user record, which can already carry the right
    // wrike_user_id while the token in hand does not. That is exactly the state
    // any user left in by the earlier bug — updateUser() had written the
    // metadata server-side but never re-minted the token — so comparing against
    // the record would skip the refresh and strand them on a stale token.
    if (session && claimFromToken(session.access_token) !== id) {
      // Cheap and idempotent; only a no-op when the record already matches.
      await supabase.auth.updateUser({ data: { wrike_user_id: id } });
      // updateUser() does NOT mint a new access token (auth-js reassigns
      // session.user and re-saves the same access_token). RLS reads auth.jwt(),
      // so without this refresh the claim stays missing until the token's next
      // hourly rotation and every profiles/tasks write fails with 42501.
      const { error } = await supabase.auth.refreshSession();
      if (error) {
        console.warn("Could not refresh session after stamping identity:", error.message);
      } else {
        const {
          data: { session: fresh },
        } = await supabase.auth.getSession();
        if (fresh && claimFromToken(fresh.access_token) !== id) {
          console.error(
            "wrike_user_id still missing from the access token after refresh — " +
              "RLS-scoped writes will fail."
          );
        }
      }
    }
  } catch (err) {
    console.warn("Could not update Supabase user metadata:", err.message);
  }
  try {
    // Only include fields that actually have values — never overwrite existing
    // data with nulls if profile info wasn't available at call time.
    const update = { wrike_user_id: id, updated_at: new Date().toISOString() };

    // Names are SEEDED from Wrike, not synced from it. Wrike is where people
    // put "Trott ⚡️" or drop their surname, and this ran on every single
    // login — so any name tidied up here was silently reverted the next time
    // that person signed in, however many times it was corrected.
    //
    // So: fill the name only when we don't already hold one. A brand-new
    // profile still gets a sensible name straight from Wrike, and a curated
    // one is never touched again. Email and avatar keep syncing, since nobody
    // curates those and a stale avatar is just wrong.
    let holdsName = false;
    try {
      const { data: existing } = await supabase
        .from("profiles")
        .select("first_name, last_name")
        .eq("wrike_user_id", id)
        .maybeSingle();
      holdsName = !!(existing && (existing.first_name || existing.last_name));
    } catch {
      // Couldn't read it — assume a name exists rather than risk clobbering
      // one. A missing name is a cosmetic gap; an overwritten one is data loss.
      holdsName = true;
    }

    if (!holdsName) {
      if (profile.firstName) update.first_name = profile.firstName;
      if (profile.lastName) update.last_name = profile.lastName;
    }
    if (profile.email) update.email = profile.email;
    if (profile.avatarUrl) update.avatar_url = profile.avatarUrl;
    // Note: supabase-js resolves (never throws) on a DB error, so the error has
    // to be read off the result — the catch below only covers network faults.
    const { error } = await supabase
      .from("profiles")
      .upsert(update, { onConflict: "wrike_user_id" });
    if (error) console.error("Could not upsert profile:", error.message);
  } catch (err) {
    console.warn("Could not upsert profile:", err.message);
  }
}
