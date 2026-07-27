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
 * Returns a Set of wrike_timelog_ids already stored for this user.
 * Pass source="legacy" to only check legacy rows (so Legacy pull isn't
 * blocked by timelogs already pulled by Tracker, and vice versa).
 */
export async function fetchExistingTimelogIds(wrikeUserId, source = null) {
  await identityReady;
  let query = supabase
    .from("tasks")
    .select("wrike_timelog_id")
    .not("wrike_timelog_id", "is", null);
  if (wrikeUserId) query = query.eq("wrike_user_id", wrikeUserId);
  if (source) query = query.eq("source", source);
  const { data } = await query;
  return new Set(
    (data ?? []).flatMap((r) =>
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

async function stampIdentity(id, profile) {
  // The anonymous sign-in may still be in flight on a first-ever visit;
  // updateUser() against a missing session is a silent no-op that leaves the
  // JWT without wrike_user_id, so every later write 403s under RLS.
  await sessionReady;

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user && user.user_metadata?.wrike_user_id !== id) {
      await supabase.auth.updateUser({ data: { wrike_user_id: id } });
      // updateUser() writes the new metadata to the user record and updates the
      // cached user object, but it does NOT mint a new access token — the JWT
      // still carries the old (empty) user_metadata. RLS reads auth.jwt(), so
      // without this refresh the token stays stale until its next hourly
      // rotation and all profiles/tasks writes fail with 42501 until then.
      const { error } = await supabase.auth.refreshSession();
      if (error) {
        console.warn("Could not refresh session after stamping identity:", error.message);
      }
    }
  } catch (err) {
    console.warn("Could not update Supabase user metadata:", err.message);
  }
  try {
    // Only include fields that actually have values — never overwrite existing
    // data with nulls if profile info wasn't available at call time.
    const update = { wrike_user_id: id, updated_at: new Date().toISOString() };
    if (profile.firstName) update.first_name = profile.firstName;
    if (profile.lastName) update.last_name = profile.lastName;
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
